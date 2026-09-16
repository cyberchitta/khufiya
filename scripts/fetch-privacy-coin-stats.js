import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';
import { fetchEthBlacklist } from './eth-stablecoin-blacklist.js';
import { fetchTronUsdtBlacklist } from './tron-usdt-blacklist.js';
import { fetchBaseFreezes } from './base-usdc-freezes.js';
import { fetchTornadoFlows } from './tornado-flows.js';
import { fetchPrivacyPoolsFlows } from './privacy-pools-flows.js';
import { fetchRailgunFlows } from './railgun-flows.js';
import { x402PeakStats } from './x402-peak.js';

// Fetches the tracked statistics for the privacy-coins-ai-money prediction
// tracker page. All sources are free/keyless. Each fetcher is fail-soft: a
// dead source logs an error and the previous folder's copy is carried forward.
//
// Runs from the khufiya repo and writes into the site repo (SITE_DIR, default
// the sibling ../www.cyberchitta.cc), which consumes the files at build time.
//
// Fetched files land in a dated folder, <site>/src/assets/data/privacy-coins/raw/<YYMMDD>/,
// and superseded dated folders are deleted — the deployed files are immutable
// (long-TTL cached, see .netlify/_headers) and a refresh is a rename, not a
// mutation. Same-day reruns overwrite the day's folder (in-flight rule).
// Templates resolve the current folder from src/_data/pcStats.json, which this
// script maintains.
//
// Folder contents:
//   snapshots.json        append-only daily snapshots of point-in-time metrics
//                         (x402scan, Blockchair chain stats, CoinGecko market data).
//                         x402.belowPeak is derived here from x402-series.json —
//                         the article's "% below peak" reads it (see x402-peak.js).
//   x402-series.json      full daily x402 tx/volume/buyers/sellers history
//                         (x402scan tRPC public.stats.bucketed)
//   monero-tx-series.json full daily tx-count + avg-fee-USD history
//                         (bitinfocharts scrape — fragile, unofficial; amounts
//                         are hidden by design, tx count and fees are the
//                         public on-chain activity proxies)
//   market-series.json    full daily price history for XMR/ZEC + market-cap
//                         history for XMR only (bitinfocharts scrape;
//                         CoinGecko's public API caps history at 365 days).
//                         ZEC market cap is NOT here — see fetchMarketSeries.
//   stablecoin-series.json
//                         full daily USDT/USDC tx-count history (Coin Metrics
//                         community API) — the transparent-stablecoin rail is
//                         the article's stated refutation venue
//   zcash-series.json     full shielded-supply + shielded-tx-count history
//                         (ZecHub's GitHub-hosted data files)
//   onchain-privacy-series.json
//                         daily TVL history for privacy protocols on
//                         transparent chains (DefiLlama)
//   fiat-rails-series.json
//                         hand-maintained baseline: UPI monthly volume + Visa
//                         quarterly processed transactions (the "fiat ceiling").
//                         NOT fetched — Visa publishes only quarterly and NPCI's
//                         page has no clean data URL; the canonical copy lives in
//                         this repo at data/fiat-rails-series.json and is copied
//                         into each folder so it caches like the rest.
//   privacy-flows.json / base-freezes.json / stablecoin-blacklist.json
//                         Keyless and on-chain, like everything else here. These
//                         were named dune-*.json until 2026-09-16; renamed once
//                         the last Dune query was retired, because the old names
//                         told a reader of the site repo that the data came from
//                         a vendor that no longer supplies any of it.
//                         (queries/*.sql and _notes/DUNE-SETUP.md survive as
//                         history; baselines/dune-2026-09-15/ is what the readers
//                         were checked against.)
//                         privacy-flows: per-protocol per-month stablecoin
//                         turnover, each reader computing FULL history off its
//                         own growing cache in cache/ — no prefix, no splice.
//                         Railgun is Ethereum+Polygon+Arbitrum (BNB dropped,
//                         owner decision — no keyless BSC archive), Tornado and
//                         PP are Ethereum. Stablecoins are matched BY CONTRACT
//                         ADDRESS, never by symbol; a symbol join is what let
//                         counterfeits inflate the old Railgun and PP numbers.
//                         base-freeze: USDC Blacklisted events on Base
//                         (base-usdc-freezes.js).
//                         blacklist: USDC/USDT blacklist counts (monthly) +
//                         Ethereum frozen-value snapshot. Ethereum both, on-chain
//                         (eth-stablecoin-blacklist.js); Tron USDT via TronGrid
//                         (tron-usdt-blacklist.js). Solana is out of scope —
//                         see the blacklist assembly below.
//
// The event timeline is hand-curated as a markdown table in the article
// (src/articles/private-canary.md, rendered by showtable/pc-timeline.ejs) and
// is never touched by this script. This script does stamp the article's
// frontmatter `updates` with the refresh date — see stampArticleRefresh.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_DIR = path.resolve(process.env.SITE_DIR || path.join(__dirname, '..', '..', 'www.cyberchitta.cc'));
const DATA_DIR = path.join(__dirname, '..', 'data');
const ETH_BLACKLIST_CACHE = path.join(__dirname, '..', 'cache', 'eth-stablecoin-blacklist.json');
const BASE_FREEZE_CACHE = path.join(__dirname, '..', 'cache', 'base-usdc-blacklist.json');
const TRON_BLACKLIST_CACHE = path.join(__dirname, '..', 'cache', 'tron-usdt-blacklist.json');
const TORNADO_FLOWS_CACHE = path.join(__dirname, '..', 'cache', 'tornado-flows.json');
const PRIVACY_POOLS_FLOWS_CACHE = path.join(__dirname, '..', 'cache', 'privacy-pools-flows.json');
const RAILGUN_FLOWS_CACHE = path.join(__dirname, '..', 'cache', 'railgun-flows.json');
const PRIVACY_DIR = path.join(SITE_DIR, 'src', 'assets', 'data', 'privacy-coins');
const RAW_DIR = path.join(PRIVACY_DIR, 'raw');
const POINTER_FILE = path.join(SITE_DIR, 'src', '_data', 'pcStats.json');
const ARTICLE_FILE = path.join(SITE_DIR, 'src', 'articles', 'private-canary.md');

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function fetchText(url, headers = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'CyberChitta-Website-Builder', ...headers },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.text();
}

async function fetchJson(url, headers = {}) {
  return JSON.parse(await fetchText(url, headers));
}

// Every [FAIL] lands here, so the closing summary can't miss one. A skipped
// source also returns null but is not a failure, which is why the
// summary can't just count null results.
const failedSources = [];

async function safe(label, fn) {
  try {
    const result = await fn();
    console.log(`[ok] ${label}`);
    return result;
  } catch (error) {
    console.error(`[FAIL] ${label}: ${error.message}`);
    failedSources.push(label);
    return null;
  }
}

// --- x402scan (unofficial tRPC API; schema pinned to github.com/Merit-Systems/x402scan) ---

async function fetchX402(timeframeDays) {
  const input = encodeURIComponent(JSON.stringify({ 0: { json: { timeframe: timeframeDays } } }));
  const url = `https://www.x402scan.com/api/trpc/public.stats.overall?batch=1&input=${input}`;
  const body = await fetchJson(url);
  const stats = body[0].result.data.json;
  return {
    txCount: stats.total_transactions,
    // total_amount is in USDC atomic units (6 decimals)
    volumeUsd: Math.round(stats.total_amount / 1e4) / 100,
    uniqueBuyers: stats.unique_buyers,
    uniqueSellers: stats.unique_sellers,
    latestBlockTimestamp: stats.latest_block_timestamp,
  };
}

// Returns daily buckets for the full history regardless of numBuckets
// (numBuckets is in the input schema but the materialized view is daily).
// The trailing bucket is the partial current day — dropped for immutability.
async function fetchX402Series() {
  const input = encodeURIComponent(JSON.stringify({ 0: { json: { timeframe: 0, numBuckets: 48 } } }));
  const url = `https://www.x402scan.com/api/trpc/public.stats.bucketed?batch=1&input=${input}`;
  const body = await fetchJson(url);
  const rows = body[0].result.data.json;
  const today = new Date().toISOString().slice(0, 10);
  return rows
    .map((row) => [
      row.bucket_start.slice(0, 10),
      row.total_transactions,
      // total_amount is in USDC atomic units (6 decimals)
      Math.round(row.total_amount / 1e4) / 100,
      row.unique_buyers,
      row.unique_sellers,
    ])
    .filter((row) => row[0] !== today);
}

// --- Coin Metrics community API: stablecoin tx counts (keyless) ---
// usdt/usdc are Coin Metrics' cross-chain aggregate assets. The transparent-
// stablecoin rail is the article's stated refutation venue, so its tx/day is
// the main chart's counterfactual line.

async function fetchStablecoinSeries() {
  const series = {};
  for (const asset of ['usdt', 'usdc']) {
    const rows = [];
    let url = `https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=${asset}&metrics=TxCnt&frequency=1d&page_size=10000&paging_from=start`;
    for (let page = 0; url && page < 5; page++) {
      const body = await fetchJson(url);
      rows.push(...body.data.map((row) => [row.time.slice(0, 10), parseInt(row.TxCnt)]));
      url = body.data.length && body.next_page_url ? body.next_page_url : null;
    }
    if (rows.length < 1000) throw new Error(`only ${rows.length} rows for ${asset} — API change?`);
    series[asset] = rows;
  }
  return series;
}

// --- Blockchair chain stats (keyless: 1,440 req/day, 30 req/min) ---

async function fetchBlockchairStats(chain) {
  const body = await fetchJson(`https://api.blockchair.com/${chain}/stats`);
  return body.data;
}

// --- ZecHub data files (source for zechub.wiki/dashboard, ~daily commits) ---

const ZECHUB_RAW = 'https://raw.githubusercontent.com/ZecHub/zechub-wiki/main/public/data/zcash';

// ZecHub dates are MM/DD/YYYY, with occasional ISO timestamps mixed in
function toIsoDate(zecHubDate) {
  if (zecHubDate.includes('T')) return zecHubDate.slice(0, 10);
  const [mm, dd, yyyy] = zecHubDate.split('/');
  return `${yyyy}-${mm}-${dd}`;
}

// Map a Zcash block height → ISO date by interpolating ZecHub's blockFeesZEC
// (Block, Date) anchors. Both that file and transaction_summary are ~daily, so
// the result is accurate to about a day — enough to place a point on a
// multi-year log axis. Used to date transaction_summary.json, which is keyed by
// height with no timestamp.
function buildHeightToIso(blockFees) {
  const anchors = blockFees
    .map((row) => [Number(row.Block), Date.parse(toIsoDate(row.Date))])
    .filter(([b, t]) => Number.isFinite(b) && Number.isFinite(t))
    .sort((a, b) => a[0] - b[0]);
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  return (height) => {
    if (height <= anchors[0][0]) return iso(anchors[0][1]);
    if (height >= anchors[anchors.length - 1][0]) return iso(anchors[anchors.length - 1][1]);
    let lo = 0;
    let hi = anchors.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (anchors[mid][0] <= height) lo = mid;
      else hi = mid;
    }
    const [b0, t0] = anchors[lo];
    const [b1, t1] = anchors[hi];
    return iso(t0 + ((height - b0) / (b1 - b0)) * (t1 - t0));
  };
}

async function fetchZcashSeries() {
  const [supply, txCount, summary, blockFees] = await Promise.all([
    fetchJson(`${ZECHUB_RAW}/shielded_supply.json`),
    fetchJson(`${ZECHUB_RAW}/shieldedtxcount.json`),
    fetchJson(`${ZECHUB_RAW}/transaction_summary.json`),
    fetchJson(`${ZECHUB_RAW}/blockFeesZEC.json`),
  ]);
  // Recent, precisely-dated shielded tx counts per pool per day. Pools are read
  // from the file, not hardcoded: Ironwood arrived 2026-08 as a fourth key and a
  // fixed Sprout/Sapling/Orchard list silently dropped most shielded activity.
  const pools = [...new Set(txCount.flatMap((row) => Object.keys(row)))].filter((k) => k !== 'timestamp');
  const tail = txCount.map((row) => [toIsoDate(row.timestamp), ...pools.map((k) => row[k] ?? 0)]);
  const tailStart = tail.reduce((min, [d]) => (d < min ? d : min), tail[0][0]);
  // Longer prefix: transaction_summary is keyed by block height back to Sapling
  // activation (~Oct 2018) — the start of meaningful shielded usage. Date it via
  // blockFeesZEC and splice in only the days before the precise tail, so the
  // recent (scrutinized) portion keeps exact dates. Sprout is long-deprecated by
  // then, so it rides as 0 to match the tail's column shape.
  const heightToIso = buildHeightToIso(blockFees);
  const prefix = new Map();
  for (const row of summary) {
    const date = heightToIso(Number(row.height));
    if (date < tailStart) prefix.set(date, [date, ...pools.map((k) => row[k] ?? 0)]);
  }
  return {
    shieldedSupply: supply.map((row) => [toIsoDate(row.close), row.supply]),
    shieldedTxPerDay: {
      columns: ['date', ...pools],
      rows: [...prefix.values(), ...tail].sort((a, b) => a[0].localeCompare(b[0])),
    },
  };
}

// --- CoinGecko (keyless public API, ~30 req/min) ---

const COINGECKO = 'https://api.coingecko.com/api/v3';

async function fetchCoinGecko() {
  const markets = await fetchJson(`${COINGECKO}/coins/markets?vs_currency=usd&ids=monero,zcash`);
  const global = await fetchJson(`${COINGECKO}/global`);
  const categories = await fetchJson(`${COINGECKO}/coins/categories`);
  const byId = Object.fromEntries(markets.map((coin) => [coin.id, coin]));
  const privacyCoins = categories.find((category) => category.id === 'privacy-coins');
  const coinMarket = (coin) =>
    coin ? { priceUsd: coin.current_price, marketCapUsd: coin.market_cap, rank: coin.market_cap_rank } : null;
  return {
    monero: coinMarket(byId.monero),
    zcash: coinMarket(byId.zcash),
    totalCryptoMarketCapUsd: Math.round(global.data.total_market_cap.usd),
    privacyCoinsMarketCapUsd: privacyCoins ? Math.round(privacyCoins.market_cap) : null,
  };
}

// --- DefiLlama TVL for on-chain privacy protocols (keyless) ---
// Adjacent indicator, not the literal prediction: privacy *layers* on
// transparent chains. Agent adoption here tests the article's mechanism
// (demand for fungibility) while competing with privacy coins as the venue.

const PRIVACY_PROTOCOLS = ['railgun', 'tornado-cash', 'privacy-pools'];

async function fetchOnchainPrivacyTvl() {
  const series = {};
  for (const slug of PRIVACY_PROTOCOLS) {
    const body = await fetchJson(`https://api.llama.fi/protocol/${slug}`);
    series[slug] = body.tvl.map((point) => [
      new Date(point.date * 1000).toISOString().slice(0, 10),
      Math.round(point.totalLiquidityUSD),
    ]);
  }
  return series;
}

// --- bitinfocharts Monero series (scrape; data embedded in page JS) ---

async function fetchBitinfochartsSeries(page) {
  const html = await fetchText(`https://bitinfocharts.com/comparison/${page}.html`, {
    'User-Agent': BROWSER_UA,
  });
  const pairs = [...html.matchAll(/\[new Date\("(\d{4})\/(\d{2})\/(\d{2})"\),(\d+(?:\.\d+)?)\]/g)];
  if (pairs.length < 1000) throw new Error(`parsed only ${pairs.length} points — page layout changed?`);
  const today = new Date().toISOString().slice(0, 10);
  return pairs
    .map(([, yyyy, mm, dd, value]) => [`${yyyy}-${mm}-${dd}`, parseFloat(value)])
    .filter((row) => row[0] !== today); // intraday current-day point breaks immutability
}

async function fetchMoneroSeries() {
  const txPerDay = await fetchBitinfochartsSeries('monero-transactions');
  // Fees are public on-chain even though amounts are hidden; average fee per
  // tx in USD. Total fees/day ≈ avgFeeUsd × txPerDay. Optional: tx series
  // still ships if the fee page breaks.
  let avgFeeUsd = null;
  try {
    avgFeeUsd = await fetchBitinfochartsSeries('monero-transactionfees');
  } catch (error) {
    console.warn(`[warn] monero fee series: ${error.message}`);
  }
  return { txPerDay, avgFeeUsd };
}

// Full-history daily price + market cap, plus BTC tx/day as the transparent
// crypto baseline. CoinGecko's public API caps market_chart at 365 days, so
// this rides the bitinfocharts scrape instead.
async function fetchMarketSeries() {
  const series = {};
  for (const id of ['monero', 'zcash']) {
    series[id] = { priceUsd: await fetchBitinfochartsSeries(`${id}-price`) };
  }
  // Market-cap history is Monero-only on purpose. The zcash-marketcap page
  // stopped updating 2026-07-18 and the breakage was invisible for two months
  // because nothing read the field — and, checked 2026-09-16, THE PAGE SHOWS NO
  // ZEC MARKET CAP AT ALL: the only market-cap series charted is xmrMcap (see
  // derive-pc-series.js), and ZEC market cap appears on the page once, as prose
  // in a 2025 timeline entry. Dropped rather than repaired — one fewer fragile
  // scrape. (XMR market cap IS charted, so its page stays.)
  series.monero.marketCapUsd = await fetchBitinfochartsSeries('monero-marketcap');
  series.bitcoinTxPerDay = await fetchBitinfochartsSeries('bitcoin-transactions');
  return series;
}

// Normalize a month value ("2026-03-01 00:00:00.000 UTC" or "2026-03-01") to a
// 'YYYY-MM-01' key.
function monthKey(value) {
  return `${String(value).slice(0, 7)}-01`;
}

// A count column off an on-chain reader → ascending [[month, n], ...].
function countColumn(result, key) {
  return (result?.rows ?? [])
    .map((r) => [monthKey(r.block_month), Number(r[key]) || 0])
    .filter(([m]) => m)
    .sort((a, b) => a[0].localeCompare(b[0]));
}

// Sum several [[month, n]] series into one (blacklisting is per-chain, so a
// token's true count is the cross-chain sum month by month). Absent/empty
// series contribute nothing — so this stays correct if a chain skips a run.
function sumMonthly(...seriesList) {
  const byMonth = new Map();
  for (const series of seriesList) {
    for (const [m, n] of series ?? []) byMonth.set(m, (byMonth.get(m) || 0) + n);
  }
  return [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

// --- output assembly ---

async function readExisting(folder, file, fallback) {
  if (!folder) return fallback;
  try {
    return JSON.parse(await fs.readFile(path.join(RAW_DIR, folder, file), 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeData(folder, file, data) {
  await fs.writeFile(path.join(RAW_DIR, folder, file), JSON.stringify(data, null, 2));
  console.log(`Wrote ${path.join('src/assets/data/privacy-coins/raw', folder, file)}`);
}

// Copy a hand-maintained seed (canonical copy under this repo's data/) into the dated
// folder so it resolves and caches exactly like a fetched series. Falls back to
// the previous folder's copy if the seed is missing. Editing the seed and
// rerunning this script is how the fiat-rails baseline advances.
async function seedForward(folder, prevFolder, file) {
  try {
    await fs.copyFile(path.join(DATA_DIR, file), path.join(RAW_DIR, folder, file));
    console.log(`[ok] seeded ${file} from data/${file}`);
  } catch {
    await carryForward(prevFolder, folder, file);
  }
}

async function carryForward(prevFolder, folder, file) {
  if (!prevFolder || prevFolder === folder) return;
  try {
    await fs.copyFile(path.join(RAW_DIR, prevFolder, file), path.join(RAW_DIR, folder, file));
    console.warn(`Carried ${file} forward unchanged from ${prevFolder}`);
  } catch {
    console.warn(`No previous ${file} to carry forward — file missing from this refresh`);
  }
}

function last(series) {
  return series && series.length ? series[series.length - 1] : null;
}

// Record the refresh as a frontmatter `updates` note on the article, the same
// way fetch-github-info.js stamps the gh-data articles. The SG layout reads the
// latest update date for its "Updated …" byline. Same-date entries are replaced
// so a same-day rerun doesn't duplicate.
async function stampArticleRefresh(date) {
  try {
    const parsed = matter(await fs.readFile(ARTICLE_FILE, 'utf8'), { preserve: true });
    // A note already written for this date (e.g. what a refresh changed) is kept,
    // not replaced by the generic stamp.
    const updates = parsed.data.updates || [];
    if (!updates.some((u) => u.date === date)) updates.push({ date, note: 'Tracker data refreshed' });
    parsed.data.updates = updates;
    await fs.writeFile(ARTICLE_FILE, matter.stringify(parsed.content, parsed.data));
    console.log(`Stamped refresh date ${date} into ${path.relative(path.join(__dirname, '..'), ARTICLE_FILE)}`);
  } catch (error) {
    console.error(`Failed to stamp refresh date into the article: ${error.message}`);
  }
}

async function main() {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const folder = today.slice(2).replaceAll('-', '');

  await fs.mkdir(path.join(RAW_DIR, folder), { recursive: true });
  const datedFolders = (await fs.readdir(RAW_DIR)).filter((name) => /^\d{6}$/.test(name)).sort();
  // History is read from the latest earlier folder. On a same-day rerun the first
  // run has already deleted that folder, so today's folder is the history: falling
  // back to null would merge fresh suffixes onto nothing and drop unfetched series.
  const prevFolder = datedFolders.filter((name) => name !== folder).pop() ?? folder;

  const [
    x402AllTime,
    x402Trailing30d,
    x402Series,
    moneroChain,
    zcashChain,
    market,
    zcashSeries,
    moneroSeries,
    marketSeries,
    stablecoinSeries,
    onchainPrivacyTvl,
    railgunFlows,
    tornadoFlows,
    privacyPoolsFlows,
    baseFreezes,
    ethBlacklist,
    tronBlacklist,
  ] = await Promise.all([
    safe('x402scan all-time', () => fetchX402(0)),
    safe('x402scan trailing-30d', () => fetchX402(30)),
    safe('x402scan bucketed series', fetchX402Series),
    safe('blockchair monero', () => fetchBlockchairStats('monero')),
    safe('blockchair zcash', () => fetchBlockchairStats('zcash')),
    safe('coingecko', fetchCoinGecko),
    safe('zechub series', fetchZcashSeries),
    safe('bitinfocharts monero', fetchMoneroSeries),
    safe('bitinfocharts market history', fetchMarketSeries),
    safe('coinmetrics stablecoin tx', fetchStablecoinSeries),
    safe('defillama privacy protocols', fetchOnchainPrivacyTvl),
    safe('railgun turnover (on-chain, eth+polygon+arbitrum)', () => fetchRailgunFlows(RAILGUN_FLOWS_CACHE)),
    safe('tornado turnover (on-chain)', () => fetchTornadoFlows(TORNADO_FLOWS_CACHE)),
    safe('privacy pools turnover (on-chain)', () => fetchPrivacyPoolsFlows(PRIVACY_POOLS_FLOWS_CACHE)),
    safe('base usdc freezes (on-chain)', () => fetchBaseFreezes(BASE_FREEZE_CACHE)),
    safe('ethereum blacklist counts + frozen value (on-chain)', () => fetchEthBlacklist(ETH_BLACKLIST_CACHE)),
    safe('tron usdt blacklist (trongrid)', () => fetchTronUsdtBlacklist(TRON_BLACKLIST_CACHE)),
  ]);

  if (x402Series) {
    await writeData(folder, 'x402-series.json', {
      source: 'https://www.x402scan.com (tRPC public.stats.bucketed; daily buckets, partial current day dropped)',
      fetchedAt: now,
      columns: ['date', 'txCount', 'volumeUsd', 'uniqueBuyers', 'uniqueSellers'],
      rows: x402Series,
    });
  } else {
    await carryForward(prevFolder, folder, 'x402-series.json');
  }
  if (zcashSeries) {
    await writeData(folder, 'zcash-series.json', {
      source: 'https://github.com/ZecHub/zechub-wiki (public/data/zcash)',
      fetchedAt: now,
      ...zcashSeries,
    });
  } else {
    await carryForward(prevFolder, folder, 'zcash-series.json');
  }
  if (moneroSeries) {
    await writeData(folder, 'monero-tx-series.json', {
      source: 'https://bitinfocharts.com/comparison/monero-{transactions,transactionfees}.html',
      fetchedAt: now,
      txPerDay: moneroSeries.txPerDay,
      avgFeeUsd: moneroSeries.avgFeeUsd,
    });
  } else {
    await carryForward(prevFolder, folder, 'monero-tx-series.json');
  }
  if (stablecoinSeries) {
    await writeData(folder, 'stablecoin-series.json', {
      source: 'https://community-api.coinmetrics.io/v4 (TxCnt daily; usdt/usdc are cross-chain aggregates)',
      fetchedAt: now,
      txPerDay: stablecoinSeries,
    });
  } else {
    await carryForward(prevFolder, folder, 'stablecoin-series.json');
  }
  if (marketSeries) {
    await writeData(folder, 'market-series.json', {
      source:
        'https://bitinfocharts.com/comparison/{monero,zcash}-price.html + monero-marketcap.html + bitcoin-transactions.html',
      fetchedAt: now,
      ...marketSeries,
    });
  } else {
    await carryForward(prevFolder, folder, 'market-series.json');
  }
  if (onchainPrivacyTvl) {
    await writeData(folder, 'onchain-privacy-series.json', {
      source: 'https://api.llama.fi/protocol/<slug>',
      fetchedAt: now,
      tvlUsd: onchainPrivacyTvl,
    });
  } else {
    await carryForward(prevFolder, folder, 'onchain-privacy-series.json');
  }

  // Fiat-rail baselines (Visa quarterly + UPI monthly) — hand-maintained seed,
  // copied into the folder each run (see fiat-rails-series.json header above).
  await seedForward(folder, prevFolder, 'fiat-rails-series.json');

  // The three outputs below are read on-chain, not queried. They keep the Dune
  // era's { columns, rows } SHAPE on purpose — countColumn() here and
  // derive-pc-series.js in the site key on those columns, so the shape is still
  // the contract even though the source, and now the filenames, are gone.

  // Privacy-layer flows — per-month gross stablecoin turnover by protocol, now
  // read on-chain (no Dune). Each reader returns FULL history off its own event
  // cache, so there is no prefix to splice and no mergeMonthly(): a protocol
  // that fetched replaces its series outright, and one that failed keeps the
  // carried-forward copy.
  const prevFlows = await readExisting(prevFolder, 'privacy-flows.json', { protocols: {} });
  const flowResults = { railgun: railgunFlows, tornado: tornadoFlows, privacyPools: privacyPoolsFlows };
  const protocols = {};
  for (const [name, result] of Object.entries(flowResults)) {
    const prev = prevFlows.protocols?.[name] ?? null;
    if (result) {
      protocols[name] = { source: 'on-chain', readThrough: result.chains ?? result.scannedThrough, monthly: result.monthly };
    } else if (prev) {
      protocols[name] = prev; // failed this run — keep the cached history
    }
  }
  if (Object.keys(protocols).length) {
    await writeData(folder, 'privacy-flows.json', {
      source:
        'On-chain — per-month gross stablecoin turnover by privacy protocol. Railgun: Ethereum+Polygon+Arbitrum transfers (BNB out of scope, no keyless archive route). Tornado: Deposit/Withdrawal events x instance denomination. Privacy Pools: stablecoin transfers, matched by contract address not symbol.',
      fetchedAt: now,
      protocols,
    });
  } else {
    await carryForward(prevFolder, folder, 'privacy-flows.json');
  }

  if (baseFreezes) {
    await writeData(folder, 'base-freezes.json', {
      source: 'Base chain — USDC (0x8335…2913) Blacklisted events, read on-chain',
      fetchedAt: now,
      ...baseFreezes,
    });
  } else {
    await carryForward(prevFolder, folder, 'base-freezes.json');
  }

  // Blacklist (taint backdrop, §7): counts = monthly new blacklisted/frozen
  // addresses summed across chains (full history → replace); value = current
  // frozen balance of still-blacklisted addresses (Ethereum-only, on-chain).
  // Each part keeps the previous folder's copy if not fetched this run.
  const prevBlacklist = await readExisting(prevFolder, 'stablecoin-blacklist.json', {});
  const blacklist = {
    source:
      'Stablecoin blacklist counts — USDC: Ethereum; USDT: Ethereum + Tron. Ethereum read on-chain, Tron via TronGrid. Solana is excluded: its freezes are SPL FreezeAccount instructions with no log index, and no keyless source serves the history (see the runbook). Ethereum frozen value read on-chain (balanceOf of still-blacklisted addresses).',
    fetchedAt: now,
  };
  // Per-contract-per-chain blacklisting → a token's true count is the sum over
  // the chains in scope. USDT: Eth + Tron; USDC: Eth alone (Circle dropped Tron
  // in 2024). Both are required: with only two sources, letting one missing
  // chain through would publish a total short by most of it, so a failure
  // carries the previous whole total forward instead.
  if (ethBlacklist && tronBlacklist) {
    blacklist.counts = {
      chains: {
        ethereum: `on-chain @ block ${ethBlacklist.value.block}`,
        tron: `trongrid @ ${tronBlacklist.scannedThrough}`,
      },
      usdc: countColumn(ethBlacklist.counts, 'usdc_blacklisted'),
      usdt: sumMonthly(
        countColumn(ethBlacklist.counts, 'usdt_blacklisted'),
        countColumn(tronBlacklist, 'usdt_blacklisted')
      ),
    };
  } else if (prevBlacklist.counts) {
    blacklist.counts = prevBlacklist.counts;
  }
  if (ethBlacklist) {
    blacklist.value = ethBlacklist.value;
  } else if (prevBlacklist.value) {
    blacklist.value = prevBlacklist.value;
  }
  if (blacklist.counts || blacklist.value) {
    await writeData(folder, 'stablecoin-blacklist.json', blacklist);
  } else {
    await carryForward(prevFolder, folder, 'stablecoin-blacklist.json');
  }

  const latestShieldedSupply = last(zcashSeries?.shieldedSupply);
  const latestShieldedTx = last(zcashSeries?.shieldedTxPerDay.rows);
  const latestMoneroTx = last(moneroSeries?.txPerDay);

  const snapshot = {
    date: today,
    fetchedAt: now,
    x402: x402AllTime && {
      allTime: x402AllTime,
      trailing30d: x402Trailing30d,
      belowPeak: x402Series ? x402PeakStats(x402Series) : undefined,
    },
    monero: moneroChain && {
      txCumulative: moneroChain.transactions,
      txPerDay: latestMoneroTx && { date: latestMoneroTx[0], count: latestMoneroTx[1] },
      hashrate24h: moneroChain.hashrate_24h,
      ...(market?.monero ?? {}),
    },
    zcash: zcashChain && {
      txCumulative: zcashChain.transactions,
      tx24h: zcashChain.transactions_24h,
      hashrate24h: Number(zcashChain.hashrate_24h),
      shieldedSupplyZec: latestShieldedSupply && {
        date: latestShieldedSupply[0],
        zec: latestShieldedSupply[1],
      },
      shieldedTxPerDay: latestShieldedTx && {
        date: latestShieldedTx[0],
        count: latestShieldedTx.slice(1).reduce((a, b) => a + b, 0),
      },
      ...(market?.zcash ?? {}),
    },
    market: market && {
      totalCryptoMarketCapUsd: market.totalCryptoMarketCapUsd,
      privacyCoinsMarketCapUsd: market.privacyCoinsMarketCapUsd,
    },
    onchainPrivacyTvlUsd:
      onchainPrivacyTvl &&
      Object.fromEntries(Object.entries(onchainPrivacyTvl).map(([slug, series]) => [slug, last(series)?.[1]])),
  };

  const snapshots = await readExisting(prevFolder, 'snapshots.json', { snapshots: [] });
  snapshots.snapshots = snapshots.snapshots.filter((entry) => entry.date !== today);
  snapshots.snapshots.push(snapshot);
  snapshots.snapshots.sort((a, b) => a.date.localeCompare(b.date));
  snapshots.lastUpdated = now;
  await writeData(folder, 'snapshots.json', snapshots);

  for (const stale of datedFolders.filter((name) => name !== folder)) {
    await fs.rm(path.join(RAW_DIR, stale), { recursive: true });
    console.log(`Deleted superseded folder raw/${stale}`);
  }
  await fs.writeFile(POINTER_FILE, JSON.stringify({ folder, updatedAt: now }, null, 2) + '\n');
  console.log(`Wrote src/_data/pcStats.json (folder: ${folder})`);
  await stampArticleRefresh(today);

  if (failedSources.length) {
    console.warn(`Done with ${failedSources.length} failed source(s): ${failedSources.join('; ')}`);
  } else {
    console.log('Done — all sources fetched');
  }
}

main();
