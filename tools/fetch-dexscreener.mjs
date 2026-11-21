#!/usr/bin/env node
// tools/fetch-dexscreener.mjs
//
// Collects REAL token launches from DexScreener's public, key-less API and writes them to
// data/dex-launches.json. This is the out-of-sample launch corpus the value model is checked
// against (see tools/fit-forecast.mjs and README "Evidence").
//
// Sources, all public and unauthenticated:
//   https://api.dexscreener.com/token-profiles/latest/v1   recently profiled tokens (fresh launches)
//   https://api.dexscreener.com/token-boosts/latest/v1     recently promoted tokens (fresh launches)
//   https://api.dexscreener.com/token-boosts/top/v1        top promoted tokens
//   https://api.dexscreener.com/latest/dex/search?q=...    keyword pools (majors + launchpads)
//   https://api.dexscreener.com/latest/dex/tokens/<a,b,..> full pair data, up to 30 addresses a call
//
// Each launch keeps the raw figures DexScreener reports (liquidity, market cap, FDV, 24h volume and
// transactions, 24h price change, the pair's creation time) plus the derived age in days. Nothing is
// synthesised: a launch whose pair has no creation time, no market cap or no liquidity is dropped
// rather than filled in.
//
// Usage:  node tools/fetch-dexscreener.mjs [--out data/dex-launches.json] [--min 60]

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const BASE = 'https://api.dexscreener.com';
const UA = 'makefun-radar-v6/1.0 (+token-radar-01 research; public endpoints only)';

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

const OUT = resolve(arg('out', 'data/dex-launches.json'));
const MIN_LAUNCHES = Number(arg('min', '60'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 4) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': UA } });
      if (res.status === 429) throw new Error('rate limited (429)');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      await sleep(400 * attempt * attempt);
    }
  }
  throw new Error(`${url}: ${lastErr && lastErr.message}`);
}

/** Every address any of the discovery sources names. */
async function discover() {
  const addresses = new Map(); // address -> where it was seen
  const add = (address, source, chainId) => {
    if (typeof address !== 'string' || address.length < 8) return;
    if (!addresses.has(address)) addresses.set(address, { source, chainId });
  };

  for (const [path, source] of [
    ['/token-profiles/latest/v1', 'token-profiles'],
    ['/token-boosts/latest/v1', 'token-boosts-latest'],
    ['/token-boosts/top/v1', 'token-boosts-top'],
  ]) {
    try {
      const rows = await getJson(`${BASE}${path}`);
      for (const row of Array.isArray(rows) ? rows : []) add(row.tokenAddress, source, row.chainId);
      process.stderr.write(`discover ${source}: ${Array.isArray(rows) ? rows.length : 0} rows\n`);
    } catch (err) {
      process.stderr.write(`discover ${source}: skipped (${err.message})\n`);
    }
    await sleep(250);
  }

  // Keyword pools: majors, launchpads, and stable/quote assets that anchor deep liquidity.
  const queries = [
    'SOL/USDC', 'ETH/USDC', 'USDC/WETH', 'WETH/USDC', 'PEPE/WETH', 'BONK/SOL',
    'pump', 'launchpad', 'WIF/SOL', 'USDT/WETH', 'ARB/USDC', 'OP/USDC',
    'base/USDC', 'USDC/WBNB', 'meme/SOL', 'AI16Z/SOL', 'RAY/SOL', 'JUP/USDC',
  ];
  for (const q of queries) {
    try {
      const body = await getJson(`${BASE}/latest/dex/search?q=${encodeURIComponent(q)}`);
      const pairs = Array.isArray(body.pairs) ? body.pairs : [];
      for (const pair of pairs) {
        if (pair && pair.baseToken) add(pair.baseToken.address, `search:${q}`, pair.chainId);
      }
      process.stderr.write(`discover search "${q}": ${pairs.length} pairs\n`);
    } catch (err) {
      process.stderr.write(`discover search "${q}": skipped (${err.message})\n`);
    }
    await sleep(250);
  }

  return addresses;
}

/** The deepest-liquidity pair for every address, 30 addresses a call. */
async function fetchPairs(addresses) {
  const byAddress = new Map();
  const list = [...addresses.keys()];
  for (let i = 0; i < list.length; i += 30) {
    const chunk = list.slice(i, i + 30);
    try {
      const body = await getJson(`${BASE}/latest/dex/tokens/${chunk.join(',')}`);
      for (const pair of Array.isArray(body.pairs) ? body.pairs : []) {
        const addr = pair && pair.baseToken && pair.baseToken.address;
        const liq = pair && pair.liquidity ? Number(pair.liquidity.usd) : NaN;
        if (!addr || !Number.isFinite(liq)) continue;
        const prev = byAddress.get(addr);
        if (!prev || liq > prev._liq) byAddress.set(addr, { ...pair, _liq: liq });
      }
      process.stderr.write(`pairs ${i + chunk.length}/${list.length}: ${byAddress.size} addresses with pairs\n`);
    } catch (err) {
      process.stderr.write(`pairs ${i}-${i + 30}: skipped (${err.message})\n`);
    }
    await sleep(300);
  }
  return byAddress;
}

/** One launch record: only what the API actually reports, nothing filled in. */
function toLaunch(pair, seen) {
  const created = Number(pair.pairCreatedAt);
  if (!Number.isFinite(created) || created <= 0) return null;
  const marketCap = Number(pair.marketCap);
  const liquidity = pair.liquidity ? Number(pair.liquidity.usd) : NaN;
  const volume24 = pair.volume ? Number(pair.volume.h24) : NaN;
  if (!Number.isFinite(marketCap) || marketCap <= 0) return null;
  if (!Number.isFinite(liquidity) || liquidity <= 0) return null;
  if (!Number.isFinite(volume24)) return null;
  if (liquidity < 1_000) return null; // dust pools are not a launch with a usable value
  const txns = pair.txns && pair.txns.h24 ? pair.txns.h24 : null;
  const buys = txns ? Number(txns.buys) : NaN;
  const sells = txns ? Number(txns.sells) : NaN;
  const ageDays = (Date.now() - created) / 86_400_000;
  return {
    address: pair.baseToken.address,
    symbol: pair.baseToken.symbol ?? null,
    name: pair.baseToken.name ?? null,
    chain: pair.chainId ?? null,
    dex: pair.dexId ?? null,
    quote: pair.quoteToken && pair.quoteToken.symbol ? pair.quoteToken.symbol : null,
    pair_created_at: new Date(created).toISOString(),
    age_days: Number(ageDays.toFixed(4)),
    liquidity_usd: Math.trunc(liquidity),
    market_cap_usd: Math.trunc(marketCap),
    fdv_usd: Number.isFinite(Number(pair.fdv)) ? Math.trunc(Number(pair.fdv)) : null,
    volume_h24_usd: Math.trunc(volume24),
    volume_h6_usd: pair.volume && Number.isFinite(Number(pair.volume.h6)) ? Math.trunc(Number(pair.volume.h6)) : null,
    txns_h24: Number.isFinite(buys) && Number.isFinite(sells) ? Math.trunc(buys + sells) : null,
    buys_h24: Number.isFinite(buys) ? Math.trunc(buys) : null,
    sells_h24: Number.isFinite(sells) ? Math.trunc(sells) : null,
    price_change_h24_pct: pair.priceChange && pair.priceChange.h24 !== undefined ? Number(pair.priceChange.h24) : null,
    price_change_h6_pct: pair.priceChange && pair.priceChange.h6 !== undefined ? Number(pair.priceChange.h6) : null,
    discovered_via: seen ? seen.source : null,
  };
}

async function main() {
  const addresses = await discover();
  process.stderr.write(`discovered ${addresses.size} distinct token addresses\n`);
  const pairs = await fetchPairs(addresses);

  const launches = [];
  const seenAddress = new Set();
  for (const [addr, pair] of pairs) {
    const launch = toLaunch(pair, addresses.get(addr));
    if (!launch) continue;
    if (seenAddress.has(launch.address)) continue;
    seenAddress.add(launch.address);
    launches.push(launch);
  }
  launches.sort((a, b) => (a.pair_created_at < b.pair_created_at ? -1 : 1));

  const corpus = {
    format: 'makefun-radar-v6/dex-launches/1',
    source: 'DexScreener public API (no key): token-profiles, token-boosts, dex/search, dex/tokens',
    fetched_at: new Date().toISOString(),
    note:
      'Every launch is one base token with a pair DexScreener reports a creation time, a positive market cap ' +
      'and at least $1,000 of liquidity for. Figures are the API\'s own; nothing is imputed.',
    count: launches.length,
    launches,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(corpus, null, 1)}\n`);

  const ages = launches.map((l) => l.age_days);
  process.stdout.write(
    `dexscreener: ${addresses.size} addresses discovered, ${pairs.size} with pairs, ${launches.length} usable launches\n` +
      `dexscreener: age range ${Math.min(...ages).toFixed(1)}d to ${Math.max(...ages).toFixed(1)}d, ` +
      `chains ${[...new Set(launches.map((l) => l.chain))].join(',')}\n` +
      `dexscreener: wrote ${OUT}\n`,
  );
  if (launches.length < MIN_LAUNCHES) {
    process.stderr.write(`dexscreener: ${launches.length} launches is under the --min ${MIN_LAUNCHES} floor\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`fetch-dexscreener: ${err.stack || err.message}\n`);
  process.exit(1);
});
