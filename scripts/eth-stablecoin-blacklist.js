import { blockTimes, hex, makeRpc, scanLogs, readCache as readEventCache, writeCache } from './evm-logs.js';

// The Ethereum stablecoin blacklist, read from the chain — replaces Dune
// queries 7714982 (monthly new blacklisted addresses) and 7714984 (frozen
// value). One scan of the add/remove events feeds both, so the two can never
// disagree about what was blacklisted when.
//
// An address counts toward the value while it is still blacklisted (add/remove
// replayed in order); its value is balanceOf at a block ~64 behind head.
//
// balanceOf, not a transfer-derived balance: Tether's destroyBlackFunds burns a
// frozen balance without a Transfer event, so a transfer ledger keeps counting
// money that no longer exists. That is most of why Dune's June figure (USDT
// $1.60B) sits ~$718M above the chain. Checked against Dune's June run and its
// ever-blacklisted definition: address counts exact, USDC value to the cent.
//
// Event history is cached in the repo (cache/eth-stablecoin-blacklist.json), so
// a refresh scans only blocks past `scannedThrough`, and a reader can recount
// every number from the events without re-scanning.

// Keyless public gateway: 2M-block getLogs ranges and archive eth_call. Any
// other endpoint works via ETH_RPC_URL (narrower ranges are split on error).
const rpc = makeRpc(process.env.ETH_RPC_URL || 'https://gateway.tenderly.co/public/mainnet');
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const CONFIRMATIONS = 64;
const SCAN_FROM = 4_634_748; // USDT deployment; USDC came later
const LOG_SPAN = 2_000_000;

const TOKENS = {
  usdc: {
    contract: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    decimals: 6,
    // Blacklisted(address indexed) / UnBlacklisted(address indexed): address in topic1
    add: '0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855',
    remove: '0x117e3210bb9aa7d9baff172026820255c6f6c30ba8999d1c2fd88e2848137c4e',
    addressIn: 'topic1',
  },
  usdt: {
    contract: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    decimals: 6,
    // AddedBlackList(address) / RemovedBlackList(address): not indexed, address in data
    add: '0x42e160154868087d6bfdc0ca23d96a1c1cfa32f1b72ba9ba27b69b98a0d819dc',
    remove: '0xd7e9ec6e6ecd65492dce6bf513cd6867560d49544421d0783ddf06e76c24470c',
    addressIn: 'data',
  },
};

const word = (n) => BigInt(n).toString(16).padStart(64, '0');

// Log → [block, logIndex, token, address, 1 = added | 0 = removed]. The block's
// timestamp is appended separately, in one batch per scan (see withTimes).
function toEvent(log) {
  const [name, token] = Object.entries(TOKENS).find(([, t]) => t.contract === log.address.toLowerCase());
  const raw = token.addressIn === 'topic1' ? log.topics[1] : log.data.slice(0, 66);
  return [parseInt(log.blockNumber, 16), parseInt(log.logIndex, 16), name, '0x' + raw.slice(-40).toLowerCase(), log.topics[0] === token.add ? 1 : 0];
}

export const readCache = (file) => readEventCache(file, SCAN_FROM);
export { writeCache };

// Fill index 5 (unix seconds) on every event that lacks one: the new events of
// this scan, and — the first time a cache written before the counts existed is
// read — the whole history. Months are cut on the timestamp, so an event with
// no timestamp would land in the wrong month rather than fail visibly.
async function withTimes(events) {
  const missing = events.filter((e) => e[5] === undefined).map((e) => e[0]);
  if (!missing.length) return events;
  const times = await blockTimes(rpc, missing);
  return events.map((e) => (e[5] === undefined ? [...e, times.get(e[0])] : e));
}

// Extend the cached event history through `toBlock`. Pure: returns a new cache.
export async function scanEvents(cache, toBlock) {
  const filter = {
    address: Object.values(TOKENS).map((t) => t.contract),
    topics: [Object.values(TOKENS).flatMap((t) => [t.add, t.remove])],
  };
  const logs = await scanLogs(rpc, filter, cache.scannedThrough + 1, toBlock, { span: LOG_SPAN });
  const events = [...cache.events, ...logs.map(toEvent)].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { scannedThrough: Math.max(cache.scannedThrough, toBlock), events: await withTimes(events) };
}

// Multicall3.aggregate((address,bytes)[]) of balanceOf → one eth_call per chunk.
async function balancesAt(contract, addresses, block) {
  const n = addresses.length;
  let data = '0x252dba42' + word(32) + word(n);
  for (let i = 0; i < n; i++) data += word(n * 32 + i * 160);
  for (const a of addresses) {
    data += word(BigInt(contract)) + word(64) + word(36) + ('70a08231' + word(BigInt(a))).padEnd(128, '0');
  }
  const ret = (await rpc('eth_call', [{ to: MULTICALL3, data }, hex(block)])).slice(2);
  const at = (byte) => BigInt('0x' + ret.slice(byte * 2, byte * 2 + 64));
  const arr = Number(at(32));
  if (Number(at(arr)) !== n) throw new Error(`multicall returned ${Number(at(arr))} of ${n} balances`);
  return Array.from({ length: n }, (_, i) => at(arr + 32 + Number(at(arr + 32 + i * 32)) + 32));
}

// Frozen value at `block` from cached events. `includeRemoved` reproduces Dune's
// ever-blacklisted definition — kept for re-checking against the baseline.
export async function frozenAt(cache, block, { includeRemoved = false } = {}) {
  if (block > cache.scannedThrough) throw new Error(`cache scanned through ${cache.scannedThrough}, not ${block}`);
  const out = {};
  for (const [name, token] of Object.entries(TOKENS)) {
    const status = new Map();
    for (const [b, , t, address, added] of cache.events) {
      if (t === name && b <= block) status.set(address, added === 1);
    }
    const addresses = [...status].filter(([, on]) => on || includeRemoved).map(([a]) => a);
    let total = 0n;
    for (let i = 0; i < addresses.length; i += 500) {
      for (const balance of await balancesAt(token.contract, addresses.slice(i, i + 500), block)) total += balance;
    }
    out[name] = {
      addresses: addresses.length,
      // stablecoin face value ≈ USD, rounded to the cent in BigInt before Number
      frozenUsd: Number((total + 5n * 10n ** BigInt(token.decimals - 3)) / 10n ** BigInt(token.decimals - 2)) / 100,
    };
  }
  return out;
}

// Cached events → Dune's row shape, which countColumn() in the fetch keys on.
// Counts ADD events, not distinct addresses: a re-blacklisted address counts
// again, and removals are not netted. That is what 7714982 did, and what the
// page's cumulative "ever blacklisted" figure means.
export function toRows(events) {
  const byMonth = new Map();
  for (const [, , token, , added, time] of events) {
    if (added !== 1) continue;
    const month = new Date(time * 1000).toISOString().slice(0, 7);
    const row = byMonth.get(month) ?? { usdc: 0, usdt: 0 };
    row[token] += 1;
    byMonth.set(month, row);
  }
  return [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, r]) => ({
      block_month: `${month}-01 00:00:00.000 UTC`,
      usdc_blacklisted: r.usdc,
      usdt_blacklisted: r.usdt,
    }));
}

// Scan to a settled block, write the cache, and return both series read from
// it: monthly blacklist adds, and the frozen value of what is still blacklisted.
export async function fetchEthBlacklist(cacheFile) {
  const head = parseInt(await rpc('eth_blockNumber', []), 16);
  const block = head - CONFIRMATIONS;
  const cache = await scanEvents(await readCache(cacheFile), block);
  await writeCache(cacheFile, cache);
  const { timestamp } = await rpc('eth_getBlockByNumber', [hex(block), false]);
  const blockTime = new Date(parseInt(timestamp, 16) * 1000).toISOString();
  return {
    counts: { rows: toRows(cache.events) },
    value: { block, blockTime, ...(await frozenAt(cache, block)) },
  };
}
