import { promises as fs } from 'fs';
import { makeRpc, scanLogs, readCache as readEventCache } from './evm-logs.js';

// Privacy Pools (0xbow) stablecoin turnover, read from the chain — replaces
// Dune query 7714910. Per-month gross turnover = stablecoin transfers in + out
// of the PP contracts (DAI/USDC/USDT are ~$1, so units ≈ USD).
//
// Stablecoins are matched by CONTRACT ADDRESS, not by symbol. Dune joined
// tokens.erc20 on `upper(symbol) in ('USDC','USDT','DAI')`, which sweeps in any
// token that merely calls itself USDC — and two counterfeits sit in PP's
// history: 0x32857f58… ($50, 2026-01) and 0x18042f88… ($1,318.68, 2026-03).
// Those two are the whole difference from 7714910; the other 13 of 15 months
// match to the cent. Verified 2026-09-16. (A homoglyph 'ꓴꓢꓓС' token is also
// present; Dune missed it because its symbol is not literally 'USDC'.)

const rpc = makeRpc(process.env.ETH_RPC_URL || 'https://gateway.tenderly.co/public/mainnet');

// Transfer(address indexed from, address indexed to, uint256 value)
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const SCAN_FROM = 21_900_000; // ~2025-03, before PP's first stablecoin flow
const LOG_SPAN = 2_000_000;
const CONFIRMATIONS = 64;

const STABLECOINS = {
  '0x6b175474e89094c44da98b954eedeac495271d0f': 18, // DAI
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 6, // USDC
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 6, // USDT
};

// ⚠ Still not formally confirmed on Etherscan — carried over from the Dune
// query, where the same caveat stood. The growth curve is coherent and the
// series reproduces 7714910, which is evidence but not confirmation.
const CONTRACTS = [
  '0x6818809eefce719e480a7526d76bd3e561526b46', // entrypoint
  '0xf241d57c6debae225c0f2e6ea1529373c9a9c9fb', // pool
];

const topicAddress = (address) => '0x' + address.slice(2).padStart(64, '0');

// Cache: {scannedThrough, tokens: [address, ...], events: [[block, logIndex,
// unix seconds, tokenIndex, raw value], ...]}.
//
// The token is stored as an index into `tokens`, not as the address — the same
// format the Railgun and Tornado caches use, where spelling the address out on
// every row was over half the file. The list is written into the cache rather
// than read from STABLECOINS so the file stays self-describing and survives
// that map being reordered.
const TOKEN_LIST = Object.keys(STABLECOINS);

// Log -> [block, logIndex, unix seconds, tokenIndex, raw value as decimal string]
function toEvent(log) {
  return [
    parseInt(log.blockNumber, 16),
    parseInt(log.logIndex, 16),
    parseInt(log.blockTimestamp, 16),
    TOKEN_LIST.indexOf(log.address.toLowerCase()),
    BigInt(log.data.slice(0, 66)).toString(),
  ];
}

export const readCache = (file) => readEventCache(file, SCAN_FROM);

export async function writeCache(file, cache) {
  const lines = cache.events.map((e) => JSON.stringify(e)).join(',\n');
  await fs.writeFile(
    file,
    `{"scannedThrough":${cache.scannedThrough},"tokens":${JSON.stringify(TOKEN_LIST)},"events":[\n${lines}\n]}\n`
  );
}

export async function scanFlows(cache) {
  const head = parseInt(await rpc('eth_blockNumber', []), 16) - CONFIRMATIONS;
  if (cache.scannedThrough >= head) return cache;
  const from = cache.scannedThrough + 1;
  const tokens = Object.keys(STABLECOINS);
  const parties = CONTRACTS.map(topicAddress);
  // Two passes, because `from` and `to` are separate topic positions. A transfer
  // between two PP contracts matches both, so they are deduped on (block, index)
  // — Dune's single OR counted such a row once too.
  const [inbound, outbound] = await Promise.all([
    scanLogs(rpc, { address: tokens, topics: [TRANSFER, null, parties] }, from, head, { span: LOG_SPAN, concurrency: 2 }),
    scanLogs(rpc, { address: tokens, topics: [TRANSFER, parties] }, from, head, { span: LOG_SPAN, concurrency: 2 }),
  ]);
  const unique = new Map();
  for (const log of [...inbound, ...outbound]) unique.set(`${log.blockNumber}:${log.logIndex}`, log);
  const events = [...unique.values()].map(toEvent).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { scannedThrough: head, events: [...cache.events, ...events] };
}

// Cached events -> ascending [[YYYY-MM-01, turnover], ...]. `before` (unix
// seconds) stops the count early, for comparing against a Dune execution that
// only saw the chain up to its own indexing head.
export function monthlyTurnover(cache, { before = Infinity } = {}) {
  const months = new Map();
  const tokens = cache.tokens ?? TOKEN_LIST;
  for (const [, , time, tokenIndex, raw] of cache.events) {
    if (time >= before) continue;
    const value = Number(BigInt(raw)) / 10 ** STABLECOINS[tokens[tokenIndex]];
    const month = `${new Date(time * 1000).toISOString().slice(0, 7)}-01`;
    months.set(month, (months.get(month) ?? 0) + value);
  }
  return [...months.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([m, v]) => [m, Math.round(v * 100) / 100]);
}

export { CONTRACTS, STABLECOINS };

export async function fetchPrivacyPoolsFlows(cacheFile) {
  const cache = await scanFlows(await readCache(cacheFile));
  await writeCache(cacheFile, cache);
  return { scannedThrough: cache.scannedThrough, monthly: monthlyTurnover(cache) };
}
