-- USDT blacklist counts on Tron — new blacklisted addresses per month
--
-- Companion to dune-blacklist-counts.sql (Ethereum). USDT's blacklist is
-- per-contract, per-chain: an AddedBlackList on Ethereum does nothing to the
-- Tron contract, and Tron carries ~84% of USDT freezes by address count
-- (BlockSec, 2025). So the honest USDT taint figure is Ethereum + Tron; the
-- fetch script merges this month-series onto the Ethereum one by month.
--
-- Tron USDT contract TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t uses the same Tether
-- code as Ethereum, so it emits AddedBlackList(address _user). Dune decodes it
-- into a single-contract table, so no contract/topic filter is needed — the
-- table IS this contract's blacklist-add events. Counts ADDED only (removals
-- not netted), matching the Ethereum query.
--
-- Decoded table: tether_tron.tether_usd_evt_addedblacklist
--   evt_block_time — event timestamp
--   _user          — the blacklisted address (not needed for counts)

select
  date_trunc('month', evt_block_time) as block_month,
  count(*) as usdt_blacklisted
from tether_tron.tether_usd_evt_addedblacklist
group by 1
order by 1
