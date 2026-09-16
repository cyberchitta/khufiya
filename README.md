# khufiya

Metrics read directly from public blockchains and public data feeds, for the
[private-canary](https://www.cyberchitta.cc/articles/private-canary/) tracker
on cyberchitta.cc. Every figure on that page can be recomputed from here
without trusting us.

_Khufiya_ (Hindustani): secret; also the word for intelligence work.

## What it produces

One refresh writes a dated, immutable data folder into the site repo
(`../www.cyberchitta.cc/src/assets/data/privacy-coins/raw/<YYMMDD>/`) and moves
the pointer the site builds from. The series, and where each comes from:

- **x402** transactions, settled volume, buyers and sellers, daily
  ([x402scan](https://github.com/Merit-Systems/x402scan)), plus the distance
  below the all-time trailing-30-day peak, computed here on one window.
- **Monero** transactions and fees, **Zcash** shielded supply and shielded
  transactions across all four pools (Blockchair, bitinfocharts, ZecHub).
- **USDT / USDC** transaction counts (Coin Metrics community API).
- **Prices, market caps, privacy-protocol TVL** (CoinGecko, bitinfocharts,
  DefiLlama).
- **Privacy-layer stablecoin turnover**: Railgun on Ethereum, Polygon and
  Arbitrum; Tornado Cash and Privacy Pools on Ethereum. Read from the chains'
  own logs, stablecoins matched by contract address, never by symbol.
- **Stablecoin blacklists**: USDC and USDT blacklist counts on Ethereum and
  Tron, frozen value on Ethereum, USDC freezes on Base. Read from the chains.
- **Visa and UPI** daily transactions, hand-maintained from published quarterly
  and monthly figures (`data/`).

Until September 2026 the turnover, blacklist and Base-freeze series were
computed on Dune Analytics. When Dune's free plan went view-only they were
rebuilt here from public RPCs and checked month for month against the last
Dune runs (`baselines/`). The article's Data Sources section records what
moved.

## Running it

```
bun install
bun run fetch-pc-stats
```

Keyless throughout: free public RPCs and keyless endpoints only, no `.env`.
Each source is fail-soft; one that is down is carried forward from the previous
folder and logged as `[FAIL]`. On-chain readers extend a cache in `cache/` from
the last block they saw rather than rescanning, so commit the cache with the
refresh. The refresh runbook and its cross-checks are the
`private-canary-refresh` skill in `.claude/skills/`.

## Layout

- `scripts/fetch-privacy-coin-stats.js`: the entry point; the header comment
  documents every output file.
- `scripts/*-flows.js`, `*-blacklist.js`, `base-usdc-freezes.js`: the on-chain
  readers, over `evm-logs.js`.
- `scripts/x402-peak.js`: the peak computation.
- `data/`: hand-maintained series. `cache/`: fetched history. `baselines/`:
  the Dune results the readers must reproduce.
