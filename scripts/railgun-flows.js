import { promises as fs } from 'fs';
import { makeRpc, scanLogs } from './evm-logs.js';

// Railgun stablecoin turnover, read from the chains — replaces Dune query
// 7714782. Per-month gross turnover = stablecoin transfers in + out of the
// Railgun contracts across three chains (DAI/USDC/USDT are ~$1, so units ≈ USD).
//
// Stablecoins are matched by CONTRACT ADDRESS, not by symbol, and here that is
// not a detail. Dune joined tokens.erc20 on `upper(symbol) in
// ('USDC','USDT','DAI')`, and 0x12d9fe4c… — a counterfeit whose symbol is
// literally "DAI" — moved 110,980,202 units through the Ethereum contract in 6
// transfers in 2026-08. Dune reports that month as $177,925,658; the canonical
// stablecoins give $67,360,458. The same token also moved ~302M in 2025-05,
// which falls inside the old repo-cached prefix — but the prefix did NOT carry
// it (published 2025-05 was $81.4M against $79.8M on-chain, -2.0%; AMLBot's
// query did not match that token). The published contamination was 2026-08.
//
// The symbol join also EXCLUDES real flow, because a token can be renamed out
// of the filter: Polygon USDT reports its symbol as `USDT0`. (The bridged
// "USDC.e" tokens are NOT an instance of this — checked 2026-09-16, both
// 0x2791bc… on Polygon and 0xff970a… on Arbitrum return plain `USDC` from
// symbol(), so Dune matched them. USDC.e is their common name, not their
// on-chain symbol.) All of them are included below, by address.

// BNB IS OUT OF SCOPE (owner decision, 2026-09-16). Railgun is read on
// Ethereum + Polygon + Arbitrum only, which is >=~98% of its stablecoin
// turnover — the BSC contract holds ~$330k and a recent 300k-block sample held
// 13 transfers. It was dropped because BSC has no keyless ARCHIVE route, which
// is a different problem from the block-range caps the other chains posed:
// of 23 endpoints measured, rpc-bsc.48.club / blockrazor / 1rpc serve only
// recent blocks (`header not found` at 84M and 100M), publicnode 403s under
// sustained load (1 success in 40) and refuses eth_getLogs without an `address`
// filter, the bnbchain/defibit dataseeds refuse every range, and the one
// archival endpoint (bsc.rpc.blxrbdn.com) times out under any load — 8/60 ok,
// ~195h for a single pass. So a quoted Railgun figure is three-chain scope;
// phrase it honestly.
//
// The three remaining chains take wide getLogs ranges on Tenderly's public
// gateways and return blockTimestamp on the logs, so full history is cheap —
// which is why this reads the whole series rather than splicing a suffix onto
// a cached prefix (owner decision, 2026-09-16; see scanFrom below).
const CHAINS = {
  ethereum: {
    url: 'https://gateway.tenderly.co/public/mainnet',
    contract: '0xfa7093cdd9ee6932b4eb2c9e1cde7ce00b1fa4b9',
    span: 2_000_000,
    concurrency: 2,
    tokens: {
      '0x6b175474e89094c44da98b954eedeac495271d0f': 18, // DAI
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 6, // USDC
      '0xdac17f958d2ee523a2206206994597c13d831ec7': 6, // USDT
    },
  },
  polygon: {
    url: 'https://gateway.tenderly.co/public/polygon',
    contract: '0x19b620929f97b7b990801496c3b361ca5def8c71',
    span: 2_000_000,
    concurrency: 2,
    tokens: {
      '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': 6, // USDC (native)
      '0x2791bca1f2de4661ed88a30c99a7a9449aa84174': 6, // bridged USDC (symbol() is 'USDC'; "USDC.e" is only its common name)
      '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': 6, // USDT — reports symbol() 'USDT0', so a ticker match drops it
      '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063': 18, // DAI
    },
  },
  arbitrum: {
    url: 'https://gateway.tenderly.co/public/arbitrum',
    contract: '0xfa7093cdd9ee6932b4eb2c9e1cde7ce00b1fa4b9',
    span: 5_000_000,
    concurrency: 2,
    tokens: {
      '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 6, // USDC (native)
      '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': 6, // bridged USDC (symbol() is 'USDC'; "USDC.e" is only its common name)
      '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': 18, // DAI
      '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': 6, // USDT
    },
  },
};

// Full history: each chain is scanned from before Railgun's first stablecoin
// flow there, so the whole series is chain-derived. The old repo-cached prefix
// (seeded from AMLBot 6702283) is NOT used — it carried Dune's symbol-join
// contamination, including ~302M of counterfeit "DAI" in 2025-05.
const SCAN_FROM = { ethereum: 11_000_000, polygon: 15_000_000, arbitrum: 1_000_000 };

// Transfer(address indexed from, address indexed to, uint256 value)
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const CONFIRMATIONS = { ethereum: 64, polygon: 128, arbitrum: 300 };

const topicAddress = (address) => '0x' + address.slice(2).padStart(64, '0');

// Cache: {chains: {<name>: {scannedThrough, tokens: [address, ...], events:
// [[block, logIndex, unix seconds, tokenIndex, raw value], ...]}}}. One file,
// because the three chains only mean anything summed together.
//
// The token is stored as an index into the chain's own `tokens` list, not as
// the address: there are only 11 distinct addresses across ~193k events, and
// spelling each one out cost 8MB — over half the file. The list is written into
// the cache rather than read from CHAINS so the file stays self-describing and
// survives the config being reordered.
export async function readCache(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return { chains: {} };
  }
}

export async function writeCache(file, cache) {
  const chains = Object.entries(cache.chains).map(([name, { scannedThrough, tokens, events }]) => {
    const lines = events.map((e) => JSON.stringify(e)).join(',\n');
    return `"${name}":{"scannedThrough":${scannedThrough},"tokens":${JSON.stringify(tokens)},"events":[\n${lines}\n]}`;
  });
  await fs.writeFile(file, `{"chains":{\n${chains.join(',\n')}\n}}\n`);
}

// Extend one chain's slice of the cache to its current head. A chain the cache
// has never seen is seeded from SCAN_FROM.
export async function scanChain(cache, chain, scanFrom = SCAN_FROM[chain]) {
  const config = CHAINS[chain];
  const rpc = makeRpc(config.url);
  const head = parseInt(await rpc('eth_blockNumber', []), 16) - CONFIRMATIONS[chain];
  const previous = cache.chains[chain] ?? { scannedThrough: scanFrom - 1, tokens: [], events: [] };
  if (previous.scannedThrough >= head) return cache;

  const from = previous.scannedThrough + 1;
  const tokens = Object.keys(config.tokens);
  const party = [topicAddress(config.contract)];
  const options = { span: config.span, concurrency: config.concurrency };
  // `from` and `to` are separate topic positions, so two passes; a transfer
  // matching both is deduped on (block, logIndex), as Dune's single OR did.
  const [inbound, outbound] = await Promise.all([
    scanLogs(rpc, { address: tokens, topics: [TRANSFER, null, party] }, from, head, options),
    scanLogs(rpc, { address: tokens, topics: [TRANSFER, party] }, from, head, options),
  ]);
  const unique = new Map();
  for (const log of [...inbound, ...outbound]) unique.set(`${log.blockNumber}:${log.logIndex}`, log);

  // Tenderly returns blockTimestamp on the logs. An endpoint that does not
  // would silently misdate an event, so a missing one is fetched, never guessed.
  const missing = [...new Set([...unique.values()].filter((l) => !l.blockTimestamp).map((l) => parseInt(l.blockNumber, 16)))];
  const times = new Map();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, missing.length) }, async () => {
      while (next < missing.length) {
        const block = missing[next++];
        const { timestamp } = (await rpc('eth_getBlockByNumber', ['0x' + block.toString(16), false])) ?? {};
        if (!timestamp) throw new Error(`no timestamp for ${chain} block ${block}`);
        times.set(block, parseInt(timestamp, 16));
      }
    })
  );

  // Token addresses are interned against this chain's list, extending it if a
  // scan turns up one the cache has not seen.
  const tokenList = [...previous.tokens];
  const indexOf = (address) => {
    const i = tokenList.indexOf(address);
    return i === -1 ? tokenList.push(address) - 1 : i;
  };
  const events = [...unique.values()]
    .map((log) => {
      const block = parseInt(log.blockNumber, 16);
      return [
        block,
        parseInt(log.logIndex, 16),
        log.blockTimestamp ? parseInt(log.blockTimestamp, 16) : times.get(block),
        indexOf(log.address.toLowerCase()),
        BigInt(log.data.slice(0, 66)).toString(),
      ];
    })
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  return {
    chains: {
      ...cache.chains,
      [chain]: { scannedThrough: head, tokens: tokenList, events: [...previous.events, ...events] },
    },
  };
}

// Cached events across all three chains -> ascending [[YYYY-MM-01, turnover], …].
// A chain the cache has not seen contributes nothing, which is why the caller
// must treat a failed chain as a failed run rather than publishing a partial
// total — the same trap the blacklist counts guard exists to close.
export function monthlyTurnover(cache, { before = Infinity } = {}) {
  const months = new Map();
  for (const [chain, slice] of Object.entries(cache.chains)) {
    const { tokens } = CHAINS[chain];
    for (const [, , time, tokenIndex, raw] of slice.events) {
      if (time >= before) continue;
      const value = Number(BigInt(raw)) / 10 ** tokens[slice.tokens[tokenIndex]];
      const month = `${new Date(time * 1000).toISOString().slice(0, 7)}-01`;
      months.set(month, (months.get(month) ?? 0) + value);
    }
  }
  return [...months.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([m, v]) => [m, Math.round(v * 100) / 100]);
}

export { CHAINS, SCAN_FROM };

// All three chains, or nothing. A chain that fails contributes zero months
// rather than a short one, and a silently short Railgun total would look like a
// real collapse in turnover — the same trap the blacklist counts guard closes.
export async function fetchRailgunFlows(cacheFile) {
  let cache = await readCache(cacheFile);
  for (const chain of Object.keys(CHAINS)) cache = await scanChain(cache, chain);
  await writeCache(cacheFile, cache);
  return {
    monthly: monthlyTurnover(cache),
    chains: Object.fromEntries(Object.entries(cache.chains).map(([name, s]) => [name, s.scannedThrough])),
  };
}
