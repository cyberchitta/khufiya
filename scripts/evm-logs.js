import { promises as fs } from 'fs';

// Shared JSON-RPC + log scanning for the on-chain readers. Free public RPCs
// differ mainly in how wide an eth_getLogs block range they accept, so each
// reader picks a span its endpoint allows; a range the endpoint still rejects is
// split in half and retried.

export const hex = (n) => '0x' + n.toString(16);

export function makeRpc(url) {
  return async function rpc(method, params) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(60000),
        });
        if (!res.ok) throw new Error(`${method} returned ${res.status}`);
        const body = await res.json();
        if (body.error) {
          throw Object.assign(new Error(`${method}: ${JSON.stringify(body.error).slice(0, 160)}`), { rpc: true });
        }
        return body.result;
      } catch (error) {
        // An RPC-level error (e.g. range too wide) is the caller's to handle; a
        // transport error or 429 is retried with backoff.
        // Long scans hit free-tier rate limits in bursts, so back off up to ~30s
        // with jitter rather than failing the scan.
        if (error.rpc || attempt >= 10) throw error;
        const delay = Math.min(1000 * 2 ** attempt, 30000) * (0.5 + Math.random());
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  };
}

async function getLogs(rpc, filter, fromBlock, toBlock) {
  try {
    return await rpc('eth_getLogs', [{ ...filter, fromBlock: hex(fromBlock), toBlock: hex(toBlock) }]);
  } catch (error) {
    if (!error.rpc || toBlock - fromBlock < 100) throw error;
    const mid = Math.floor((fromBlock + toBlock) / 2);
    return [...(await getLogs(rpc, filter, fromBlock, mid)), ...(await getLogs(rpc, filter, mid + 1, toBlock))];
  }
}

// All logs matching `filter` in [fromBlock, toBlock], in chain order. Ranges of
// `span` blocks run `concurrency` at a time per endpoint (`rpc` may be a list,
// shared round-robin); any failure fails the whole scan, so a partial result is
// never mistaken for a complete one.
export async function scanLogs(rpc, filter, fromBlock, toBlock, { span, concurrency = 1 }) {
  const rpcs = [rpc].flat();
  const ranges = [];
  for (let from = fromBlock; from <= toBlock; from += span) ranges.push([from, Math.min(from + span - 1, toBlock)]);
  const results = new Array(ranges.length);
  let next = 0;
  const worker = async (endpoint) => {
    while (next < ranges.length) {
      const i = next++;
      results[i] = await getLogs(endpoint, filter, ...ranges[i]);
    }
  };
  const workers = Array.from({ length: Math.min(concurrency * rpcs.length, ranges.length) }, (_, k) => worker(rpcs[k % rpcs.length]));
  await Promise.all(workers);
  return results.flat().filter((log) => !log.removed);
}

// Event caches: {"scannedThrough": N, "events": [[...], ...]}, one event per
// line so a refresh's diff shows exactly the events it added.
export async function readCache(file, scanFrom) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return { scannedThrough: scanFrom - 1, events: [] };
  }
}

export async function writeCache(file, cache) {
  const lines = cache.events.map((e) => JSON.stringify(e)).join(',\n');
  await fs.writeFile(file, `{"scannedThrough":${cache.scannedThrough},"events":[\n${lines}\n]}\n`);
}
