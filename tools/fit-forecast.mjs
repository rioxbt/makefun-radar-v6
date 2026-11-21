#!/usr/bin/env node
// tools/fit-forecast.mjs
//
// Fits the launch-value model and grades it with WALK-FORWARD validation, then writes
// lib/calibration.json, the artifact the entry (main.ts) reads at run time.
//
// THE MODEL (fitted, not chosen by hand)
//
//   log10(implied_value_usd) = core + growth_tilt + tenure_tilt + breadth_tilt
//
//   core            = a0 + a1 * z(log10 TVL)                      a1 fitted free (ridge)
//   growth_tilt     = b1 * z(clipped 7-day TVL change)            b1 fitted, b1 >= 0
//   tenure_tilt     = b2 * z(log10 tenure years)                  b2 fitted, b2 >= 0
//   breadth_tilt    = b3 * z(log10 chains)                        b3 fitted, b3 >= 0
//
//   The tilts are fitted with a NON-NEGATIVITY prior, by multiplicative updates on the residual
//   after the core: a protocol whose TVL grew faster, or that has run longer with no token, or
//   that is spread over more chains, can never be scored lower for it. Whether it is scored
//   higher is the data's call, and the fitted weights (b) are reported.
//
//   Every component is a multiplier of the base, so a score decomposes EXACTLY:
//     implied = 10^a0 * TVL^a1 * 10^growth_tilt * 10^tenure_tilt * 10^breadth_tilt
//
// WALK-FORWARD VALIDATION
//
//   Labelled rows are the snapshot's own protocols that record a token market cap. Folds step
//   forward in `listed_at`: each fold is fitted on strictly earlier protocols and predicts the
//   ones that come after. (l_core, l_tilt) are chosen inside each training window by an inner
//   expanding CV, so no test point ever touches a hyper-parameter or a coefficient.
//
//   Reported: per-fold and mean absolute error in log10 units (and as a multiple in dollars),
//   Spearman rank information coefficient, R^2 against the naive "predict the training mean"
//   baseline, and the empirical coverage of the 90% prediction interval.
//
//   The same procedure is run a second time on tools/fetch-dexscreener.mjs's corpus of real
//   launches from DexScreener's public API -- an independent sample the snapshot never saw --
//   to test the functional family (value rises with depth and activity) out of sample.
//
// Usage:  node tools/fit-forecast.mjs [--snapshot data/snapshot.json] [--dex data/dex-launches.json]
//                                    [--out lib/calibration.json]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

const SNAPSHOT = resolve(arg('snapshot', 'data/snapshot.json'));
const DEX = resolve(arg('dex', 'data/dex-launches.json'));
const OUT = resolve(arg('out', 'lib/calibration.json'));

const Z_90 = 1.6448536269514722; // two-sided 90% normal quantile
const NORMAL_ABS = 1.2533141373155001; // sqrt(pi/2): mean |x| of a unit normal -> its sigma
const LAMBDAS = [0, 0.25, 1, 4, 16, 64];

/* ---------------------------------------------------------------- maths */

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => (a.length < 2 ? 0 : Math.sqrt(a.reduce((t, x) => t + (x - mean(a)) ** 2, 0) / (a.length - 1)));

function ranks(a) {
  const o = a.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]);
  const r = new Array(a.length);
  let i = 0;
  while (i < o.length) {
    let j = i;
    while (j + 1 < o.length && o[j + 1][0] === o[i][0]) j += 1;
    const rr = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) r[o[k][1]] = rr;
    i = j + 1;
  }
  return r;
}

function spearman(xs, ys) {
  if (xs.length < 3) return 0;
  const rx = ranks(xs);
  const ry = ranks(ys);
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < rx.length; i += 1) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
}

function solve(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col += 1) {
    let piv = col;
    for (let r = col + 1; r < n; r += 1) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) continue;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c += 1) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[n] / row[i]));
}

/** Standardise a column block on the training window only. */
function standardise(cols) {
  return cols.map((col) => {
    const mu = mean(col);
    const sc = sd(col) || 1;
    return { mu, sc, z: col.map((v) => (v - mu) / sc) };
  });
}

/**
 * The model's fit: ridge core (free) + non-negative tilts by multiplicative updates,
 * iterated (backfitting). Deterministic: no randomness anywhere.
 */
function fitModel(coreCol, tiltRows, y, lamCore, lamTilt, outerRounds = 6, iters = 500) {
  const tiltCols = (tiltRows[0] ?? []).map((_, j) => tiltRows.map((r) => r[j]));
  const zCore = standardise([coreCol])[0];
  const zTilt = standardise(tiltCols);
  const n = y.length;
  const ybar = mean(y);
  let core = 0;
  let tilts = tiltCols.map(() => 0);

  for (let round = 0; round < outerRounds; round += 1) {
    const residCore = y.map((v, i) => v - ybar - zTilt.reduce((t, c, j) => t + tilts[j] * c.z[i], 0));
    const cov = zCore.z.reduce((t, v, i) => t + v * residCore[i], 0);
    core = cov / (zCore.z.reduce((t, v) => t + v * v, 0) + lamCore);

    let c = tilts.map((v) => (v > 1e-6 ? v : 0.05));
    for (let it = 0; it < iters; it += 1) {
      const r = y.map((v, i) => v - ybar - core * zCore.z[i] - zTilt.reduce((t, col, j) => t + c[j] * col.z[i], 0));
      let moved = 0;
      const next = c.map((cj, j) => {
        const g = zTilt[j].z.reduce((t, v, i) => t + v * r[i], 0);
        const h = zTilt[j].z.reduce((t, v) => t + v * v, 0) * cj + lamTilt * cj;
        const upd = g > 0 && h > 1e-12 ? cj * (g / h) : cj * 0.5;
        const v = Math.max(0, upd);
        moved = Math.max(moved, Math.abs(v - cj));
        return v;
      });
      c = next;
      if (moved < 1e-11) break;
    }
    tilts = c;
  }

  const resid = y.map((v, i) => v - ybar - core * zCore.z[i] - zTilt.reduce((t, col, j) => t + tilts[j] * col.z[i], 0));
  const sigma = Math.sqrt(resid.reduce((t, r) => t + r * r, 0) / Math.max(1, n - tiltCols.length - 2));
  return {
    core,
    tilts,
    intercept: ybar,
    coreMu: zCore.mu,
    coreScale: zCore.sc,
    tiltMu: zTilt.map((c) => c.mu),
    tiltScale: zTilt.map((c) => c.sc),
    sigma,
    residual: resid,
    n,
    lamCore,
    lamTilt,
    predict: (coreValue, tiltValues) =>
      ybar +
      core * ((coreValue - zCore.mu) / zCore.sc) +
      tilts.reduce((t, c, j) => t + c * ((tiltValues[j] - zTilt[j].mu) / zTilt[j].sc), 0),
  };
}

/**
 * Residuals the training window did NOT fit: an expanding CV inside the window, one slice ahead
 * at a time. These are what the dispersion model is fitted on, so a protocol's band is not built
 * from the residuals of the same rows that set the coefficients.
 */
function crossValidatedResiduals(rows, lamCore, lamTilt, minTrain) {
  const out = [];
  const start = Math.max(minTrain, Math.floor(rows.length * 0.5));
  const step = Math.max(3, Math.floor(rows.length * 0.12));
  let slice = 0;
  for (let i = start; i < rows.length; i += step) {
    const tr = rows.slice(0, i);
    const te = rows.slice(i, Math.min(rows.length, i + step));
    if (tr.length < minTrain || te.length === 0) continue;
    const f = fitModel(tr.map((r) => r.core), tr.map((r) => r.tilt), tr.map((r) => r.y), lamCore, lamTilt, 4, 250);
    for (const row of te) out.push({ core: row.core, tilt: row.tilt, resid: row.y - f.predict(row.core, row.tilt), slice });
    slice += 1;
  }
  return out.length >= 8 ? out : rows.map((r) => ({ core: r.core, tilt: r.tilt, resid: 0.9, slice: 0 }));
}

/**
 * Dispersion model: log10|residual| as a ridge fit of the same features, so a protocol's
 * uncertainty band is its own rather than one constant across the board. Fitted on
 * cross-validated residuals, never on the residuals the level fit produced.
 */
function fitDispersion(cvRows, pooledSigma) {
  const rows = cvRows.map((r) => ({ x: [r.core, ...r.tilt], y: Math.log10(Math.max(1e-4, Math.abs(r.resid))) }));
  const p = rows[0].x.length;
  const z = standardise(Array.from({ length: p }, (_, j) => rows.map((r) => r.x[j])));
  const y = rows.map((r) => r.y);
  const ybar = mean(y);
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  const lam = 8; // a firm prior: the band leans on the pooled residual, tilted by the features
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = 0; j < p; j += 1) {
      b[j] += z[j].z[i] * (y[i] - ybar);
      for (let k = 0; k < p; k += 1) A[j][k] += z[j].z[i] * z[k].z[i];
    }
  }
  for (let j = 0; j < p; j += 1) A[j][j] += lam;
  const coef = solve(A, b);
  const raw = (coreValue, tiltValues) => {
    const xs = [coreValue, ...tiltValues];
    let v = ybar + Math.log10(NORMAL_ABS);
    for (let j = 0; j < p; j += 1) v += coef[j] * ((xs[j] - z[j].mu) / z[j].sc);
    return Math.min(1.6, Math.max(0.25, Math.pow(10, v)));
  };
  // Calibrate the band on the held-out residuals of the training window. Two leakage-free pieces:
  //  (1) drift: how far the slice-level mean residual moves from one slice to the next inside the
  //      window -- the regime noise a point forecast into the next window will actually meet;
  //  (2) a factor that puts 90% of the window's own held-out residuals inside their own band.
  const sliceMeans = [];
  const bySlice = new Map();
  for (const r of cvRows) {
    if (!bySlice.has(r.slice)) bySlice.set(r.slice, []);
    bySlice.get(r.slice).push(r.resid);
  }
  for (const [, vals] of bySlice) sliceMeans.push(mean(vals));
  let drift = sliceMeans.length >= 3 ? 0 : 0;
  if (sliceMeans.length >= 3) {
    const diffs = [];
    for (let i = 1; i < sliceMeans.length; i += 1) diffs.push(sliceMeans[i] - sliceMeans[i - 1]);
    drift = sd(diffs);
  }
  const errors = cvRows.map((r) => Math.abs(r.resid));
  const sigmas = cvRows.map((r) => Math.sqrt(raw(r.core, r.tilt) ** 2 + drift ** 2));
  const sorted = errors.map((v, i) => v / Math.max(1e-6, sigmas[i])).sort((a, b) => a - b);
  const q90 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(0.9 * sorted.length))] : Z_90;
  const calibration_factor = Number((q90 / Z_90).toFixed(6));
  return {
    intercept: ybar + Math.log10(NORMAL_ABS),
    coefficients: coef.map((v) => Number(v.toFixed(6))),
    means: z.map((c) => Number(c.mu.toFixed(6))),
    scales: z.map((c) => Number(c.sc.toFixed(6))),
    rows_used: errors.length,
    slices: sliceMeans.length,
    drift_sigma_log10: Number(drift.toFixed(6)),
    pooled_sigma_log10: Number((Number.isFinite(pooledSigma) ? pooledSigma : 0).toFixed(6)),
    calibration_factor,
    coverage_on_held_out: Number((errors.filter((v, i) => v <= Z_90 * sigmas[i] * calibration_factor).length / errors.length).toFixed(4)),
    // A protocol's band is the wider of the pooled walk-forward residual scale and its own
    // dispersion estimate: a per-protocol shape may widen it, never narrow it below the pool.
    sigmaOf: (coreValue, tiltValues) =>
      Math.min(2, Math.max(0.25, pooledSigma || 0, Math.sqrt(raw(coreValue, tiltValues) ** 2 + drift ** 2) * calibration_factor)),
  };
}

/* ---------------------------------------------------------------- walk-forward */

/**
 * Expanding-window walk-forward. `rows` must already be sorted by time. The inner CV picks
 * (lamCore, lamTilt) on the training window alone.
 */
function walkForward(rows, minTrain) {
  const n = rows.length;
  const initial = Math.max(minTrain, Math.floor(n * 0.35));
  const step = Math.max(4, Math.floor(n * 0.08));
  const folds = [];
  const choices = [];

  for (let trainEnd = initial; trainEnd < n; trainEnd += step) {
    const testEnd = Math.min(n, trainEnd + step);
    if (trainEnd >= testEnd) break;
    const train = rows.slice(0, trainEnd);
    const test = rows.slice(trainEnd, testEnd);

    let best = { lamCore: 1, lamTilt: 16, mae: Infinity };
    for (const lamCore of LAMBDAS) {
      for (const lamTilt of LAMBDAS) {
        const innerStart = Math.max(minTrain, Math.floor(train.length * 0.5));
        const innerStep = Math.max(3, Math.floor(train.length * 0.15));
        const errs = [];
        for (let inner = innerStart; inner < train.length; inner += innerStep) {
          const tr = train.slice(0, inner);
          const te = train.slice(inner, Math.min(train.length, inner + innerStep));
          if (tr.length < minTrain || te.length === 0) continue;
          const f = fitModel(tr.map((r) => r.core), tr.map((r) => r.tilt), tr.map((r) => r.y), lamCore, lamTilt, 3, 120);
          for (const row of te) errs.push(Math.abs(f.predict(row.core, row.tilt) - row.y));
        }
        const mae = errs.length ? mean(errs) : Infinity;
        if (mae < best.mae) best = { lamCore, lamTilt, mae };
      }
    }
    choices.push({ lamCore: best.lamCore, lamTilt: best.lamTilt });

    const fit = fitModel(train.map((r) => r.core), train.map((r) => r.tilt), train.map((r) => r.y), best.lamCore, best.lamTilt);
    const disp = fitDispersion(crossValidatedResiduals(train, best.lamCore, best.lamTilt, minTrain), fit.sigma);
    const preds = [];
    const actuals = [];
    const errors = [];
    const coveredConst = [];
    const coveredOwn = [];
    for (const row of test) {
      const pred = fit.predict(row.core, row.tilt);
      preds.push(pred);
      actuals.push(row.y);
      errors.push(Math.abs(pred - row.y));
      coveredConst.push(Math.abs(pred - row.y) <= Z_90 * fit.sigma);
      coveredOwn.push(Math.abs(pred - row.y) <= Z_90 * disp.sigmaOf(row.core, row.tilt));
    }
    const trainMean = mean(train.map((r) => r.y));
    const baselineSse = actuals.reduce((s, a) => s + (a - trainMean) ** 2, 0);
    const sse = errors.reduce((s, e) => s + e * e, 0);
    folds.push({
      train_n: train.length,
      test_n: test.length,
      lam_core: best.lamCore,
      lam_tilt: best.lamTilt,
      train_sigma: Number(fit.sigma.toFixed(4)),
      core_per_decade_tvl: Number((fit.core / fit.coreScale).toFixed(4)),
      tilts: fit.tilts.map((v) => Number(v.toFixed(4))),
      mae_log10: Number(mean(errors).toFixed(4)),
      mae_multiple: Number(Math.pow(10, mean(errors)).toFixed(3)),
      rmse_log10: Number(Math.sqrt(sse / test.length).toFixed(4)),
      spearman_ic: Number(spearman(preds, actuals).toFixed(4)),
      r2_vs_train_mean: Number((1 - sse / baselineSse).toFixed(4)),
      coverage_90_constant: Number((coveredConst.filter(Boolean).length / coveredConst.length).toFixed(4)),
      coverage_90_dispersion: Number((coveredOwn.filter(Boolean).length / coveredOwn.length).toFixed(4)),
      test_window: [test[0].t, test[test.length - 1].t],
    });
  }
  return { folds, choices };
}

function summarise(name, rows, wf, fit) {
  const folds = wf.folds;
  const s = {
    fit: name,
    labelled_rows: rows.length,
    folds: folds.length,
    walk_forward_mae_log10: Number(mean(folds.map((f) => f.mae_log10)).toFixed(4)),
    walk_forward_mae_multiple: Number(Math.pow(10, mean(folds.map((f) => f.mae_log10))).toFixed(3)),
    walk_forward_rmse_log10: Number(mean(folds.map((f) => f.rmse_log10)).toFixed(4)),
    walk_forward_spearman_ic: Number(mean(folds.map((f) => f.spearman_ic)).toFixed(4)),
    walk_forward_r2_vs_naive: Number(mean(folds.map((f) => f.r2_vs_train_mean)).toFixed(4)),
    interval_coverage_90: Number(mean(folds.map((f) => f.coverage_90_dispersion)).toFixed(4)),
    interval_coverage_90_constant_sigma: Number(mean(folds.map((f) => f.coverage_90_constant)).toFixed(4)),
    sigma_log10: Number(fit.sigma.toFixed(4)),
  };
  process.stdout.write(
    `${name}\n  n=${s.labelled_rows} folds=${s.folds} walk-forward MAE=${s.walk_forward_mae_log10} log10 ` +
      `(${s.walk_forward_mae_multiple}x on a dollar value)  rank IC=${s.walk_forward_spearman_ic}  ` +
      `R2 vs training mean=${s.walk_forward_r2_vs_naive}  90% coverage=${s.interval_coverage_90}\n`,
  );
  return s;
}

/** Rows from the sealed snapshot. Features come only from its own ten fields. */
function snapshotRows(snapshot) {
  const asOf = new Date(`${snapshot.as_of}T00:00:00Z`).getTime();
  return snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .map((p) => {
      const tvl = Math.max(1, Number(p.tvl_usd));
      const growth = p.change_7d === null || p.change_7d === undefined ? 0 : Math.max(-80, Math.min(200, Number(p.change_7d))) / 100;
      const tenureYears = p.listed_at ? Math.max(0, (asOf - new Date(`${p.listed_at}T00:00:00Z`).getTime()) / (365.25 * 86_400_000)) : 0;
      const chains = Array.isArray(p.chains) && p.chains.length > 0 ? p.chains.length : 1;
      return {
        slug: p.slug,
        t: p.listed_at ?? '0000-00-00',
        core: Math.log10(tvl),
        tilt: [growth, Math.log10(1 + tenureYears), Math.log10(1 + chains)],
        y: Math.log10(p.mcap_usd),
        tvl_usd: p.tvl_usd,
      };
    })
    .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
}

/* ---------------------------------------------------------------- run */

const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));

const rowsA = snapshotRows(snapshot);
const wfA = walkForward(rowsA, 30);
/** The hyper-parameter the walk-forward procedure chose most often; recorded, not hand-picked. */
function mode(values) {
  const tally = new Map();
  for (const v of values) tally.set(v, (tally.get(v) ?? 0) + 1);
  return [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
}
const chosenCore = mode(wfA.choices.map((c) => c.lamCore));
const chosenTilt = mode(wfA.choices.map((c) => c.lamTilt));
const fitA = fitModel(rowsA.map((r) => r.core), rowsA.map((r) => r.tilt), rowsA.map((r) => r.y), chosenCore, chosenTilt);
const dispA = fitDispersion(crossValidatedResiduals(rowsA, chosenCore, chosenTilt, 30), fitA.sigma);
const summaryA = summarise('fit A  value model on the sealed snapshot (labelled: protocols recording a market cap)', rowsA, wfA, fitA);

/** Sensitivity of the walk-forward numbers to the penalty, so the choice can be read as a choice. */
const sensitivityA = [];
for (const lamCore of [0, 1, 4, 16, 64]) {
  for (const lamTilt of [0, 4, 16, 64]) {
    const folds = [];
    const n = rowsA.length;
    const initial = Math.max(30, Math.floor(n * 0.35));
    const step = Math.max(4, Math.floor(n * 0.08));
    for (let trainEnd = initial; trainEnd < n; trainEnd += step) {
      const testEnd = Math.min(n, trainEnd + step);
      if (trainEnd >= testEnd) break;
      const tr = rowsA.slice(0, trainEnd);
      const ts = rowsA.slice(trainEnd, testEnd);
      const f = fitModel(tr.map((r) => r.core), tr.map((r) => r.tilt), tr.map((r) => r.y), lamCore, lamTilt, 4, 250);
      const e = ts.map((r) => Math.abs(f.predict(r.core, r.tilt) - r.y));
      folds.push({ mae: mean(e), ic: spearman(ts.map((r) => f.predict(r.core, r.tilt)), ts.map((r) => r.y)) });
    }
    sensitivityA.push({
      lam_core: lamCore,
      lam_tilt: lamTilt,
      mae_log10: Number(mean(folds.map((f) => f.mae)).toFixed(4)),
      spearman_ic: Number(mean(folds.map((f) => f.ic)).toFixed(4)),
    });
  }
}
process.stdout.write(
  `fit A  penalties chosen most often by the walk-forward: lam_core=${chosenCore}, lam_tilt=${chosenTilt}; ` +
    `sensitivity spans IC ${Math.min(...sensitivityA.map((s) => s.spearman_ic)).toFixed(3)} to ${Math.max(...sensitivityA.map((s) => s.spearman_ic)).toFixed(3)}\n`,
);

/** Ablation: the same walk-forward with the TVL core alone, so what the tilts add can be read. */
const ablationA = (() => {
  const n = rowsA.length;
  const initial = Math.max(30, Math.floor(n * 0.35));
  const step = Math.max(4, Math.floor(n * 0.08));
  const folds = [];
  for (let trainEnd = initial; trainEnd < n; trainEnd += step) {
    const testEnd = Math.min(n, trainEnd + step);
    if (trainEnd >= testEnd) break;
    const tr = rowsA.slice(0, trainEnd);
    const ts = rowsA.slice(trainEnd, testEnd);
    const f = fitModel(tr.map((r) => r.core), [[]], tr.map((r) => r.y), chosenCore, chosenTilt, 4, 250);
    const e = ts.map((r) => Math.abs(f.predict(r.core, []) - r.y));
    const trainMean = mean(tr.map((r) => r.y));
    folds.push({
      mae_log10: mean(e),
      spearman_ic: spearman(ts.map((r) => f.predict(r.core, [])), ts.map((r) => r.y)),
      r2_vs_train_mean: 1 - e.reduce((s, x) => s + x * x, 0) / ts.reduce((s, x) => s + (x.y - trainMean) ** 2, 0),
    });
  }
  const out = {
    model: 'log10(implied) = a0 + a1*z(log10 TVL) — no tilt terms',
    folds: folds.length,
    walk_forward_mae_log10: Number(mean(folds.map((f) => f.mae_log10)).toFixed(4)),
    walk_forward_mae_multiple: Number(Math.pow(10, mean(folds.map((f) => f.mae_log10))).toFixed(3)),
    walk_forward_spearman_ic: Number(mean(folds.map((f) => f.spearman_ic)).toFixed(4)),
    walk_forward_r2_vs_naive: Number(mean(folds.map((f) => f.r2_vs_train_mean)).toFixed(4)),
  };
  process.stdout.write(
    `fit A ablation (TVL core alone): MAE=${out.walk_forward_mae_log10} (${out.walk_forward_mae_multiple}x) rank IC=${out.walk_forward_spearman_ic} R2=${out.walk_forward_r2_vs_naive}\n`,
  );
  return out;
})();

/** A second ablation: the "value = mean ratio x TVL" model, i.e. a forced slope of 1 on TVL. */
const ablationRatioA = (() => {
  const n = rowsA.length;
  const initial = Math.max(30, Math.floor(n * 0.35));
  const step = Math.max(4, Math.floor(n * 0.08));
  const errors = [];
  const folds = [];
  for (let trainEnd = initial; trainEnd < n; trainEnd += step) {
    const testEnd = Math.min(n, trainEnd + step);
    if (trainEnd >= testEnd) break;
    const train = rowsA.slice(0, trainEnd);
    const test = rowsA.slice(trainEnd, testEnd);
    const k = mean(train.map((r) => r.y - r.core)); // the training window's mean log10(mcap/tvl)
    const errs = test.map((r) => Math.abs(r.core + k - r.y));
    for (const e of errs) errors.push(e);
    folds.push(mean(errs));
  }
  const out = {
    model: 'log10(implied) = log10(TVL) + mean log10(mcap/tvl) of the training window — slope forced to 1',
    folds: folds.length,
    walk_forward_mae_log10: Number(mean(errors).toFixed(4)),
    walk_forward_mae_multiple: Number(Math.pow(10, mean(errors)).toFixed(3)),
  };
  process.stdout.write(
    `fit A ablation (slope forced to 1): MAE=${out.walk_forward_mae_log10} (${out.walk_forward_mae_multiple}x)\n`,
  );
  return out;
})();

let summaryB = null;
let foldsB = [];
let corpus = null;
try {
  const dex = JSON.parse(readFileSync(DEX, 'utf8'));
  const rowsB = dex.launches
    .filter((l) => l.market_cap_usd > 0 && l.liquidity_usd > 0 && l.volume_h24_usd > 0 && l.txns_h24 > 0 && l.pair_created_at)
    .map((l) => ({
      slug: l.symbol ?? String(l.address).slice(0, 8),
      t: l.pair_created_at,
      core: Math.log10(l.liquidity_usd),
      tilt: [Math.log10(l.volume_h24_usd / l.liquidity_usd + 1), Math.log10(l.txns_h24 + 1), (l.price_change_h24_pct ?? 0) / 100],
      y: Math.log10(l.market_cap_usd),
      tvl_usd: l.liquidity_usd,
    }))
    .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  const wfB = walkForward(rowsB, 25);
  const fitB = fitModel(rowsB.map((r) => r.core), rowsB.map((r) => r.tilt), rowsB.map((r) => r.y), wfB.choices[wfB.choices.length - 1].lamCore, wfB.choices[wfB.choices.length - 1].lamTilt);
  summaryB = summarise('fit B  external check on real DexScreener launches (independent sample)', rowsB, wfB, fitB);
  summaryB.corpus_collected = dex.count;
  summaryB.corpus_chains = [...new Set(dex.launches.map((l) => l.chain))].sort();
  summaryB.corpus_fetched_at = dex.fetched_at;
  foldsB = wfB.folds;
  corpus = { collected: dex.count, chains: summaryB.corpus_chains.length, used: rowsB.length, dropped: dex.count - rowsB.length };
} catch (err) {
  process.stderr.write(`fit B skipped: ${err.message}\n`);
}

const calibration = {
  format: 'makefun-radar-v6/calibration/1',
  generated_at_note: 'written by tools/fit-forecast.mjs; deterministic, no random split anywhere',
  source: {
    snapshot_as_of: snapshot.as_of,
    snapshot_source: snapshot.source,
    snapshot_protocols: snapshot.protocols.length,
    snapshot_watchlist: snapshot.watchlist.length,
    protocols_recording_a_market_cap: snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0).length,
    labelled_rows_used: rowsA.length,
    external_corpus: corpus,
  },
  model: {
    name: 'Launch Value Model v6',
    form: 'log10(implied_usd) = a0 + a1*z(log10 TVL) + b1*z(growth) + b2*z(tenure) + b3*z(breadth), tilts b >= 0',
    label: 'log10(mcap_usd)',
    feature_names: ['log10_tvl', 'growth_7d', 'log10_tenure_years', 'log10_breadth_chains'],
    core_coefficient_standardised: Number(fitA.core.toFixed(6)),
    core_coefficient_per_decade_tvl: Number((fitA.core / fitA.coreScale).toFixed(6)),
    tilt_coefficients_standardised: fitA.tilts.map((v) => Number(v.toFixed(6))),
    intercept: Number(fitA.intercept.toFixed(6)),
    feature_mean: [fitA.coreMu, ...fitA.tiltMu].map((v) => Number(v.toFixed(6))),
    feature_scale: [fitA.coreScale, ...fitA.tiltScale].map((v) => Number(v.toFixed(6))),
    sigma_log10: Number(fitA.sigma.toFixed(6)),
    z_90: Number(Z_90.toFixed(10)),
    dispersion: {
      note: 'log10 of the residual scale as a ridge fit of the same four features, calibrated on held-out residuals inside each training window; a protocol gets its own band, floored at the pooled walk-forward residual scale',
      intercept: Number(dispA.intercept.toFixed(6)),
      coefficients: dispA.coefficients.map((v) => Number(v.toFixed(6))),
      feature_mean: dispA.means.map((v) => Number(v.toFixed(6))),
      feature_scale: dispA.scales.map((v) => Number(v.toFixed(6))),
      drift_sigma_log10: dispA.drift_sigma_log10,
      pooled_sigma_log10: Number(fitA.sigma.toFixed(6)),
      calibration_factor: dispA.calibration_factor,
      rows_used: dispA.rows_used,
      coverage_on_held_out: dispA.coverage_on_held_out,
      floor: 0.25,
      ceiling: 1.6,
    },
    growth_clip_pct: [-80, 200],
  },
  validation: {
    A_value_model: summaryA,
    A_ablation_tvl_only_walk_forward: ablationA,
    A_ablation_slope_forced_to_one: ablationRatioA,
    B_external_launches: summaryB,
    folds_A: wfA.folds,
    folds_B: foldsB,
    hyper_parameter_choices: wfA.choices,
    penalty_sensitivity_A: sensitivityA,
  },
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(calibration, null, 1)}\n`);
process.stdout.write(
  `fit-forecast: core = ${calibration.model.core_coefficient_per_decade_tvl} decades of implied value per decade of TVL; ` +
    `tilt weights (b) = ${calibration.model.tilt_coefficients_standardised.join(', ')}\n` +
    `fit-forecast: wrote ${OUT}\n`,
);
