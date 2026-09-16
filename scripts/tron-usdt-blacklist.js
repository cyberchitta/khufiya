import { promises as fs } from 'fs';

// USDT blacklist adds on Tron, read from TronGrid — replaces Dune query 7715354.
// Tron carries the large majority of USDT freezes by address count, so the
// page's cross-chain USDT figure is wrong without it.
//
// Tron is not EVM-RPC, so evm-logs.js does not apply: TronGrid's event API is
// keyless, returns block timestamps inline, and pages through a `fingerprint`
// cursor. `min_block_timestamp` makes a refresh fetch only what is new, so the
// cache (cache/tron-usdt-blacklist.json) exists to bound the refresh, not
// because the seed is expensive (~43 pages).

const API = process.env.TRON_API_URL || 'https://api.trongrid.io';
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const DEPLOYED_AT = 1_546_300_800_000; // 2019-01-01, before the contract's first event
const PAGE = 200; // TronGrid's maximum
// Tron finalises in ~1 min; a wider margin keeps a reorg from stranding an
// event in the cache, at the cost of reporting it one refresh later.
const SETTLE_MS = 10 * 60 * 1000;

async function getJson(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(60000) });
      if (res.status === 429) throw new Error('TronGrid rate limited (429)');
      if (!res.ok) throw new Error(`TronGrid returned ${res.status}`);
      const body = await res.json();
      if (body.success === false) throw new Error(`TronGrid: ${JSON.stringify(body.error ?? body).slice(0, 160)}`);
      return body;
    } catch (error) {
      if (attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 15000) * (0.5 + Math.random())));
    }
  }
}

// Event → [block, event index, unix seconds, tx id, blacklisted address]. The
// address is Tron-hex (0x41…); kept verbatim, as only the count is published.
const toEvent = (e) => [e.block_number, e.event_index, Math.floor(e.block_timestamp / 1000), e.transaction_id, e.result._user];

// All AddedBlackList events with block_timestamp in [since, until), ascending.
// Every page must arrive: a truncated walk would silently undercount, so a
// failed page fails the scan rather than returning what it has.
async function fetchEvents(since, until) {
  const params = new URLSearchParams({
    event_name: 'AddedBlackList',
    limit: String(PAGE),
    order_by: 'block_timestamp,asc',
    min_block_timestamp: String(since),
  });
  let url = `${API}/v1/contracts/${USDT}/events?${params}`;
  const events = [];
  while (url) {
    const body = await getJson(url);
    for (const e of body.data ?? []) {
      if (e.event_name !== 'AddedBlackList') throw new Error(`TronGrid returned a ${e.event_name} event`);
      if (e.block_timestamp < until) events.push(toEvent(e));
    }
    url = (body.data ?? []).length === PAGE ? body.meta?.links?.next : null;
  }
  return events;
}

export async function readCache(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return { scannedThrough: DEPLOYED_AT - 1, events: [] };
  }
}

// One event per line, so a refresh's diff shows exactly the events it added.
export async function writeCache(file, cache) {
  const lines = cache.events.map((e) => JSON.stringify(e)).join(',\n');
  await fs.writeFile(file, `{"scannedThrough":${cache.scannedThrough},"events":[\n${lines}\n]}\n`);
}

// Extend the cache to `until` (ms). Pure: returns a new cache. Re-fetching from
// `scannedThrough` can re-deliver events already held, so merge by tx + index.
export async function scanBlacklist(cache, until) {
  const incoming = await fetchEvents(cache.scannedThrough + 1, until);
  const seen = new Map(cache.events.map((e) => [`${e[3]}:${e[1]}`, e]));
  for (const e of incoming) seen.set(`${e[3]}:${e[1]}`, e);
  const events = [...seen.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { scannedThrough: Math.max(cache.scannedThrough, until), events };
}

// Cached events → Dune's row shape, which countColumn() in the fetch keys on.
export function toRows(events) {
  const byMonth = new Map();
  for (const [, , time] of events) {
    const month = new Date(time * 1000).toISOString().slice(0, 7);
    byMonth.set(month, (byMonth.get(month) || 0) + 1);
  }
  return [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, n]) => ({ block_month: `${month}-01 00:00:00.000 UTC`, usdt_blacklisted: n }));
}

export async function fetchTronUsdtBlacklist(cacheFile) {
  const until = Date.now() - SETTLE_MS;
  const cache = await scanBlacklist(await readCache(cacheFile), until);
  await writeCache(cacheFile, cache);
  return {
    source: `Tron — USDT (${USDT}) AddedBlackList events, read via TronGrid`,
    scannedThrough: new Date(cache.scannedThrough).toISOString(),
    events: cache.events.length,
    rows: toRows(cache.events),
  };
}
