# Dune baselines, 2026-09-15

Raw `GET /v1/query/{id}/results` responses for the eight private-canary queries,
saved the day they ran on the Dune Plus trial (the free plan went view-only on
2026-09-10). An on-chain reader replaces a query only after reproducing its
result here month for month. SQL for each is in
`.claude/skills/private-canary-refresh/queries/`.

| file | query | state |
|---|---|---|
| `baseFreeze-7714703.json` | Base USDC `Blacklisted` events | 589 rows |
| `railgunTurnover-7714782.json` | Railgun stablecoin turnover, recent suffix | 7 rows (2026-03 on) |
| `tornadoTurnover-7714895.json` | Tornado Cash stablecoin turnover | 81 rows |
| `privacyPools-7714910.json` | Privacy Pools stablecoin turnover | 15 rows |
| `blacklistCounts-7714982.json` | Ethereum USDC + USDT blacklist adds per month | 87 rows |
| `usdtTronBlacklist-7715354.json` | Tron USDT blacklist adds per month | 68 rows |
| `stablecoinSolanaFreezes-7715332.json` | Solana USDC/USDT `FreezeAccount` | FAILED: 2-minute timeout |
| `blacklistValue-7714984.json` | Ethereum frozen balances | FAILED: Dune's `tokens_ethereum.balances` view is broken |

These are the only copy of the per-chain split: the site's `dune-blacklist.json`
stores cross-chain sums.

**Solana was dropped from the counts on 2026-09-16 (owner decision).** No
keyless source serves its `FreezeAccount` history — the reasons are measured and
recorded in the `private-canary-refresh` runbook. `stablecoinSolanaFreezes-7715332.json`
was the only baseline that could have checked it, and it never returned a
result. The published counts are now USDC: Ethereum; USDT: Ethereum + Tron.

`june-2026-06-13-dune-blacklist.json` is the site file from the June refresh.
It holds the last good frozen-value snapshot (USDC $120.2M / 587 addresses, USDT
$1.60B / 2,962) and the cross-chain counts that included Solana. Solana's
history through 2026-05 was recovered as those totals minus this run's Ethereum
and Tron months: USDC 21, USDT 24 (June's own note said 25; the missing one is
presumably in 2026-06-01..13). No month came out negative.
