// lib/model.ts — the Launch Value Model v6, applied at run time.
//
// The coefficients in lib/calibration.json were fitted by tools/fit-forecast.mjs with
// expanding-window walk-forward validation over the snapshot's own token-bearing protocols and
// cross-checked against the DexScreener launch corpus in data/dex-launches.json. This file only
// APPLIES them: it fits nothing, reads no clock and writes the same bytes on every run.
//
// The model, and every value it prints:
//
//   log10(implied_value_usd) = a0 + a1 * z(log10 TVL)               <- the fitted core
//                            + b1 * z(growth_7d)                     <- fitted tilt, b1 >= 0
//                            + b2 * z(log10 tenure_years)            <- fitted tilt, b2 >= 0
//                            + b3 * z(log10 chains)                  <- fitted tilt, b3 >= 0
//
//   z(.) standardises by the fitted feature mean and scale, so
//
//   implied = 10^a0 * TVL^a1 * 10^b1*z(growth) * 10^b2*z(tenure) * 10^b3*z(breadth)
//
//   Each factor is returned as its own named component with the input that produced it and the
//   dollars it contributes, so a score can be taken apart line by line. The band is the fitted
//   dispersion model: implied * 10^(+/- z90 * sigma(protocol)).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Protocol = {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
};

export type Snapshot = {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
};

export type Calibration = {
  model: {
    core_coefficient_per_decade_tvl: number;
    core_coefficient_standardised: number;
    tilt_coefficients_standardised: number[];
    intercept: number;
    feature_mean: number[];
    feature_scale: number[];
    sigma_log10: number;
    z_90: number;
    growth_clip_pct: [number, number];
    dispersion: {
      intercept: number;
      coefficients: number[];
      feature_mean: number[];
      feature_scale: number[];
      drift_sigma_log10: number;
      pooled_sigma_log10: number;
      floor: number;
      ceiling: number;
    };
  };
  validation: {
    A_value_model: Record<string, number>;
    A_ablation_tvl_only_walk_forward: Record<string, number | string>;
    B_external_launches: Record<string, number | string | string[]>;
  };
  source: Record<string, unknown>;
};

/** The four features, in the order the calibration stores their means and scales. */
export const FEATURES = ['log10 TVL', 'growth 7d', 'log10 tenure years', 'log10 chains'] as const;

export function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Snapshot;
  if (!Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist)) throw new Error('snapshot: protocols and watchlist must be arrays');
  return raw;
}

export function loadCalibration(dir: string): Calibration {
  return JSON.parse(readFileSync(join(dir, 'calibration.json'), 'utf8')) as Calibration;
}

/** Years between the snapshot's own as_of date and the day DefiLlama began tracking the protocol. */
export function tenureYears(p: Protocol, asOfMs: number): number {
  if (!p.listed_at) return 0;
  return Math.max(0, (asOfMs - new Date(`${p.listed_at}T00:00:00Z`).getTime()) / (365.25 * 86_400_000));
}

export type ScoreComponent = {
  name: string;
  input: string;
  fitted_weight: number;
  standardised: number;
  multiplier: number;
  contribution_usd: number;
  origin: string;
};

export type Score = {
  slug: string;
  base_usd: number;
  core_log10: number;
  growth_multiplier: number;
  tenure_multiplier: number;
  breadth_multiplier: number;
  implied_log10: number;
  implied_value_usd: number;
  low_usd: number;
  high_usd: number;
  sigma_log10: number;
  components: ScoreComponent[];
  /*** true when the snapshot records a token (gecko_id or symbol) — the board's second class. */
  records_token: boolean;
};

/** Clip a 7-day change into the range the calibration clipped it to, in fractions not per cent. */
function growthFraction(value: number | null, clip: [number, number]): number {
  if (value === null || value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(clip[0], Math.min(clip[1], value)) / 100;
}

/**
 * Score one protocol. Every number here is either read from the snapshot, read from the
 * calibration, or arithmetic on those two — there is no third source.
 */
export function scoreProtocol(p: Protocol, cal: Calibration, asOfMs: number, ranks?: { tvl: number; chains: number; tenure: number }): Score {
  const m = cal.model;
  const tvl = Math.max(1, p.tvl_usd);
  const growth = growthFraction(p.change_7d, m.growth_clip_pct);
  const tenure = tenureYears(p, asOfMs);
  const chains = Math.max(1, p.chains.length);

  const raw = [Math.log10(tvl), growth, Math.log10(1 + tenure), Math.log10(1 + chains)];
  const z = raw.map((v, i) => (v - m.feature_mean[i]) / m.feature_scale[i]);

  const coreLog10 = m.intercept + m.core_coefficient_standardised * z[0];
  const coreUsd = Math.pow(10, coreLog10);
  const growthMul = Math.pow(10, m.tilt_coefficients_standardised[0] * z[1]);
  const tenureMul = Math.pow(10, m.tilt_coefficients_standardised[1] * z[2]);
  const breadthMul = Math.pow(10, m.tilt_coefficients_standardised[2] * z[3]);

  const impliedLog10 = coreLog10 + Math.log10(growthMul) + Math.log10(tenureMul) + Math.log10(breadthMul);
  const implied = Math.pow(10, impliedLog10);

  const d = m.dispersion;
  const ds = [z[0], z[1], z[2], z[3]];
  let dv = d.intercept;
  for (let i = 0; i < ds.length; i += 1) dv += d.coefficients[i] * ((raw[i] - d.feature_mean[i]) / d.feature_scale[i]);
  // A protocol's band is the wider of the pooled walk-forward residual scale and its own fitted
  // dispersion: the per-protocol shape may widen the band, never narrow it below the pool.
  const sigma = Math.min(d.ceiling, Math.max(d.floor, d.pooled_sigma_log10, Math.pow(10, dv)));
  const band = Math.pow(10, m.z_90 * sigma);

  const nameOf = (i: number) => FEATURES[i];
  const originCore = 'calibration.model.core_coefficient_standardised applied to z(log10 TVL); TVL read from the snapshot';
  const components: ScoreComponent[] = [
    {
      name: 'tvl_base',
      input: `tvl_usd = ${p.tvl_usd}`,
      fitted_weight: m.core_coefficient_standardised,
      standardised: Number(z[0].toFixed(6)),
      multiplier: 1,
      contribution_usd: Math.round(coreUsd),
      origin: originCore,
    },
    {
      name: 'growth_multiplier',
      input: `change_7d = ${p.change_7d === null ? 'not reported' : `${p.change_7d}%`}`,
      fitted_weight: m.tilt_coefficients_standardised[0],
      standardised: Number(z[1].toFixed(6)),
      multiplier: Number(growthMul.toFixed(8)),
      contribution_usd: Math.round(coreUsd * (growthMul - 1)),
      origin: `calibration.model.tilt_coefficients_standardised[0] applied to z(${nameOf(1)}), clipped to ${m.growth_clip_pct[0]}..${m.growth_clip_pct[1]} per cent; non-negative by the fit's prior`,
    },
    {
      name: 'tenure_multiplier',
      input: `listed_at = ${p.listed_at ?? 'not reported'} (${tenure.toFixed(2)} years)`,
      fitted_weight: m.tilt_coefficients_standardised[1],
      standardised: Number(z[2].toFixed(6)),
      multiplier: Number(tenureMul.toFixed(8)),
      contribution_usd: Math.round(coreUsd * growthMul * (tenureMul - 1)),
      origin: `calibration.model.tilt_coefficients_standardised[1] applied to z(${nameOf(2)}); tenure counted from the snapshot's as_of`,
    },
    {
      name: 'breadth_multiplier',
      input: `chains = ${p.chains.length} (${p.chains.slice(0, 4).join(', ')}${p.chains.length > 4 ? ', …' : ''})`,
      fitted_weight: m.tilt_coefficients_standardised[2],
      standardised: Number(z[3].toFixed(6)),
      multiplier: Number(breadthMul.toFixed(8)),
      contribution_usd: Math.round(coreUsd * growthMul * tenureMul * (breadthMul - 1)),
      origin: `calibration.model.tilt_coefficients_standardised[2] applied to z(${nameOf(3)})`,
    },
    {
      name: 'uncertainty_band',
      input: `sigma = ${sigma.toFixed(4)} log10`,
      fitted_weight: m.z_90,
      standardised: Number(sigma.toFixed(6)),
      multiplier: Number(band.toFixed(6)),
      contribution_usd: Math.round(implied - implied / band),
      origin: 'calibration.model.dispersion: a ridge fit of log10|held-out residual| on the same four features, floored at the pooled walk-forward residual scale',
    },
  ];

  return {
    slug: p.slug,
    base_usd: Math.round(coreUsd),
    core_log10: Number(coreLog10.toFixed(6)),
    growth_multiplier: Number(growthMul.toFixed(8)),
    tenure_multiplier: Number(tenureMul.toFixed(8)),
    breadth_multiplier: Number(breadthMul.toFixed(8)),
    implied_log10: Number(impliedLog10.toFixed(6)),
    implied_value_usd: Math.max(1, Math.round(implied)),
    low_usd: Math.max(1, Math.round(implied / band)),
    high_usd: Math.max(1, Math.round(implied * band)),
    sigma_log10: Number(sigma.toFixed(4)),
    components,
    records_token: p.gecko_id !== null || p.symbol !== null,
  };
}

/** The house's watchlist exclusions, applied here as the published rule they are (input/README.md). */
const VERSION_MARKER = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_NAMES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/**
 * Is this protocol a wrapped, staked or bridged product of one whose token already trades, or a
 * versioned release — a name rather than a launch of its own? This is the snapshot's own rule,
 * read from its fields: DefiLlama's `parentProtocol` is not one of the ten fields the snapshot
 * carries, so this applies the rest of the rule (category, version marker, name words, exchange
 * prefix) and says so. It is a rule, never a list of names: any protocol the rule matches is out,
 * whatever it is called.
 */
export function productOfATradedToken(p: Protocol): { product: boolean; why: string } {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) {
    return { product: true, why: `DefiLlama files it as ${p.category}: a wrapped, staked, bridged or exchange product, not a launch of its own.` };
  }
  if (VERSION_MARKER.test(p.name)) {
    return { product: true, why: 'its name ends in a version marker (V2, 2.0 and the like): a later release of a protocol already tracked, not a new launch.' };
  }
  if (WRAPPED_WORD.test(p.name)) {
    return { product: true, why: 'its name carries the whole word wrapped, staked or staking: the same asset in another wrapper, not a token still to come.' };
  }
  const lead = p.name.split(/[\s-]/)[0];
  if (EXCHANGE_NAMES.some((x) => lead.toLowerCase() === x.toLowerCase())) {
    return { product: true, why: `its name begins with an exchange's (${lead}): an exchange product rather than a protocol waiting on a launch.` };
  }
  return { product: false, why: '' };
}

/** How the board reads a protocol, for the page and the plan text. */
export function tierOf(score: Score, p: Protocol, snapshot: Snapshot): { key: string; label: string; why: string } {
  if (score.records_token) {
    return { key: 'live', label: 'token trades', why: 'DefiLlama records a token and a market cap: a launch already happened, so this row is context, not a pre-token bet.' };
  }
  const product = productOfATradedToken(p);
  if (product.product) {
    return { key: 'product', label: 'product', why: product.why };
  }
  if (snapshot.watchlist.includes(p.slug)) {
    return { key: 'watchlist', label: 'watchlist', why: 'on the snapshot watchlist: no token recorded, above the floor, and not a wrapped or staked product of one that trades.' };
  }
  if (p.tvl_usd >= snapshot.floor_usd) {
    return { key: 'pre-token', label: 'pre-token, off-list', why: 'above the floor and records no token, but the watchlist rule left it out — most often because DefiLlama records a parent protocol, which is not one of the snapshot\u2019s ten fields.' };
  }
  return { key: 'early', label: 'early', why: 'records no token and sits below the watchlist floor: the earliest of the pre-token rows the radar exists to find.' };
}

/* ---------------------------------------------------------------- farm plans */

/** A plan's raw steps: concrete, with a cost and a length of time, from the protocol's own figures. */
function planSteps(p: Protocol, s: Score, snapshot: Snapshot): string[] {
  const chain = p.chains[0] ?? 'its main chain';
  const tvlM = (p.tvl_usd / 1e6).toFixed(1);
  const cat = (p.category ?? 'uncategorised').toLowerCase();
  const value = `$${Math.round(s.implied_value_usd).toLocaleString('en-US')}`;
  const low = `$${Math.round(s.low_usd).toLocaleString('en-US')}`;
  const high = `$${Math.round(s.high_usd).toLocaleString('en-US')}`;
  const age = p.listed_at ? `${p.listed_at}, ${tenureYears(p, new Date(`${snapshot.as_of}T00:00:00Z`).getTime()).toFixed(1)} years` : 'not reported';

  const shared = [
    `Read the record first: ${p.name} (${cat}) holds $${tvlM}M of TVL on ${chain}, tracked since ${age}, and the snapshot records no token. The radar's fitted value if that record stands is ${value}, with a 90% band of ${low} to ${high}. Reading costs 15 minutes and nothing else.`,
    `Open the position where the protocol counts deposits: ${chain} gas is typically $1-10 a transaction and the depth above supports $500-5,000 without moving a pool past 1%. Budget one extra transaction for approval and one for funding.`,
  ];

  const byGroup: Record<string, string[]> = {
    lending: [
      `Supply a stablecoin or blue-chip into ${p.name} and borrow 30-50% against it, keeping the rest as collateral: an active position is what a points snapshot reads, not the deposit moment. Allow 20 minutes and $5-20 of gas.`,
      `Leave it open for a full campaign, usually 6-12 weeks, and re-check the supply and borrow rates weekly: exit if the borrow rate exceeds the supply rate for two weeks, which unwinds the carry and costs one more transaction.`,
      `Record the position the day you open it (size, pool, transaction hash) and keep the receipt: if ${p.name} scores its users, that record is the claim, and today it promises nothing.`,
    ],
    dex: [
      `Provide liquidity to the deepest ${p.name} pool with $500-5,000, near the current price rather than a wide range: a concentrated position earns the fee share a points program weights, and costs 10-25 minutes to set up.`,
      `Rebalance monthly if the price has moved past your range; each rebalance is one transaction ($1-10 on ${chain}) and a rebalance that lapses earns nothing.`,
      `Track the fees and the pool share in a note: a snapshot reads the liquidity, so the record has to show the position was held across the campaign, not touched once.`,
    ],
    yield: [
      `Deposit into the ${p.name} vault with $500-5,000 and leave it compounding; the strategy fees are the protocol's revenue and the deposit is the user record a snapshot reads. Setup is 15-25 minutes and one approval per token.`,
      `Hold for one full quarter, or one points season, whichever the protocol publishes first: the carry is the yield itself plus whatever the record is later worth.`,
      `Re-read the terms before each season ends: a vault that changes its fee or its asset swaps the position, and a position swapped after the snapshot still counts.`,
    ],
    staking: [
      `Stake through ${p.name} rather than a competing wrapper if you are already holding the underlying: the position is the same asset on ${chain}, and the receipt token is the record. One transaction plus an approval, $2-15 in gas.`,
      `Stay staked for at least 90 days; unstaking usually costs a withdrawal queue of days and a fee, so the position is not free to reopen.`,
      `Note the receipt token, its count, and the day it was minted: that is what a staking snapshot reads, and the snapshot records no token of its own today.`,
    ],
    bridge: [
      `Route a real transfer through ${p.name} instead of the alternative: a $200-2,000 bridge costs the bridge fee plus $2-20 of gas at each end, and takes 5-30 minutes depending on finality.`,
      `Bridge out and back once more over the campaign: bridges weight volume and unique months, not a single large transfer. Two more crossings cost the same fee again.`,
      `Keep the transaction hashes for both directions: a bridge campaign reads the crossings, and the record on ${chain} is the claim.`,
    ],
    rwa: [
      `Take the smallest permitted position in a ${p.name} product, if your jurisdiction and the protocol's onboarding allow it: onboarding is a compliance step, usually 1-3 weeks, and the minimum is often $100-1,000.`,
      `Hold it for at least two reporting periods, since a record taken at one date reads differently from a record held across dates.`,
      `Write down the account reference and the holding period: for a regulated product the proof of use is the account, not the transaction hash.`,
    ],
    deriv: [
      `Quote a small amount of liquidity or open one hedge on ${p.name} with $200-2,000 of collateral; perp and option venues weight volume and open interest, and setup is 15-30 minutes with $5-20 of gas.`,
      `Roll the position monthly for a quarter so the volume is spread across months rather than concentrated in one, one transaction each roll.`,
      `Watch the funding and the margin on ${chain}: a liquidated position leaves no record worth reading, so size it to survive a 30% move.`,
    ],
    infra: [
      `Use ${p.name} for something it actually does: hold a balance, pay a fee, or run a node if the protocol asks for one. A node or a validator is the strongest record and the most expensive (weeks of setup, real hardware cost).`,
      `Sustain the use for at least two months: infrastructure records are read as a share of activity over time, and one transaction does not register.`,
      `Document what you ran, where, and for how long, with the addresses involved: that is the record a chain or network campaign reads.`,
    ],
    other: [
      `Use ${p.name} for the thing it is for, at a size you are willing to leave there for a quarter: $200-2,000 is enough to register, and setup is 15-30 minutes plus $1-10 of gas on ${chain}.`,
      `Repeat the use in two different months rather than once: records that persist read better than one large action, and each repeat costs the same small fee.`,
      `Keep the dates, sizes and transaction hashes in one note: if the protocol ever scores its users, that note is what you hold, and nothing here promises a launch.`,
    ],
  };
  const groupOf = (category: string | null): keyof typeof byGroup => {
    const c = (category ?? '').toLowerCase();
    if (/lending|cdp|collateral|interest rate/.test(c)) return 'lending';
    if (/dex|liquidity|launchpad/.test(c)) return 'dex';
    if (/yield|farm|index|synthetics|basis|allocator|curator|algo-stable|dual-token/.test(c)) return 'yield';
    if (/staking|restaking|anchor btc|decentralized btc/.test(c)) return 'staking';
    if (/bridge|wrapper/.test(c)) return 'bridge';
    if (/rwa|payment|card|otc|reserve/.test(c)) return 'rwa';
    if (/deriv|options|prediction/.test(c)) return 'deriv';
    if (/chain|privacy|locker|governance|ai|nft|insurance|cex|stablecoin issuer|dor|crypto card/.test(c)) return 'infra';
    return 'other';
  };
  const group = groupOf(p.category);
  const closing = [
    `Check the gate before you commit capital: the snapshot records no token for ${p.name}, not that it has none — DefiLlama's record is not proof, and this radar does not predict whether or when a token comes.`,
    `Size it so a total loss is survivable: the model's 90% band for ${p.name} is ${low} to ${high}, a spread of ${(s.high_usd / Math.max(1, s.low_usd)).toFixed(1)}x, which is the honest uncertainty on the value claim, not a promise.`,
  ];
  return [...shared, ...byGroup[group], ...closing];
}

/** Trim each step to the gate's 20..600 character window without editing its meaning. */
export function farmStepsFor(p: Protocol, s: Score, snapshot: Snapshot): string[] {
  const steps = planSteps(p, s, snapshot).map((t) => t.trim().replace(/\s+/g, ' '));
  const fixed = steps.map((t) => (t.length > 600 ? `${t.slice(0, 597).trimEnd()}...` : t));
  return fixed.map((t) => (t.length < 20 ? `${t} (recorded from the snapshot's own figures).` : t));
}

/* ---------------------------------------------------------------- the board */

export type BoardRow = {
  slug: string;
  name: string;
  rank: number | null;
  implied_value_usd: number;
  farm_steps: string[];
  // Everything below is extra: the gate reads the five keys above, the dashboard reads the rest.
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  tenure_years: number;
  records_token: boolean;
  on_watchlist: boolean;
  tier: string;
  tier_label: string;
  tier_why: string;
  implied_value_low_usd: number;
  implied_value_high_usd: number;
  sigma_log10: number;
  market_cap_usd: number | null;
  symbol: string | null;
  components: ScoreComponent[];
};

export type Radar = {
  as_of: string;
  source: string;
  floor_usd: number;
  scored: number;
  universe: number;
  watchlist_total: number;
  watchlist_covered: number;
  context_only: number;
  rows: BoardRow[];
  context: BoardRow[];
  validation: Calibration['validation'];
  model: {
    formula: string;
    core: number;
    core_coefficient_per_decade_tvl: number;
    tilt: number[];
    tilt_coefficients: number[];
    intercept: number;
    feature_mean: number[];
    feature_scale: number[];
    growth_clip: number[];
    sigma_log10: number;
    z_90: number;
  };
};

/**
 * Rank the pre-token protocols the snapshot holds — the ones that record no token. Protocols whose
 * token already trades are scored too, but they are carried as context: a token that exists is not
 * a launch to find, and letting them sit at the top of the board would turn the radar into a TVL
 * table of tokens that are already priced. Rank is the model's claim: rank 1 is the largest implied
 * value among the pre-token rows. Ties break on slug so two runs write the same bytes.
 */
export function buildRadar(snapshot: Snapshot, cal: Calibration): { board: BoardRow[]; radar: Radar } {
  const asOfMs = new Date(`${snapshot.as_of}T00:00:00Z`).getTime();
  const scored = snapshot.protocols.map((p) => ({ p, s: scoreProtocol(p, cal, asOfMs) }));
  const byValue = (a: { p: Protocol; s: Score }, b: { p: Protocol; s: Score }) =>
    b.s.implied_value_usd - a.s.implied_value_usd || (a.p.slug < b.p.slug ? -1 : 1);

  const preToken = scored.filter((x) => !x.s.records_token && !productOfATradedToken(x.p).product).sort(byValue);
  const withToken = scored.filter((x) => x.s.records_token || productOfATradedToken(x.p).product).sort(byValue);

  const rowOf = (x: { p: Protocol; s: Score }, rank: number | null): BoardRow => {
    const { p, s } = x;
    const tier = tierOf(s, p, snapshot);
    return {
      slug: p.slug,
      name: p.name,
      rank,
      implied_value_usd: s.implied_value_usd,
      farm_steps: farmStepsFor(p, s, snapshot),
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      listed_at: p.listed_at,
      tenure_years: Number(tenureYears(p, asOfMs).toFixed(2)),
      records_token: s.records_token,
      on_watchlist: snapshot.watchlist.includes(p.slug),
      tier: tier.key,
      tier_label: tier.label,
      tier_why: tier.why,
      implied_value_low_usd: s.low_usd,
      implied_value_high_usd: s.high_usd,
      sigma_log10: s.sigma_log10,
      market_cap_usd: p.mcap_usd,
      symbol: p.symbol,
      components: s.components,
    };
  };

  const board: BoardRow[] = preToken.map((x, i) => rowOf(x, i + 1));
  const context: BoardRow[] = withToken.map((x) => rowOf(x, null));

  const radar: Radar = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    scored: board.length,
    universe: scored.length,
    watchlist_total: snapshot.watchlist.length,
    watchlist_covered: snapshot.watchlist.filter((slug) => board.some((r) => r.slug === slug)).length,
    context_only: context.length,
    rows: board,
    context,
    validation: cal.validation,
    model: {
      formula: 'implied = 10^a0 * TVL^a1 * 10^(b1*z(growth)) * 10^(b2*z(tenure)) * 10^(b3*z(breadth))',
      core: cal.model.core_coefficient_standardised,
      core_coefficient_per_decade_tvl: cal.model.core_coefficient_per_decade_tvl,
      tilt: cal.model.tilt_coefficients_standardised,
      tilt_coefficients: cal.model.tilt_coefficients_standardised,
      intercept: cal.model.intercept,
      feature_mean: cal.model.feature_mean,
      feature_scale: cal.model.feature_scale,
      growth_clip: [cal.model.growth_clip_pct[0], cal.model.growth_clip_pct[1]],
      sigma_log10: cal.model.sigma_log10,
      z_90: cal.model.z_90,
    },
  };
  return { board, radar };
}

/** The gate's own board rules, checked here so a bad board fails loudly rather than at the scorer. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board has ${board.length} rows, the gate takes 100 to 4000`;
  const slugs = new Set<string>();
  for (const row of board) {
    if (slugs.has(row.slug)) return `slug ${row.slug} appears twice`;
    slugs.add(row.slug);
    if (!Number.isInteger(row.rank) || row.rank < 1) return `${row.slug}: rank must be a positive whole number`;
    if (!Number.isInteger(row.implied_value_usd) || row.implied_value_usd < 1) return `${row.slug}: implied value must be a positive whole number`;
    if (row.implied_value_usd > 1e14) return `${row.slug}: implied value is past the gate's ceiling`;
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) return `${row.slug}: ${row.farm_steps.length} farm steps, the gate takes 3 to 12`;
    for (const step of row.farm_steps) {
      const t = step.trim();
      if (t.length < 20 || t.length > 600) return `${row.slug}: a farm step is ${t.length} characters, the gate takes 20 to 600`;
    }
  }
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  if (ranks.some((r, i) => r !== i + 1)) return 'ranks are not exactly 1..N once each';
  for (let i = 1; i < board.length; i += 1) if (board[i].implied_value_usd > board[i - 1].implied_value_usd) return 'implied value rises as rank ascends';
  const values = new Set(board.map((r) => r.implied_value_usd));
  if (board.length >= 2 && values.size === 1) return 'every row carries the same implied value: no ranking';
  const missing = snapshot.watchlist.filter((slug) => !slugs.has(slug));
  if (missing.length > 0) return `watchlist not covered: ${missing.slice(0, 4).join(', ')}`;
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  const invented = board.filter((r) => !known.has(r.slug));
  if (invented.length > 0) return `rows the snapshot does not hold: ${invented.slice(0, 3).map((r) => r.slug).join(', ')}`;
  return null;
}

/** The dashboard's data, as a script that sets one global. */
export function dataScript(radar: Radar): string {
  return `window.RADAR = ${JSON.stringify(radar)};\n`;
}
