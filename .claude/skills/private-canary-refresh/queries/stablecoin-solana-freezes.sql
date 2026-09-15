-- Stablecoin freeze counts on Solana — frozen token accounts per month
--
-- Third chain in the multi-chain taint picture (Ethereum + Tron + Solana ≈ all
-- real stablecoin freeze activity). Solana's mechanic is DIFFERENT from the EVM
-- chains: there's no blacklist mapping. The issuer holds the SPL mint's freeze
-- authority and freezes individual token ACCOUNTS via a FreezeAccount
-- instruction (e.g. Circle's $58M Libra freeze). So we count FreezeAccount
-- instructions whose mint is USDC / USDT.
--
-- UNIT CAVEAT: this counts frozen *token accounts*, not wallets — one wallet can
-- hold several token accounts. The EVM queries count blacklisted wallet
-- addresses. Close enough for the §7 taint backdrop (downgraded), but not a
-- like-for-like address count; note it if the number is surfaced precisely.
--
-- ⚠ VERIFY ON FIRST RUN (table + column names are Dune-convention best-guess,
-- not confirmed against the catalog — like the Privacy Pools query was). If the
-- decoded table/columns differ, adjust; raw-instruction fallback is at the foot.
--   USDC mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
--   USDT mint Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB
--   SPL Token program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA

select
  date_trunc('month', call_block_time) as block_month,
  count(*) filter (where account_mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') as usdc_frozen,
  count(*) filter (where account_mint = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') as usdt_frozen
from spl_token_solana.spl_token_call_FreezeAccount
where account_mint in (
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
  )
group by 1
order by 1

-- ---------------------------------------------------------------------------
-- FALLBACK if the decoded table/columns above don't resolve — count raw
-- FreezeAccount calls off solana.instruction_calls. FreezeAccount is SPL Token
-- instruction discriminator 10; in the accounts array index 0 is the frozen
-- account, index 1 is the mint, index 2 is the freeze authority. Filter on the
-- mint at accounts[2] (1-indexed in SQL):
--
-- select
--   date_trunc('month', block_time) as block_month,
--   count(*) filter (where account_arguments[2] = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') as usdc_frozen,
--   count(*) filter (where account_arguments[2] = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') as usdt_frozen
-- from solana.instruction_calls
-- where executing_account = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
--   and bytearray_substring(from_base58(data), 1, 1) = 0x0a  -- FreezeAccount = 10
--   and account_arguments[2] in (
--     'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
--     'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
--   )
-- group by 1
-- order by 1
