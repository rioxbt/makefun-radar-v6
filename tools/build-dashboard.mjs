#!/usr/bin/env node
// tools/build-dashboard.mjs
//
// Builds ONE self-contained HTML file that carries the whole radar — the model, the board, the
// page's CSS and JS — so it opens from disk with no server, no sibling files and no network. The
// same radar main.ts hands in as dashboard/ + data.js is what this inlines; it applies the same
// fitted coefficients from lib/calibration.json, so the standalone page and the entry's page agree.
//
// Usage:  node tools/build-dashboard.mjs [--out dist/radar-standalone.html]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRadar, boardIssue, dataScript, loadCalibration, parseSnapshot } from '../lib/model.ts';

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const OUT = resolve(arg('out', join(root, 'dist', 'radar-standalone.html')));

const snapshot = parseSnapshot(readFileSync(join(root, 'data', 'snapshot.json'), 'utf8'));
const calibration = loadCalibration(join(root, 'lib'));
const { board, radar } = buildRadar(snapshot, calibration);

const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`build-dashboard: the board fails its own rules: ${issue}\n`);
  process.exit(1);
}

const page = readFileSync(join(root, 'dashboard', 'index.html'), 'utf8');
const css = readFileSync(join(root, 'dashboard', 'app.css'), 'utf8');
const js = readFileSync(join(root, 'dashboard', 'app.js'), 'utf8');

// `</` inside a string would close the script element early: escape it in the payload only.
const payload = dataScript(radar).replaceAll('</', '<\\/');
const script = js.replaceAll('</', '<\\/');

const standalone = page
  .replace('<link rel="stylesheet" href="app.css">', () => `<style>\n${css}</style>`)
  .replace('<script src="../data.js"></script>', () => `<script>\n${payload}</script>`)
  .replace('<script src="app.js"></script>', () => `<script>\n${script}</script>`)
  .replace(
    '<title>',
    `<!-- Launch Radar v6 — one self-contained file. Built by tools/build-dashboard.mjs from
     data/snapshot.json and lib/calibration.json, with the same fitted coefficients main.ts applies.
     Board rows: ${board.length} pre-token protocols, ranked; ${radar.context.length} more carried as context. -->\n<title>`,
  );

if (standalone.includes('href="app.css"') || standalone.includes('src="../data.js"')) {
  process.stderr.write('build-dashboard: a reference to the split files survived inlining\n');
  process.exit(1);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, standalone);
process.stdout.write(
  `build-dashboard: ${board.length} ranked rows + ${radar.context.length} context rows inlined\n` +
    `build-dashboard: wrote ${OUT} (${Buffer.byteLength(standalone)} bytes, self-contained: no sibling file, no network)\n`,
);
