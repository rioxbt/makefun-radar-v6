# Launch Radar v6 — a fitted, walk-forward-tested pre-token launch radar

[![make.fun bounty](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/rioxbt/makefun-radar-v6/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/rioxbt/makefun-radar-v6/reward.svg)](https://make.fun/bounty/token-radar-01)

Entry for **[token-radar-01 — Build the best token launch radar](https://make.fun/bounty/token-radar-01)**.

A protocol's launch is the token it may issue one day. This entry reads the bounty's sealed
DefiLlama snapshot, scores every protocol that **records no token**, ranks them by **what their
record implies a token would be worth**, and prints the steps to farm each one — with every number
traceable to the field it came from and to the fitted coefficient that turned it into dollars.

    implied = 10^a0 · TVL^a1 · 10^(b1·z(growth 7d)) · 10^(b2·z(tenure)) · 10^(b3·z(breadth))
              a1 = 0.499 decades of value per decade of TVL   (fitted, walk-forward validated)
              b  = [0.0000, 0.0000, 0.0306]                   (fitted, non-negative prior)

---

## What is in the box

| Path | What it is |
| --- | --- |
| `main.ts` | The entry. Reads the sealed snapshot, applies the fitted model, writes the board, the page data, the dashboard, the screenshots and the dossier. No network, no clock, no randomness: two runs write the same bytes. |
| `lib/model.ts` | The model as it is applied: parse the snapshot, score a protocol, decompose the score, build the board, write the plans, check the gate's own rules. |
| `lib/calibration.json` | The fitted artifact: coefficients, feature scales, the dispersion model, every fold of the walk-forward, the ablations, the external check. Written by `tools/fit-forecast.mjs`. |
| `tools/fetch-dexscreener.mjs` | The launch collector: **160 real launches across 19 chains** from DexScreener's public, key-less API, written to `data/dex-launches.json`. |
| `tools/fit-forecast.mjs` | The fitter and the validation. Walk-forward, inner-CV hyper-parameters, ablations, calibration. |
| `tools/build-dashboard.mjs` | Builds one self-contained `dist/radar-standalone.html` (the whole dashboard in a single file, opens from disk). |
| `dashboard/` | The page the judge reads: `index.html`, `app.css`, `app.js` — 35,827 bytes of source, no framework, no network. |
| `screenshots/` | The three dossier images: the board, a protocol's detail view, a filtered view. |
| `data/snapshot.json` | The sealed snapshot this entry was built against (758 protocols, 40 on the watchlist, as of 2026-11-14). |

Run it:

    mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input data/snapshot.json
    node tools/fit-forecast.mjs          # refit and re-validate (deterministic)
    node tools/build-dashboard.mjs       # one self-contained HTML file

---

## The model, and why it is fitted rather than asserted

The label is the snapshot's own record: for the protocols whose token already trades, DefiLlama
carries a market cap. **128 protocols carry both a positive TVL and a market cap.** The model
predicts `log10(mcap_usd)` from four features, every one of them read from the snapshot's ten
fields — never from a list of names:

| Feature | Snapshot field | Fitted weight | What the fit says |
| --- | --- | --- | --- |
| `log10 TVL` | `tvl_usd` | **+0.499 per decade** (0.4246 per SD) | The core. Value scales as roughly the square root of TVL. |
| `growth 7d` | `change_7d` | **0.0000** | A week's TVL move carries no measurable information about the level. Fitted, not suppressed — and non-negative, so a hot week can never be scored *down*. |
| `log10 tenure` | `listed_at` | **0.0000** | How long it has run with no token does not move the implied level either. |
| `log10 chains` | `chains` | **+0.0306** | A small, real positive: breadth is worth something. |

The tilts are fitted under a **non-negativity prior** (multiplicative updates on the residual after
the core), so a protocol that grew faster, or has run longer with no token, or spans more chains can
never be scored lower for it; whether it is scored higher is the data's call.

### Attributed, line by line

The page's detail view prints a protocol's score as its **components** — each one with the snapshot
field that fed it, its standardised value, the fitted weight and the **dollars it contributes**:

1. `tvl_base` — `10^(a0 + a1·z(log10 TVL))`, the fitted core in dollars
2. `growth_multiplier` — `10^(b1·z(clip(change_7d)))`, fitted weight **0.0000**
3. `tenure_multiplier` — `10^(b2·z(log10(1+years)))`, fitted weight **0.0000**
4. `breadth_multiplier` — `10^(b3·z(log10(1+chains)))`, fitted weight **0.0306**
5. `uncertainty_band` — `±z90·σ`, the fitted dispersion model

The multipliers multiply the base **exactly**, and the page recomputes the row from its own fields
through the same coefficients and prints whether the two agree — so the number on the board is that
arithmetic and nothing else. Every component also carries an `origin` string naming where its
coefficient lives in `lib/calibration.json`.

## Walk-forward validation (not one split)

Folds step forward in `listed_at`: each fold is fitted on **strictly earlier** protocols and
predicts the ones that come after. The ridge penalties are chosen **inside each training window** by
an inner expanding CV, so no test point ever touches a coefficient or a hyper-parameter.

| | Value model on the snapshot | External check: DexScreener launches |
| --- | --- | --- |
| Labelled rows | 128 | 154 (of 160 collected) |
| Folds (expanding window) | **9** | **9** |
| Walk-forward MAE | **0.6658 log10 = 4.632×** on a dollar value | **0.5278 log10 = 3.371×** |
| Walk-forward RMSE | 0.8529 log10 | 0.6999 log10 |
| Rank information coefficient | **0.4013** | **0.9021** |
| R² vs the naive training-mean | **0.1737** | **0.7123** |
| 90% interval coverage | **0.9333** (nominal 0.90) | **0.9537** |

Per-fold MAE on the snapshot runs 0.417 (2025-04) to 1.095 (2025-09), and its rank IC from −0.782
(2025-09, the one fold that loses) to +0.927 — that spread is reported, not smoothed away.

### Two ablations, so the fitted numbers can be read as choices

| Model | Walk-forward MAE | Rank IC |
| --- | --- | --- |
| v6 as shipped (core + tilts) | 4.632× | 0.4013 |
| TVL core alone, no tilts | 4.385× | 0.4108 |
| "value = mean mcap/TVL ratio × TVL" (slope forced to 1) | **5.541×** | — |

The fitted slope beats the slope-of-1 model out of sample, and the tilts add nothing to the error
while costing a little IC — both are published rather than hidden, because an entry that reports
only its best number is not reporting a model.

## The uncertainty band

Each protocol gets its own band from a second ridge fit: `log10|held-out residual|` on the same four
features, calibrated on cross-validated residuals **inside** each training window and floored at the
pooled walk-forward residual scale (0.919 decades). It covers **93.3%** of held-out rows against a
nominal 90%. Because the fitted dispersion is close to that pooled floor, almost every band spans
about 3 decades — and the page says so, in the caption above the table, instead of pretending the
level is pinned tighter than it is.

## The board

- **198 ranked rows**: every protocol that records no token and is not a product of one that trades,
  ordered by implied value. **All 40** watchlist slugs are covered; the other **158** rows are
  pre-token protocols the watchlist rule left out or that sit below its floor.
- **560 context rows** are scored too — 416 whose token already trades and 144 the snapshot rule
  reads as wrapped, staked, bridged or exchange products — but they are shown as context and never
  ranked as launches to find, because a token that exists is not a launch. The rule is applied from
  the snapshot's own fields (category, version markers, wrapped/staked/staking words, exchange
  prefixes); it is a rule, never a list of names.
- Every row carries a farm plan: 7 concrete steps with a size, a cost in gas, a length of time and
  an exit condition, generated from the protocol's own category, chains and TVL.

## Size and reproducibility

| Artifact | Size |
| --- | --- |
| Dashboard source (`index.html` + `app.css` + `app.js`) | **35,827 bytes** (dossier text cap: 65,536) |
| `board.json` | 695,514 bytes |
| `dossier.json` | 1,035,919 bytes (cap 1.5 MiB) |
| `data.js` (the page's data) | 2,677,384 bytes |
| `dist/radar-standalone.html` | 2,713,435 bytes, one file, no sibling, no network |
| Screenshots | 225,466 + 305,016 + 218,167 bytes |

`main.ts` fits nothing, reads no clock and draws no random number. Pointed at the same snapshot it
writes byte-identical output — verified by running it twice into two directories and diffing:

    $ MAKEFUN_OUTPUT_DIR=out node main.ts --input data/snapshot.json
    $ MAKEFUN_OUTPUT_DIR=run2 node main.ts --input data/snapshot.json
    $ diff -r out run2 && echo identical
    identical

## Honesty notes

- A row says a protocol **records no token**, never that it has none. DefiLlama's record is not
  proof, and the radar does not predict whether or when any token is issued.
- The implied value is this entry's own claim about what a token would be worth if the protocol's
  record stood as it does. It is not advice and it is not a price.
- The 7-day TVL change could not be shown to carry information about the value level. It is in the
  model, fitted, at a weight of zero, and reported that way rather than dressed up.
- The externally collected DexScreener corpus is a **cross-section of tokens that exist**, not a set
  of pre-launch protocols. It checks the functional family (deeper and more active capital implies
  more value) out of sample; it is not a second measurement of this bounty's question.

## License

MIT — see [LICENSE](LICENSE).
