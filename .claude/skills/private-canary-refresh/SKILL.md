---
name: private-canary-refresh
description: Refresh runbook for ALL of the private-canary page's data (x402scan, Blockchair, ZecHub, bitinfocharts, CoinGecko, Coin Metrics, DefiLlama, and the keyless on-chain readers). Use when refreshing the page's data, adding or debugging a source, or working on fetch-pc-stats. Dune is retired: queries/*.sql are history only, and baselines/ holds the Dune results the on-chain readers were checked against.
user-invocable: true
---

# private-canary-refresh

Everything behind the `private-canary` page's data. One command fetches every
source, all of it keyless. This skill is its runbook; `queries/` holds the
retired Dune `.sql` as history, and `baselines/` the Dune results the on-chain
readers that replaced them were checked against.

**Two repos.** The script runs here (khufiya) and writes into the site repo
(`SITE_DIR`, default `../www.cyberchitta.cc`); the site owns `pcData.js`,
`build/derive-pc-series.js`, the charts, and the event timeline. Paths below
under `src/` are in the site repo.

## The command + data model

```
bun run fetch-pc-stats        # scripts/fetch-privacy-coin-stats.js, run in khufiya
```

- **Immutable dated folders.** Each run writes `src/assets/data/privacy-coins/raw/<YYMMDD>/`,
  deletes the superseded folder, and rewrites the `src/_data/pcStats.json`
  pointer (`{folder, updatedAt}`) that `pcData.js` resolves at build time. Long-
  TTL header on `/assets/data/privacy-coins/raw/**`. Same-day reruns overwrite.
- **Per-source fail-soft.** Every source is wrapped in `safe()`; a failure logs
  `[FAIL]` and the file is **carried forward** unchanged from the previous
  folder. So a refresh never loses a series — it just doesn't advance the ones
  that failed. The scraped/series files are re-fetched as *full history* each
  run (overwrite), so a normal refresh is "yesterday + today's point" plus any
  upstream revisions.
- **`snapshots.json` is append-only**, one entry per UTC day — a refresh adds
  today's entry on top of the history, never rewrites past days.
- **Keyless throughout.** Every source is keyless as of 2026-09-16 — there is no
  API key anywhere in the refresh, and no `.env` is needed.

## Sources

| source | feeds | notes / fragility |
|---|---|---|
| **x402scan** tRPC `public.stats.overall` + `.bucketed` | x402 snapshot + `x402-series.json` | unofficial/unversioned — schema pinned to github.com/Merit-Systems/x402scan. Bucketed = daily buckets for full history; partial current day dropped |
| **Blockchair** `/{monero,zcash}/stats` | chain stats in `snapshots.json` | keyless 1,440/day. Monero has no `transactions_24h`; ZEC `circulation` field is broken — **never use** |
| **ZecHub** raw JSON (ZecHub/zechub-wiki `public/data/zcash/`) | `zcash-series.json` (shielded supply + shielded tx/day) | ~daily commits; dates MM/DD/YYYY with stray ISO rows. **Pools are read from the file's keys, not hardcoded** — Ironwood (NU6.3, 2026-07-28) arrived as a fourth key and a fixed Sprout/Sapling/Orchard list undercounted shielded tx ~5× until 2026-09-15. **Best free source for ZEC shielded data** — checked 2026-06-13: Dune doesn't index Zcash; Coin Metrics keeps shielded metrics Pro-only (community tier has none). **`fetchZcashSeries` splices** the long history: `transaction_summary.json` (Sapling+Orchard counts keyed by block *height*, back to Sapling activation ~Oct 2018) for the prefix, height→date mapped via `blockFeesZEC.json` (which carries Block+Date anchors, ~1-day accuracy), then the precise date-native `shieldedtxcount.json` for the recent tail. Tail's first row (2024-09-05) is an anomalous seed value (orchard 0, sapling ~2×) — harmless, the chart's 30-day smoothing washes it out. shielded *supply* (`shielded_supply.json`) is full from 2017. |
| **bitinfocharts** scrape (5 pages) | `market-series.json` (XMR/ZEC price, **XMR mcap only**, BTC tx/day) + `monero-tx-series.json` (XMR tx/day + avg fee) | **fragile** — regex on page JS; sanity-checks ≥1000 pts, fails soft; intraday current-day point dropped |
| **CoinGecko** keyless | current prices, mcaps, privacy-coins category, global (snapshot) | ~30/min, rate-limits on rapid reruns. **History capped at 365d** — why market history rides bitinfocharts. Feeds `snapshots.json`, which since 2026-09-16 **nothing on the site reads at build time** — it is the committed record for a reader reproducing the numbers, not a page input |
| **Coin Metrics** community API | `stablecoin-series.json` (USDT/USDC tx/day) | keyless; `usdt`/`usdc` are cross-chain aggregates; paginated `paging_from=start`, page cap as runaway guard |
| **DefiLlama** `/protocol/<slug>` | `onchain-privacy-series.json` (TVL railgun/tornado-cash/privacy-pools) | keyless, full daily history |
| **on-chain flow readers** (keyless) | `privacy-flows.json` | Railgun (`railgun-flows.js`, Eth+Polygon+Arbitrum), Tornado (`tornado-flows.js`), Privacy Pools (`privacy-pools-flows.js`). See **Privacy-layer flows** below |
| **on-chain readers** (keyless) | `base-freezes.json`, `stablecoin-blacklist.json` | Base + Ethereum via `evm-logs.js`, Tron via TronGrid |
| **fiat rails** (hand-maintained seed) | `fiat-rails-series.json` (UPI monthly volume + Visa quarterly processed tx → the chart's "fiat ceiling") | **not fetched** — see **Fiat-rails baseline** below |

`events.json` (the timeline) is **hand-curated, top-level, never written by the
script.** Source-verify new entries before publish (Showrunner-gated).

`fiat-rails-series.json` is the **second hand-maintained file** — same spirit as
`events.json`, but it *is* per-folder: the canonical copy lives at
`data/fiat-rails-series.json` (this repo) and `seedForward()` copies
it into each dated folder so it caches/resolves like the fetched series. See
**Fiat-rails baseline** below.

## Privacy-layer flows

**No Dune query feeds anything any more.** The last three (7714782 Railgun,
7714895 Tornado, 7714910 Privacy Pools) were replaced by on-chain readers on
2026-09-16. **The three output files were named `dune-*.json` until 2026-09-16**
— if you are reading an older folder, `privacy-flows.json` was
`dune-privacy-flows.json`, `base-freezes.json` was `dune-base-freeze.json`, and
`stablecoin-blacklist.json` was `dune-blacklist.json`. The `{ columns, rows }`
shape inside them is unchanged and is still the contract.
 `queries/*.sql` and `_notes/DUNE-SETUP.md` are kept only as history,
and `baselines/dune-2026-09-15/` is what the readers were checked against.

All three write `privacy-flows.json` as **full history off their own event
cache in `cache/`** — no prefix to splice, no `{{since}}` to tune, nothing to
re-Run by hand before a refresh. Commit the caches with the refresh.

| protocol | reader | cache | scope |
|---|---|---|---|
| Railgun | `scripts/railgun-flows.js` | `cache/railgun-flows.json` | Ethereum + Polygon + Arbitrum |
| Tornado | `scripts/tornado-flows.js` | `cache/tornado-flows.json` | Ethereum |
| Privacy Pools | `scripts/privacy-pools-flows.js` | `cache/privacy-pools-flows.json` | Ethereum |

**Stablecoins are matched by contract address, never by symbol** — this is the
single most important thing here. Dune joined `tokens.erc20` on
`upper(symbol) in ('USDC','USDT','DAI')`, which counts any token that merely
*calls itself* USDC or DAI. That was not cosmetic:

- **Railgun 2026-08**: a counterfeit "DAI" (`0x12d9fe4c…`) moved 110,980,202
  units in 6 transfers. Dune reported **$177,925,658**; the canonical
  stablecoins give **$67,360,458** — the published figure was ~2.6x too high.
- **Privacy Pools**: `0x32857f58…` ($50.00, 2026-01) and `0x18042f88…`
  ($1,318.68, 2026-03) were the entire difference from 7714910.

The symbol join also **excluded** real flow, because a token can be renamed out
of the filter: Polygon USDT reports its symbol as `USDT0`. The bridged "USDC.e"
tokens are **not** an instance of this — checked 2026-09-16, both return plain
`USDC` from `symbol()`, so Dune matched them; `USDC.e` is their common name, not
their on-chain symbol. Everything is counted by address here regardless.

**Per-reader notes**

- **Tornado counts its own Deposit/Withdrawal events x the instance's fixed
  denomination**, not ERC20 transfers — exact integer arithmetic, and the same
  definition Dune's curated `tornado_cash.*` tables use. Transfer-scanning was
  measured wrong twice over: stray tokens sent straight to an instance count as
  flow, and float accumulation puts cents on whole-number months. The 10
  stablecoin instances were derived on-chain (every contract that ever emitted a
  Tornado `Deposit`, then `token()`/`denomination()`); ~200 copycat contracts
  share that topic0, so **do not widen the set without re-checking the
  baseline**. Verified 2026-09-16: **81/81 months exact**.
- **Railgun drops BNB (owner decision, 2026-09-16).** Not a range problem — a
  keyless **archive** problem. Of 23 BSC endpoints measured, the ones that hold
  up under load serve only recent blocks (`header not found` deep in history),
  the one archival endpoint times out (8/60 ok, ~195h for a pass), and
  publicnode 403s under sustained load and refuses `eth_getLogs` without an
  `address` filter. BNB is <=~2% (its contract holds ~$330k). **A quoted Railgun
  figure is three-chain scope — phrase it honestly.** All three chains must
  succeed or the run fails; a short total would read as a collapse in turnover.
- **Privacy Pools contracts are still unconfirmed on Etherscan** (entrypoint
  `0x6818…6b46`, pool `0xf241…c9fb`) — same caveat as the Dune era. Reproducing
  7714910 is evidence, not confirmation.
- **Railgun's old repo-cached prefix is gone.** It was seeded from AMLBot
  6702283 (`_notes/seed-privacy-flows.mjs`); the series is now chain-derived end
  to end. The prefix was *not* contaminated (published 2025-05 $81.4M vs $79.8M
  on-chain, -2.0%) — it was dropped so the whole series has one definition.

## Fiat-rails baseline

The two transparent-rail comparison lines on the `privacy-tx` chart (the "fiat
ceiling" the privacy lines sit far beneath) come from a **hand-maintained seed**,
not a fetcher — because **Visa publishes only quarterly** ("total processed
transactions" per earnings release) and **NPCI's UPI page is a SPA with no clean
public data URL**. So both are appended by hand.

- **Shape.** `{ upi: { points: [["YYYY-MM", count], …] }, visa: { points:
  [["YYYY-MM-DD", processedTx], …] } }`. UPI keys are months (NPCI monthly
  *volume*, count of transactions); Visa keys are the fiscal-quarter **end** date
  (total *processed* transactions — not the smaller "payments transactions"
  metric). Raw period totals are stored; both renderers (`private-canary.js`
  `perDay()` and the `pc-chart.md.js` mirror) divide by days-in-period to plot a
  per-day rate, dropping the launch-era zero UPI months so the log axis stays
  finite.
- **Sources.** UPI: India Data Portal CKAN datastore (2016-04 → 2023-08; the
  direct CSV 500s, the datastore_search API works) + NPCI monthly press releases
  via Business Standard / newsonair / Tribune / ANI for the tail. Visa: SEC 8-K
  earnings releases (Form 8-K Exhibit 99.1, CIK 1403161; the verbatim line is
  "Total processed transactions … were X.X billion"), mirrored at
  investor.visa.com.
- **To advance.** Append the new UPI month(s) and/or the new Visa quarter to
  `data/fiat-rails-series.json` (canonical copy, this repo), then
  rerun `bun run fetch-pc-stats` — `seedForward()` copies it into the dated
  folder. UPI lands ~2nd of each month; Visa ~4×/year a few weeks after each
  quarter-end (FY ends Sep 30, so quarters end Dec 31 / Mar 31 / Jun 30 / Sep 30).
  Keep Visa on *processed* transactions, not *payments* transactions.

## Refresh procedure

1. Nothing to do by hand. Optionally append any new UPI month / Visa quarter to
   `fiat-rails-series.json` (see **Fiat-rails baseline**) — it's not tied to the
   refresh cadence, append whenever new figures land.
2. `bun run fetch-pc-stats` — fully keyless; there is no key to set.
3. Eyeball the log for `[FAIL]` (a dead source — carried forward).
   **Carry-forward reads only an *earlier*
   dated folder, and the first run of the day deletes it** — so a same-day rerun
   silently drops every series that fails, and the Railgun suffix loses its
   prefix. Fix the source, don't rerun; or restore from git (`HEAD:raw/<old>/`).
4. Verify the cross-checks below, then `bun run build` in the site repo + commit
   in both repos (human-gated).

## Validation cross-checks (after a refresh, before committing)

- **x402 / market / TVL series** — `stats.updated` advanced to today; spot-check
  no series collapsed to a flat line (a scrape that silently broke).
- **Privacy-layer flows** — each series should *extend*, not jump: compare the
  new `privacy-flows.json` against the previous folder's and check that
  months before the current one are **unchanged**. They are recomputed from a
  cache that only grows, so a shifted past month means the reader changed
  behaviour, not that the chain did.
- **Railgun/Tornado/PP scope tells** — Railgun months in the tens of millions
  across 3 chains, Tornado whole-numbered (denomination x count, so a month
  ending in cents is a bug), PP the smallest of the three. A protocol that drops
  to zero is a failed chain, not a quiet month: all of Railgun's chains must
  succeed or the run fails.
- **Blacklist value / counts** — no fixed figures here on purpose. Both are
  cumulative and both moved when the reader changed (Dune's June USDT $1.60B was
  ~$718M high; Solana left the counts in 2026-09), so a named number here goes
  stale and then reads as a failure. Check direction and continuity instead:
  values advance, counts never decrease, neither jumps by orders of magnitude.
- **Fiat rails** (if appended): both per-day lines land near the **fiat ceiling
  ≈0.8B tx/day** (Jun-quarter 2026 Visa ~788M; Aug 2026 UPI ~791M). UPI ≫ Visa per-day only
  recently; both dwarf every privacy/agent line by 3+ orders of magnitude — that
  gap *is* the point of the chart.

## Adding or editing a source / query

- **Non-Dune source:** add a `fetch*` + a `safe(...)` entry in the Promise.all,
  a write/`carryForward` block, and a row to the Sources table above.
- **On-chain reader:** add a `scripts/<name>.js` exporting `fetch<Name>(cacheFile)`
  over `evm-logs.js`, a `cache/<name>.json`, a `safe(...)` entry in the
  Promise.all, a write/`carryForward` block, and a row in the Sources table.
  **Check it against `baselines/dune-2026-09-15/` before trusting it**, and
  record what matched — a script running without error verifies nothing.
- **Dune is retired.** Don't add a query; the free plan is view-only and the
  Plus trial lapses ~2026-09-24. `queries/*.sql` stay as history only.
