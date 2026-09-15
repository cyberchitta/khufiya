-- Stablecoin blacklist counts — new blacklisted addresses per month (Ethereum)
--
-- The §7 taint backdrop (downgraded, so this is context not load-bearing). Counts
-- the freeze events; pcData cumulates → running total of addresses ever
-- blacklisted. Cheap event scan. Counts ADDED only (removals are rare and not
-- netted — the reported "N blacklisted addresses" figure is cumulative adds).
--
-- USDC 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48  Blacklisted(address)
--      topic0 0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855
-- USDT 0xdac17f958d2ee523a2206206994597c13d831ec7  AddedBlackList(address)
--      topic0 0x42e160154868087d6bfdc0ca23d96a1c1cfa32f1b72ba9ba27b69b98a0d819dc

select
  date_trunc('month', block_time) as block_month,
  count(*) filter (where contract_address = 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48) as usdc_blacklisted,
  count(*) filter (where contract_address = 0xdac17f958d2ee523a2206206994597c13d831ec7) as usdt_blacklisted
from ethereum.logs
where (
    contract_address = 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48
    and topic0 = 0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855
  )
  or (
    contract_address = 0xdac17f958d2ee523a2206206994597c13d831ec7
    and topic0 = 0x42e160154868087d6bfdc0ca23d96a1c1cfa32f1b72ba9ba27b69b98a0d819dc
  )
group by 1
order by 1
