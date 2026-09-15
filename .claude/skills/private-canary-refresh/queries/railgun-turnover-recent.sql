-- Railgun stablecoin turnover — RECENT WINDOW (the "compute the suffix" half)
--
-- The prefix (older months) is cached in our repo; this query recomputes only
-- recent months so it stays under the free-tier 2-min cap. Our fetch script
-- splices these months onto the cached history.
--
-- Per-month GROSS turnover = all stablecoin transfers TO + FROM the Railgun
-- contracts (deposits + withdrawals), summed by month. Stablecoins are ~$1, so
-- face value ≈ USD — no price join needed (this is the big simplification over
-- @amlbot's full query, which joins prices.usd_latest for assets pegged to $1).
-- Output is NON-cumulative per month so the splice is trivial; we cumulate at
-- build time.
--
-- Railgun contracts (from @amlbot's query 6702283):
--   ethereum / arbitrum  0xfa7093cdd9ee6932b4eb2c9e1cde7ce00b1fa4b9
--   polygon              0x19b620929f97b7b990801496c3b361ca5def8c71
--   bnb                  0x590162bf4b50f6576a459b75309ee21d92178a10
--
-- {{since}} is a Dune text parameter (e.g. '2026-01-01'). Tune it: widen until
-- it nears 2 min, then back off. If 4 chains won't fit, drop to ethereum-only
-- (the bulk of Railgun stablecoin volume) and note the scope.

with rg as (
  select 'ethereum' as chain, contract_address, evt_block_time, "value"
  from erc20_ethereum.evt_transfer
  where ("to" = 0xfa7093cdd9ee6932b4eb2c9e1cde7ce00b1fa4b9 or "from" = 0xfa7093cdd9ee6932b4eb2c9e1cde7ce00b1fa4b9)
    and evt_block_time >= cast('{{since}}' as timestamp)
  union all
  select 'arbitrum', contract_address, evt_block_time, "value"
  from erc20_arbitrum.evt_transfer
  where ("to" = 0xfa7093cdd9ee6932b4eb2c9e1cde7ce00b1fa4b9 or "from" = 0xfa7093cdd9ee6932b4eb2c9e1cde7ce00b1fa4b9)
    and evt_block_time >= cast('{{since}}' as timestamp)
  union all
  select 'polygon', contract_address, evt_block_time, "value"
  from erc20_polygon.evt_transfer
  where ("to" = 0x19b620929f97b7b990801496c3b361ca5def8c71 or "from" = 0x19b620929f97b7b990801496c3b361ca5def8c71)
    and evt_block_time >= cast('{{since}}' as timestamp)
  union all
  select 'bnb', contract_address, evt_block_time, "value"
  from erc20_bnb.evt_transfer
  where ("to" = 0x590162bf4b50f6576a459b75309ee21d92178a10 or "from" = 0x590162bf4b50f6576a459b75309ee21d92178a10)
    and evt_block_time >= cast('{{since}}' as timestamp)
)
select
  date_trunc('month', rg.evt_block_time) as block_month,
  round(sum(cast(cast(rg."value" as decimal(38, 0)) as double) / power(10, t.decimals)), 2) as trn_usd
from rg
join tokens.erc20 t
  on t.blockchain = rg.chain
  and t.contract_address = rg.contract_address
where upper(t.symbol) in ('USDC', 'USDT', 'DAI')
group by 1
order by 1
