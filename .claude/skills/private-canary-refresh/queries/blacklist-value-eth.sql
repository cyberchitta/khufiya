-- Stablecoin frozen value — current USDC/USDT balance held by blacklisted addrs
--
-- ⚠ BEST-EFFORT. If it exceeds the 2-min cap, DROP IT — the counts query alone
-- makes the point (USDC 639 / USDT 2,972 blacklisted).
-- Columns confirmed from the spellbook: tokens_ethereum.balances has `balance`
-- (decimal-adjusted ≈ USD for stablecoins) and `block_time` (one row per balance
-- change → take the latest per address+token).
-- Address extraction differs by token: USDC's _account is INDEXED (topic1);
-- USDT's _user is NOT indexed (in data). Handled by the CASE below.
--
-- Filtering balances to the (small) blacklisted set early keeps it from scanning
-- every USDC/USDT holder.

with blacklisted as (
  select distinct
    case
      when contract_address = 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48
        then bytearray_substring(topic1, 13, 20) -- USDC: indexed → topic1
      else bytearray_substring(data, 13, 20)     -- USDT: not indexed → data
    end as addr,
    contract_address as token
  from ethereum.logs
  where (
      contract_address = 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48
      and topic0 = 0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855
    )
    or (
      contract_address = 0xdac17f958d2ee523a2206206994597c13d831ec7
      and topic0 = 0x42e160154868087d6bfdc0ca23d96a1c1cfa32f1b72ba9ba27b69b98a0d819dc
    )
),
bal as (
  -- tokens_ethereum.balances is one row per balance change; take the latest per
  -- (address, token). Columns: balance (decimal-adjusted), block_time.
  select
    address,
    token_address,
    balance,
    row_number() over (partition by address, token_address order by block_time desc, block_number desc) as rn
  from tokens_ethereum.balances
  where token_address in (
      0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48,
      0xdac17f958d2ee523a2206206994597c13d831ec7
    )
    and address in (select addr from blacklisted)
)
select
  case b.token
    when 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48 then 'USDC'
    when 0xdac17f958d2ee523a2206206994597c13d831ec7 then 'USDT'
  end as token,
  count(distinct b.addr) as blacklisted_addresses,
  round(sum(coalesce(l.balance, 0)), 2) as frozen_usd
from blacklisted b
left join bal l
  on l.address = b.addr
  and l.token_address = b.token
  and l.rn = 1
group by 1
order by 1
