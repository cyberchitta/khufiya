import { hex, makeRpc, scanLogs, readCache, writeCache } from './evm-logs.js';

// Base USDC freezes, read from the chain — replaces Dune query 7714703. One row
// per `Blacklisted` event on native USDC (Circle's FiatTokenProxy), the signal
// the page watches: freeze events, not currently-frozen addresses.
//
// Base's free RPCs cap eth_getLogs at 1,000–2,000 blocks, so the first scan
// from deployment is ~25k requests (~40 min across two endpoints); after that
// the cache (cache/base-usdc-blacklist.json) limits a refresh to new blocks.
// Blockscout's keyless log API answers in one call but missed 24 of Dune's 589
// events (2026-03-12, 2026-08-24), and rpc.mevblocker.io/base returned none in
// a range holding 21 — neither is used.

const RPCS = (process.env.BASE_RPC_URLS || 'https://gateway.tenderly.co/public/base,https://mainnet.base.org')
  .split(',')
  .map((url) => makeRpc(url.trim()));
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const BLACKLISTED = '0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855';
const DEPLOYED_AT = 2_797_221; // first block with USDC proxy code
const SPAN = 1_000; // the narrowest endpoint's cap
const CONFIRMATIONS = 300; // ~10 min of 2s blocks
const CHECKPOINT = 1_000_000; // blocks per cache write, so a failed first scan resumes

// Log → [block, logIndex, unix seconds, tx hash, blacklisted address]
function toEvent(log) {
  return [
    parseInt(log.blockNumber, 16),
    parseInt(log.logIndex, 16),
    parseInt(log.blockTimestamp, 16),
    log.transactionHash.toLowerCase(),
    '0x' + log.topics[1].slice(-40).toLowerCase(),
  ];
}

// Extend the cache through `toBlock`, writing it every CHECKPOINT blocks.
export async function scanFreezes(cacheFile, toBlock, { onProgress } = {}) {
  let cache = await readCache(cacheFile, DEPLOYED_AT);
  while (cache.scannedThrough < toBlock) {
    const from = cache.scannedThrough + 1;
    const to = Math.min(from + CHECKPOINT - 1, toBlock);
    const logs = await scanLogs(RPCS, { address: USDC, topics: [BLACKLISTED] }, from, to, { span: SPAN, concurrency: 5 });
    if (logs.some((log) => !log.blockTimestamp)) throw new Error('Base RPC returned logs without blockTimestamp');
    const events = [...cache.events, ...logs.map(toEvent)].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    cache = { scannedThrough: to, events };
    await writeCache(cacheFile, cache);
    onProgress?.(cache);
  }
  return cache;
}

// Rows in the shape the site reads (Dune's column names, which derive-pc-series
// and pcData.js key on).
export function toRows(events) {
  return events.map(([block, , time, tx, address]) => ({
    block_time: new Date(time * 1000).toISOString().replace('T', ' ').replace('Z', ' UTC'),
    block_number: block,
    tx_hash: tx,
    blacklisted_address: address,
  }));
}

export async function fetchBaseFreezes(cacheFile) {
  const head = parseInt(await RPCS[0]('eth_blockNumber', []), 16);
  const block = head - CONFIRMATIONS;
  const cache = await scanFreezes(cacheFile, block);
  const { timestamp } = await RPCS[0]('eth_getBlockByNumber', [hex(block), false]);
  return {
    block,
    blockTime: new Date(parseInt(timestamp, 16) * 1000).toISOString(),
    columns: ['block_time', 'block_number', 'tx_hash', 'blacklisted_address'],
    rows: toRows(cache.events),
  };
}
