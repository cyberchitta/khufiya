-- Privacy Pools (0xbow) stablecoin turnover — FULL per-month (our own query)
--
-- No curated spellbook for Privacy Pools, so we scan raw erc20 transfers to/from
-- the PP contracts. PP launched 2025-03-31 and is small (~$6M lifetime, ETH +
-- wBTC + stablecoins), so we bound the scan from launch and recompute the whole
-- (short) series each refresh — cheap enough, no prefix-cache. Gross turnover =
-- transfers in + out, per month, stablecoin face value ≈ USD. Per-month so it
-- merges uniformly with Railgun + Tornado.
--
-- ⚠ UNVERIFIED CONTRACTS — confirm on Etherscan before trusting output, and
-- sanity-check the run: PP stablecoin turnover should be small (single-digit
-- millions/month at most). Empty result or absurd magnitude => wrong addresses.
--   entrypoint 0x6818809EefCe719E480a7526D76bD3e561526b46
--   pool       0xf241d57c6debae225c0f2e6ea1529373c9a9c9fb
-- If addresses change/expand, add them to the in/out lists below.

with pp as (
  select contract_address, evt_block_time, "value"
  from erc20_ethereum.evt_transfer
  where (
      "to" in (0x6818809eefce719e480a7526d76bd3e561526b46, 0xf241d57c6debae225c0f2e6ea1529373c9a9c9fb)
      or "from" in (0x6818809eefce719e480a7526d76bd3e561526b46, 0xf241d57c6debae225c0f2e6ea1529373c9a9c9fb)
    )
    and evt_block_time >= timestamp '2025-03-01 00:00:00'
)
select
  date_trunc('month', pp.evt_block_time) as block_month,
  round(sum(cast(cast(pp."value" as decimal(38, 0)) as double) / power(10, t.decimals)), 2) as trn_usd
from pp
join tokens.erc20 t
  on t.blockchain = 'ethereum'
  and t.contract_address = pp.contract_address
where upper(t.symbol) in ('USDC', 'USDT', 'DAI')
group by 1
order by 1
