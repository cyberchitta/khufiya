import { promises as fs } from 'fs';

// Ethereum frozen stablecoin value, read from the chain — replaces Dune query
// 7714984. An address counts while it is still blacklisted (add/remove events
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
const RPC_URL = process.env.ETH_RPC_URL || 'https://gateway.tenderly.co/public/mainnet';
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

const hex = (n) => '0x' + n.toString(16);
const word = (n) => BigInt(n).toString(16).padStart(64, '0');

async function rpc(method, params) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) throw new Error(`${method} returned ${res.status}`);
      const body = await res.json();
      if (body.error) throw Object.assign(new Error(`${method}: ${JSON.stringify(body.error).slice(0, 160)}`), { rpc: true });
      return body.result;
    } catch (error) {
      // An RPC-level error (e.g. range too wide) is the caller's to handle; a
      // transport error or 429 is retried with backoff.
      if (error.rpc || attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
}

async function getLogs(fromBlock, toBlock) {
  const filter = {
    address: Object.values(TOKENS).map((t) => t.contract),
    topics: [Object.values(TOKENS).flatMap((t) => [t.add, t.remove])],
    fromBlock: hex(fromBlock),
    toBlock: hex(toBlock),
  };
  try {
    return await rpc('eth_getLogs', [filter]);
  } catch (error) {
    if (!error.rpc || toBlock - fromBlock < 1000) throw error;
    const mid = Math.floor((fromBlock + toBlock) / 2);
    return [...(await getLogs(fromBlock, mid)), ...(await getLogs(mid + 1, toBlock))];
  }
}

// Log → [block, logIndex, token, address, 1 = added | 0 = removed]
function toEvent(log) {
  const [name, token] = Object.entries(TOKENS).find(([, t]) => t.contract === log.address.toLowerCase());
  const raw = token.addressIn === 'topic1' ? log.topics[1] : log.data.slice(0, 66);
  return [parseInt(log.blockNumber, 16), parseInt(log.logIndex, 16), name, '0x' + raw.slice(-40).toLowerCase(), log.topics[0] === token.add ? 1 : 0];
}

export async function readCache(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return { scannedThrough: SCAN_FROM - 1, events: [] };
  }
}

// One event per line, so a refresh's diff shows exactly the events it added.
export async function writeCache(file, cache) {
  const lines = cache.events.map((e) => JSON.stringify(e)).join(',\n');
  await fs.writeFile(file, `{"scannedThrough":${cache.scannedThrough},"events":[\n${lines}\n]}\n`);
}

// Extend the cached event history through `toBlock`. Pure: returns a new cache.
export async function scanEvents(cache, toBlock) {
  const events = [...cache.events];
  for (let from = cache.scannedThrough + 1; from <= toBlock; from += LOG_SPAN) {
    const logs = await getLogs(from, Math.min(from + LOG_SPAN - 1, toBlock));
    events.push(...logs.filter((log) => !log.removed).map(toEvent));
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { scannedThrough: Math.max(cache.scannedThrough, toBlock), events };
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

// Scan to a settled block, write the cache, and return the snapshot there.
export async function fetchEthFrozenValue(cacheFile) {
  const head = parseInt(await rpc('eth_blockNumber', []), 16);
  const block = head - CONFIRMATIONS;
  const cache = await scanEvents(await readCache(cacheFile), block);
  await writeCache(cacheFile, cache);
  const { timestamp } = await rpc('eth_getBlockByNumber', [hex(block), false]);
  return {
    block,
    blockTime: new Date(parseInt(timestamp, 16) * 1000).toISOString(),
    ...(await frozenAt(cache, block)),
  };
}
