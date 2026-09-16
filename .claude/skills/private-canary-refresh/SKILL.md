---
name: private-canary-refresh
description: Refresh runbook + version-controlled query catalog for ALL of the private-canary page's data (x402scan, Blockchair, ZecHub, bitinfocharts, CoinGecko, Coin Metrics, DefiLlama, and the Dune layer). Use when refreshing the page's data, adding/editing a source or Dune query, or debugging fetch-pc-stats. Holds the canonical Dune .sql in queries/; the Dune results they must be replaced by are in baselines/.
user-invocable: true
---

# private-canary-refresh

Everything behind the `private-canary` page's data. One command fetches every
source; this skill is its runbook + the version-controlled home for the Dune
query definitions (the live queries are owned by the Showrunner's Dune account;
`queries/` here is the only tracked copy).

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
- **Keyless is the default.** No `DUNE_API_KEY` → every Dune series `[skip]`s and
  carries forward; all the other sources are keyless and still run. Keyed builds
  get the richer Dune layer.

## Sources

| source | feeds | notes / fragility |
|---|---|---|
| **x402scan** tRPC `public.stats.overall` + `.bucketed` | x402 snapshot + `x402-series.json` | unofficial/unversioned — schema pinned to github.com/Merit-Systems/x402scan. Bucketed = daily buckets for full history; partial current day dropped |
| **Blockchair** `/{monero,zcash}/stats` | chain stats in `snapshots.json` | keyless 1,440/day. Monero has no `transactions_24h`; ZEC `circulation` field is broken — **never use** |
| **ZecHub** raw JSON (ZecHub/zechub-wiki `public/data/zcash/`) | `zcash-series.json` (shielded supply + shielded tx/day) | ~daily commits; dates MM/DD/YYYY with stray ISO rows. **Pools are read from the file's keys, not hardcoded** — Ironwood (NU6.3, 2026-07-28) arrived as a fourth key and a fixed Sprout/Sapling/Orchard list undercounted shielded tx ~5× until 2026-09-15. **Best free source for ZEC shielded data** — checked 2026-06-13: Dune doesn't index Zcash; Coin Metrics keeps shielded metrics Pro-only (community tier has none). **`fetchZcashSeries` splices** the long history: `transaction_summary.json` (Sapling+Orchard counts keyed by block *height*, back to Sapling activation ~Oct 2018) for the prefix, height→date mapped via `blockFeesZEC.json` (which carries Block+Date anchors, ~1-day accuracy), then the precise date-native `shieldedtxcount.json` for the recent tail. Tail's first row (2024-09-05) is an anomalous seed value (orchard 0, sapling ~2×) — harmless, the chart's 30-day smoothing washes it out. shielded *supply* (`shielded_supply.json`) is full from 2017. |
| **bitinfocharts** scrape (6 pages) | `market-series.json` (XMR/ZEC price+mcap, BTC tx/day) + `monero-tx-series.json` (XMR tx/day + avg fee) | **fragile** — regex on page JS; sanity-checks ≥1000 pts, fails soft; intraday current-day point dropped |
| **CoinGecko** keyless | current prices, mcaps, privacy-coins category, global (snapshot) | ~30/min, rate-limits on rapid reruns. **History capped at 365d** — why market history rides bitinfocharts |
| **Coin Metrics** community API | `stablecoin-series.json` (USDT/USDC tx/day) | keyless; `usdt`/`usdc` are cross-chain aggregates; paginated `paging_from=start`, page cap as runaway guard |
| **DefiLlama** `/protocol/<slug>` | `onchain-privacy-series.json` (TVL railgun/tornado-cash/privacy-pools) | keyless, full daily history |
| **Dune Analytics** (3 queries, privacy-layer flows only) | `dune-privacy-flows.json` | the complex one — see **Dune sub-layer** below |
| **on-chain readers** (keyless) | `dune-base-freeze.json`, `dune-blacklist.json` | Base + Ethereum via `evm-logs.js`, Tron via TronGrid; file names kept from the Dune era because they are the site's input contract |
| **fiat rails** (hand-maintained seed) | `fiat-rails-series.json` (UPI monthly volume + Visa quarterly processed tx → the chart's "fiat ceiling") | **not fetched** — see **Fiat-rails baseline** below |

`events.json` (the timeline) is **hand-curated, top-level, never written by the
script.** Source-verify new entries before publish (Showrunner-gated).

`fiat-rails-series.json` is the **second hand-maintained file** — same spirit as
`events.json`, but it *is* per-folder: the canonical copy lives at
`data/fiat-rails-series.json` (this repo) and `seedForward()` copies
it into each dated folder so it caches/resolves like the fetched series. See
**Fiat-rails baseline** below.

## Dune sub-layer

### The one hard constraint

**As of 2026-09-10 the free plan is view-only** — no runs at all, and API reads
spend credits. The 2026-09-15 refresh ran on the Plus trial (still a 2-minute
cap); after it there is no Dune path, and these series move to the `khufiya`
repo, read directly from the chains. Until then, the mechanics were:

> **Showrunner clicks Run on each query in the Dune editor → `fetch-pc-stats`
> reads the freshly-cached results.**

The client reads only: `GET /v1/query/{id}/results`, header `X-Dune-API-Key`,
`next_uri` pagination, throws on a missing key/id or an unfinished execution. It
never executes. `DUNE_STALE_AFTER_DAYS = 45` → a stale cached run logs `[STALE]`
(re-Run it). Query ids are public → live in `DUNE_QUERIES` in the fetch script,
not `.env`. Only the key is in `.env` (khufiya's own, gitignored). Editor save names: `cyberchitta — <what>`.

### Query catalog

All DuneSQL (Trino) — set the editor engine to DuneSQL, not legacy Spark/v1.

| key | id | Dune name | queries/ file | feeds |
|---|---|---|---|---|
| `railgunTurnover` | 7714782 | railgun turnover (recent) | `railgun-turnover-recent.sql` | flows railgun (suffix, `{{since}}`) |
| `tornadoTurnover` | 7714895 | tornado turnover | `tornado-turnover.sql` | flows tornado (full) |
| `privacyPools` | 7714910 | privacy pools turnover | `privacy-pools-turnover.sql` | flows privacyPools (full) |

**Per-query notes**

- **Railgun is prefix + suffix.** The repo holds the per-month history; each
  refresh recomputes only recent months. Set `{{since}}` ~3 months back before
  Running 7714782 (a 3-month, 4-chain window runs ~1:20). The prefix was seeded
  **once** from AMLBot 6702283 de-cumulated (`seed-privacy-flows.mjs`); don't
  re-seed unless re-bootstrapping. Merge = replace overlap + append.
- **Tornado / Privacy Pools** — cheap full per-month queries, just Run.
  Tornado: curated `tornado_cash.*` `amount` is already human-units (do **not**
  `/power(10,decimals)`); filter the three stablecoin addresses directly.
- **Privacy Pools contracts unverified** (entrypoint `0x6818…6b46`, pool
  `0xf241…c9fb`) — coherent growth curve so likely right, but **confirm on
  Etherscan before publish**. Magnitude ~$27M lifetime.
- **Base freeze is on-chain, not Dune** (`scripts/base-usdc-freezes.js`,
  keyless): event rows rolled up in `pcData.js`; 0 new rows is a *real* reading
  (the canary), not an error. History cached in `cache/base-usdc-blacklist.json`
  (commit it with the refresh). Base RPCs cap log ranges at 1–2k blocks, so a
  lost cache means a ~40-min rescan.
- **Multi-chain blacklist, now Eth + Tron only.** Blacklisting is per-contract-
  per-chain; Tron carries ~71% of all-time USDT freezes. `counts.usdt =
  Eth + Tron`, `counts.usdc = Eth` alone (Circle dropped Tron in 2024);
  `counts.chains` records each chain's read head. **Both are required** — with
  only two sources, one missing chain would publish a total short by most of it,
  so a failure carries the previous total forward rather than writing a partial.
  No Dune query feeds the blacklist any more. **Frozen value is Ethereum-only**
  — so a quoted value is Eth-scope while the USDT count is two-chain; phrase
  honestly.
- **Solana is out of scope (owner decision, 2026-09-16)** — the counts are
  Eth + Tron and the page should say so. It was ~21 USDC / ~25 USDT all-time
  (~2% of the total), so dropping it moves the published count down slightly.
  Why it cannot be rebuilt keylessly, measured 2026-09-16: Solana has no log
  index, so there is no `eth_getLogs` equivalent — freezes are SPL
  `FreezeAccount` instructions and must be found by walking an account's
  transactions. Circle's freeze authority `7dGbd2QZ…` works (27 signatures, 17
  freezes + 4 thaws, parsed cleanly) but the public RPC serves **nothing before
  2024-08-20**, and 7 of the 21 USDC freezes predate that. Tether's freeze
  authority `Q6Xprfk…` is not a dedicated key: its most recent 1,000 signatures
  span **seven weeks** (2026-07-12 → 2026-08-31) with zero freezes in the first
  340 parsed, so reaching 2020 means paging hundreds of thousands of
  transactions at the ~1.4 tx/s the public RPC tolerates. Every keyless
  alternative (Helius, Solscan, SolanaFM, Flipside) needs an API key, which the
  no-paid-source constraint forbids. `stablecoin-solana-freezes.sql` and 7715332
  are kept only as history — and 7715332 never returned a result anyway
  (2-minute timeout, the `FAILED` file in `baselines/`).
- **Ethereum blacklist is on-chain, not Dune**
  (`scripts/eth-stablecoin-blacklist.js`, keyless): one scan of the add/remove
  events feeds both the monthly counts (replacing 7714982) and `balanceOf` of
  still-blacklisted addresses (replacing 7714984), so the two cannot disagree.
  Event history cached in `cache/eth-stablecoin-blacklist.json` (commit it with
  the refresh). Counts are ADD events, not distinct addresses — a re-blacklisted
  address counts again and removals are not netted, which is what 7714982 did
  and what the page's cumulative "ever blacklisted" figure means. 7714984's
  balance table kept USDT burned by `destroyBlackFunds` — June's $1.60B was
  ~$718M high; `blacklist-value-eth.sql` and `blacklist-counts-eth.sql` are kept
  only as history. `taint-watch` keeps Base USDC freezes as a separate line (not
  in the USDC aggregate → no double-count).
- **Tron USDT blacklist is TronGrid, not Dune**
  (`scripts/tron-usdt-blacklist.js`, keyless): Tron is not EVM-RPC, so
  `evm-logs.js` does not apply — TronGrid's event API pages through a
  `fingerprint` cursor and returns block timestamps inline. Replaced 7715354
  (`usdt-tron-blacklist.sql` kept only as history). History cached in
  `cache/tron-usdt-blacklist.json` (commit it with the refresh); a lost cache
  costs a ~4-min reseed, not an hour.

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

1. In Dune, open each catalog query and **Run** it. For `railgunTurnover` set
   `{{since}}` ~3 months back first. Optionally append any new UPI month / Visa
   quarter to `fiat-rails-series.json` (see **Fiat-rails baseline**) — it's not
   tied to the refresh cadence, append whenever new figures land.
2. `bun run fetch-pc-stats` (needs `DUNE_API_KEY` in `.env` for the Dune layer).
3. Eyeball the log for `[FAIL]` (a dead source — carried forward) and `[STALE]`
   (a Dune query you forgot to re-Run). **Carry-forward reads only an *earlier*
   dated folder, and the first run of the day deletes it** — so a same-day rerun
   silently drops every series that fails, and the Railgun suffix loses its
   prefix. Fix the source, don't rerun; or restore from git (`HEAD:raw/<old>/`).
4. Verify the cross-checks below, then `bun run build` in the site repo + commit
   in both repos (human-gated).

## Validation cross-checks (after a refresh, before committing)

- **x402 / market / TVL series** — `stats.updated` advanced to today; spot-check
  no series collapsed to a flat line (a scrape that silently broke).
- **Railgun** suffix vs AMLBot 6702283 de-cumulated → ~0.03% on complete months.
- **Tornado** vs 6702295 de-cumulated → 1.000 on complete months.
- **Privacy Pools** magnitude ~single-digit-million/mo, lifetime ~$27M.
- **Blacklist counts** cumulative: USDC ≈ 660 (Eth 639 + Sol 21), USDT ≈ 10,326
  (Eth 2,972 + Tron 7,329 + Sol 25) at 2026-06-13; 907 / 11,567 at 2026-09-15,
  Solana frozen at 2026-05 (its query times out). Grows over time.
- **Blacklist value** (Ethereum snapshot): ~$120M USDC / ~$1.6B USDT.
- **Fiat rails** (if appended): both per-day lines land near the **fiat ceiling
  ≈0.8B tx/day** (Jun-quarter 2026 Visa ~788M; Aug 2026 UPI ~791M). UPI ≫ Visa per-day only
  recently; both dwarf every privacy/agent line by 3+ orders of magnitude — that
  gap *is* the point of the chart.

## Adding or editing a source / query

- **Non-Dune source:** add a `fetch*` + a `safe(...)` entry in the Promise.all,
  a write/`carryForward` block, and a row to the Sources table above.
- **Dune query:** edit/add the `.sql` in `queries/` (canonical) and mirror it
  into the Dune editor (Run, Save). Add the id to `DUNE_QUERIES` (comment: shape
  + file), a key-guarded `safe(...)` fetch, an assembly step, carry-forward.
  Write the row-mapper **only after** a real Run exists (probe columns via the
  API first — forked/new queries have no knowable columns up front). Add a
  validation cross-check. Update the catalog table here.
