import { promises as fs } from 'fs';
import { hex, makeRpc, scanLogs, readCache as readEventCache } from './evm-logs.js';

// Tornado Cash stablecoin turnover, read from the chain — replaces Dune query
// 7714895. Per-month gross turnover = deposits + withdrawals, in token units
// (DAI/USDC/USDT are ~$1, so units ≈ USD).
//
// Counted from Tornado's OWN Deposit/Withdrawal events, not from ERC20
// transfers. Every Tornado instance is fixed-denomination, so turnover is
// exactly `denomination x event count` — integer arithmetic, no rounding, and
// nothing to misread. Scanning the token transfers instead gets two things
// wrong: stray tokens sent directly to an instance count as flow (worth +$10 in
// 2023-08 and +$92.52 in 2026-08 against Dune), and float accumulation puts
// cents on months that should be whole numbers.
//
// This is also what Dune's curated tornado_cash.deposits/withdrawals tables
// count, so the two definitions agree by construction.
//
// The instance set was derived on-chain, not copied from a list: scan every
// contract that ever emitted a Tornado Deposit, then ask each one token() and
// denomination(), and keep those holding DAI/USDC/USDT. That topic0 is also
// used by ~200 copycat contracts, so the survivors were pinned down by which
// set reproduces Dune 7714895 — the 10 below, which are the canonical Tornado
// stablecoin instances. Verified 2026-09-16: 81/81 months exact.

const rpc = makeRpc(process.env.ETH_RPC_URL || 'https://gateway.tenderly.co/public/mainnet');

// Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp)
const DEPOSIT = '0xa945e51eec50ab98c161376f0db4cf2aeba3ec92755fe2fcd388bdbbb80ff196';
// Withdrawal(address to, bytes32 nullifierHash, address indexed relayer, uint256 fee)
const WITHDRAWAL = '0xe9e508bad6d4c3227e881ca19068f099da81b5164dd6d62b2eaf1e8bc6c34931';

const SCAN_FROM = 8_900_000; // before the first ERC20 instance (Dec 2019)
const LOG_SPAN = 2_000_000; // the public gateway's getLogs cap
const CONFIRMATIONS = 64;

// instance -> [token, denomination in whole token units]. Denominations are
// whole numbers, so turnover stays exact integer arithmetic end to end.
const INSTANCES = {
  '0xd4b88df4d29f5cedd6857912842cff3b20c8cfa3': ['dai', 100n],
  '0xf60dd140cff0706bae9cd734ac3ae76ad9ebc32a': ['dai', 1000n],
  '0xfd8610d20aa15b7b2e3be39b396a1bc3516c7144': ['dai', 1000n],
  '0x07687e702b410fa43f4cb4af7fa097918ffd2730': ['dai', 10000n],
  '0x23773e65ed146a459791799d01336db287f25334': ['dai', 100000n],
  '0xd96f2b1c14db8458374d9aca76e26c3d18364307': ['usdc', 100n],
  '0x4736dcf1b7a3d580672cce6e7c65cd5cc9cfba9d': ['usdc', 1000n],
  '0x169ad27a470d064dede56a2d3ff727986b15d52b': ['usdt', 100n],
  '0x0836222f2b2b24a3f36f98668ed8f0b38d1a872f': ['usdt', 1000n],
  '0xf67721a2d8f736e75a49fdd7fad2e31d8676542a': ['usdt', 10000n],
};

// Cache: {scannedThrough, instances: [address, ...], events: [[block, logIndex,
// unix seconds, instanceIndex, 1 = deposit | 0 = withdrawal], ...]}.
//
// The instance is stored as an index into `instances`, not as the address:
// there are only 10 distinct addresses across ~27k events, and spelling each
// one out was over half the file. The list is written into the cache rather
// than read from INSTANCES so the file stays self-describing and survives that
// map being reordered.
const INSTANCE_LIST = Object.keys(INSTANCES);

// Log -> [block, logIndex, unix seconds, instanceIndex, 1 = deposit | 0 = withdrawal]
function toEvent(log) {
  return [
    parseInt(log.blockNumber, 16),
    parseInt(log.logIndex, 16),
    parseInt(log.blockTimestamp, 16),
    INSTANCE_LIST.indexOf(log.address.toLowerCase()),
    log.topics[0] === DEPOSIT ? 1 : 0,
  ];
}

export const readCache = (file) => readEventCache(file, SCAN_FROM);

export async function writeCache(file, cache) {
  const lines = cache.events.map((e) => JSON.stringify(e)).join(',\n');
  await fs.writeFile(
    file,
    `{"scannedThrough":${cache.scannedThrough},"instances":${JSON.stringify(INSTANCE_LIST)},"events":[\n${lines}\n]}\n`
  );
}

// Extend `cache` through the current head, returning it. Only new blocks are
// scanned, so a refresh costs a handful of calls.
export async function scanFlows(cache) {
  const head = parseInt(await rpc('eth_blockNumber', []), 16) - CONFIRMATIONS;
  if (cache.scannedThrough >= head) return cache;
  const logs = await scanLogs(
    rpc,
    { address: Object.keys(INSTANCES), topics: [[DEPOSIT, WITHDRAWAL]] },
    cache.scannedThrough + 1,
    head,
    { span: LOG_SPAN, concurrency: 2 }
  );
  const events = logs.map(toEvent).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { scannedThrough: head, events: [...cache.events, ...events] };
}

// Cached events -> ascending [[YYYY-MM-01, turnover], ...]. `before` (unix
// seconds, optional) stops the count early, which is how a run is compared to a
// Dune execution that only saw the chain up to its own indexing head.
export function monthlyTurnover(cache, { before = Infinity } = {}) {
  const months = new Map();
  const instances = cache.instances ?? INSTANCE_LIST;
  for (const [, , time, instanceIndex] of cache.events) {
    if (time >= before) continue;
    const [, denomination] = INSTANCES[instances[instanceIndex]];
    const month = `${new Date(time * 1000).toISOString().slice(0, 7)}-01`;
    months.set(month, (months.get(month) ?? 0n) + denomination);
  }
  return [...months.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([m, v]) => [m, Number(v)]);
}

export { INSTANCES, hex };

// The shape the assembly step wants: per-month turnover plus the block the read
// covers, so a reader can tell how current the series is.
export async function fetchTornadoFlows(cacheFile) {
  const cache = await scanFlows(await readCache(cacheFile));
  await writeCache(cacheFile, cache);
  return { scannedThrough: cache.scannedThrough, monthly: monthlyTurnover(cache) };
}
