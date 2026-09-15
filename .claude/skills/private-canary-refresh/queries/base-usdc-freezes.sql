-- Base USDC freeze watcher — CyberChitta "private-canary" tracker
--
-- USDC (native, Circle) `Blacklisted` events on Base. Turns the page's
-- hand-asserted "agent-wallet freezes: zero" into a live instrument.
-- ATTRIBUTION CAVEAT: this detects *Base USDC freezes*, not "agent freezes".
-- Honest phase-1 framing on the page: "Base USDC freezes: N; none yet linked
-- to agent activity."
--
-- Contract: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
--           (FiatTokenProxy — native USDC on Base mainnet, Circle-issued)
-- Event:    Blacklisted(address indexed _account)
--   topic0  0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855
--           (keccak256 of "Blacklisted(address)", from 4byte.directory)
--
-- Each row = one address-freeze event. We return event-level rows (the set is
-- small — freezes are rare) and roll them up to a count / cumulative series at
-- build time in pcData.js. Uses raw base.logs rather than a decoded table so
-- the query has no decode-namespace dependency.

select
  l.block_time,
  l.block_number,
  l.tx_hash,
  -- _account is indexed, so it rides in topic1 (a 32-byte word). The address
  -- is the rightmost 20 bytes: bytearray_substring is 1-indexed, 32-20+1 = 13.
  bytearray_substring(l.topic1, 13, 20) as blacklisted_address
from base.logs l
where l.contract_address = 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913
  and l.topic0 = 0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855
order by l.block_time

-- ---------------------------------------------------------------------------
-- OPTIONAL variant — track net freezes (include UnBlacklisted removals).
-- An address can be removed from the blacklist; the version above counts
-- freeze *events* (the signal we watch). If you'd rather track currently-
-- frozen addresses, swap in the block below instead:
--
-- select
--   l.block_time,
--   l.block_number,
--   l.tx_hash,
--   case l.topic0
--     when 0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855 then 'blacklisted'
--     when 0x117e3210bb9aa7d9baff172026820255c6f6c30ba8999d1c2fd88e2848137c4e then 'unblacklisted'
--   end as event,
--   bytearray_substring(l.topic1, 13, 20) as account
-- from base.logs l
-- where l.contract_address = 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913
--   and l.topic0 in (
--     0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855,
--     0x117e3210bb9aa7d9baff172026820255c6f6c30ba8999d1c2fd88e2848137c4e
--   )
-- order by l.block_time
