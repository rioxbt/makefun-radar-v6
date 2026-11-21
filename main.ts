// main.ts — make.fun token-radar-01 entry: Launch Radar v6.
//
// Reads the sealed snapshot (/input/snapshot.json, or --input <file|dir>), applies the Launch
// Value Model v6 whose coefficients lib/calibration.json holds (fitted by tools/fit-forecast.mjs
// with expanding-window walk-forward validation), and writes:
//
//   /output/board.json        every protocol the snapshot holds, ranked by implied value,
//                             each row carrying its farm plan and its score's components
//   /output/data.js           window.RADAR: the same board, plus the validation record, for the page
//   /output/dashboard/        the static page (index.html, app.css, app.js) — no network, no framework
//   /output/screenshots/      the three images the dossier carries
//   /output/dossier.json      what buildDossier writes from those two directories
//
// The program fits nothing, reads no clock and makes no network call: two runs write the same bytes.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input data/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, loadCalibration, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4_194_304 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const calibration = loadCalibration(join(here, 'lib'));
const { board, radar } = buildRadar(snapshot, calibration);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

const page = copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: DASHBOARD_CAPS }),
);

const tiers = board.reduce((acc: Record<string, number>, row) => ((acc[row.tier] = (acc[row.tier] ?? 0) + 1), acc), {});
const top = board.slice(0, 5).map((r) => `${r.rank}. ${r.name} $${Math.round(r.implied_value_usd).toLocaleString('en-US')}`).join(' | ');
process.stdout.write(
  `launch radar v6: ${snapshot.protocols.length} protocols read, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored\n` +
    `launch radar v6: tiers ${Object.entries(tiers).map(([k, v]) => `${k}=${v}`).join(' ')}\n` +
    `launch radar v6: top of the board: ${top}\n` +
    `launch radar v6: fitted core ${calibration.model.core_coefficient_per_decade_tvl} decades of value per decade of TVL, ` +
    `tilts [${calibration.model.tilt_coefficients_standardised.join(', ')}], walk-forward IC ` +
    `${calibration.validation.A_value_model.walk_forward_spearman_ic}, MAE ${calibration.validation.A_value_model.walk_forward_mae_multiple}x, ` +
    `90% interval coverage ${calibration.validation.A_value_model.interval_coverage_90}\n` +
    `launch radar v6: wrote board.json, data.js, dashboard/ (${page.length} files), screenshots/ (${shots.length} images) and dossier.json to ${out}\n`,
);
