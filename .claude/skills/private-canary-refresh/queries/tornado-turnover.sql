-- Tornado Cash stablecoin turnover — FULL per-month history (our own query)
--
-- Uses Dune's curated tornado_cash.deposits / withdrawals spellbook tables
-- (Ethereum) — cheap, so recompute the whole series each refresh, no prefix-
-- cache. Gross turnover = deposits + withdrawals, per month. The curated
-- `amount` column is ALREADY in human token units (confirmed: a 100k-DAI
-- deposit shows amount = 100000.0, not raw wei), so NO /10^decimals and NO
-- price join — for DAI/USDC/USDT, summed token units ≈ USD. Per-month
-- (non-cumulative) so it merges uniformly with Railgun + PP.
--
-- Stablecoin contracts (Ethereum): filtered directly, so no tokens.erc20 join.
--   DAI  0x6b175474e89094c44da98b954eedeac495271d0f
--   USDC 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48
--   USDT 0xdac17f958d2ee523a2206206994597c13d831ec7

with flows as (
  select date_trunc('month', block_time) as block_month, currency_contract, amount
  from tornado_cash.deposits
  where blockchain = 'ethereum'
  union all
  select date_trunc('month', block_time) as block_month, currency_contract, amount
  from tornado_cash.withdrawals
  where blockchain = 'ethereum'
)
select
  block_month,
  round(sum(cast(amount as double)), 2) as trn_usd
from flows
where currency_contract in (
  0x6b175474e89094c44da98b954eedeac495271d0f, -- DAI
  0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48, -- USDC
  0xdac17f958d2ee523a2206206994597c13d831ec7  -- USDT
)
group by 1
order by 1
