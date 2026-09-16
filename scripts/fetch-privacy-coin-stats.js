import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';
import { fetchEthFrozenValue } from './eth-frozen-value.js';
import { fetchBaseFreezes } from './base-usdc-freezes.js';

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
//                         (x402scan, Blockchair chain stats, CoinGecko market data)
//   x402-series.json      full daily x402 tx/volume/buyers/sellers history
//                         (x402scan tRPC public.stats.bucketed)
//   monero-tx-series.json full daily tx-count + avg-fee-USD history
//                         (bitinfocharts scrape — fragile, unofficial; amounts
//                         are hidden by design, tx count and fees are the
//                         public on-chain activity proxies)
//   market-series.json    full daily price + market-cap history for XMR/ZEC
//                         (bitinfocharts scrape; CoinGecko's public API caps
//                         history at 365 days)
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
//   dune-privacy-flows.json / dune-base-freeze.json / dune-blacklist.json
//                         OPTIONAL, keyed (DUNE_API_KEY); absent on keyless runs.
//                         privacy-flows: per-protocol per-month stablecoin
//                         turnover (railgun suffix + repo-cached prefix; tornado
//                         + PP full). base-freeze: USDC Blacklisted events on
//                         Base (on-chain, keyless — base-usdc-freezes.js).
//                         blacklist: USDC/USDT blacklist counts (monthly, Dune)
//                         + Ethereum frozen-value snapshot (on-chain, keyless —
//                         eth-frozen-value.js).
//                         See _notes/DUNE-SETUP.md
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
// source (skip()) also returns null but is not a failure, which is why the
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
    series[id] = {
      priceUsd: await fetchBitinfochartsSeries(`${id}-price`),
      marketCapUsd: await fetchBitinfochartsSeries(`${id}-marketcap`),
    };
  }
  series.bitcoinTxPerDay = await fetchBitinfochartsSeries('bitcoin-transactions');
  return series;
}

// --- Dune Analytics (optional, keyed) ---
// Reads the LATEST cached results of queries we OWN on Dune. Auth via
// DUNE_API_KEY in .env. The free plan cannot execute queries over the API
// (manual editor runs only), so the refresh runbook is: open each query in
// the Dune editor and click Run, THEN run this script — which reads the
// freshly-cached results here. See _notes/DUNE-SETUP.md. Since 2026-09-10 the
// free plan is view-only, so this path is dead once the Plus trial lapses; the
// on-chain readers replacing it are checked against baselines/dune-2026-09-15/.
//
// Every Dune series is optional + fail-soft: no key (the keyless-contributor
// default) or an unconfigured query id => the series is skipped and the
// previous folder's copy is carried forward, so keyless stays the default and
// keyed gets the richer data. Query ids are public (not secrets) and shared
// across contributors, so they live in version control here, not in .env.

const DUNE_API_KEY = process.env.DUNE_API_KEY || null;

// The free plan can't execute via API, so the runbook is: Run each query in the
// Dune editor, THEN run this script (which reads the freshly-cached results).
// Warn if a query's cached execution is older than this — a sign it wasn't
// re-Run before the refresh, so the data would be stale.
const DUNE_STALE_AFTER_DAYS = 45;

// Query ids are public (not secrets) → version-controlled here. All ours now;
// see .claude/skills/private-canary-refresh/queries/ and _notes/DUNE-SETUP.md.
const DUNE_QUERIES = {
  // Privacy-layer flows — per-month stablecoin turnover. Railgun returns only a
  // recent SUFFIX (heavy → prefix cached in repo, seeded once from @amlbot's
  // 6702283 de-cumulated); Tornado + PP return FULL history (cheap). mergeMonthly
  // handles both: full replaces all, suffix replaces just its recent overlap.
  railgunTurnover: 7714782, // SUFFIX (dune-railgun-turnover-recent.sql, {{since}})
  tornadoTurnover: 7714895, // FULL (dune-tornado-turnover.sql)
  privacyPools: 7714910, // FULL (dune-privacy-pools-turnover.sql)
  // Taint backdrop (§7). Counts = monthly new blacklisted/frozen addresses,
  // summed across chains (blacklisting is per-contract-per-chain). Eth carries
  // both stablecoins; Tron carries USDT (~71% of all-time USDT freezes); Solana
  // freezes token accounts via SPL FreezeAccount (tiny by count). Frozen value
  // is read on-chain now (eth-frozen-value.js), not from Dune.
  blacklistCounts: 7714982, // FULL, Ethereum USDC+USDT (dune-blacklist-counts.sql)
  usdtTronBlacklist: 7715354, // FULL, Tron USDT (usdt-tron-blacklist.sql)
  stablecoinSolanaFreezes: 7715332, // FULL, Solana USDC+USDT (stablecoin-solana-freezes.sql)
};

// Reads cached results only (no execute) — execution is unavailable on the
// free API tier. Follows next_uri pagination so multi-page series come back
// whole. Throws on a missing key/id or an unfinished execution; safe() and
// carryForward() handle the fallout.
async function fetchDuneResults(queryId) {
  if (!DUNE_API_KEY) throw new Error('no DUNE_API_KEY (keyless run)');
  if (!queryId) throw new Error('query id not configured');
  let url = `https://api.dune.com/api/v1/query/${queryId}/results?limit=10000`;
  const rows = [];
  let columns = [];
  let executedAt = null;
  let finished = false;
  let failure = null;
  for (let page = 0; url && page < 20; page++) {
    const res = await fetch(url, {
      headers: { 'X-Dune-API-Key': DUNE_API_KEY },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 120);
      throw new Error(`query ${queryId} returned ${res.status} ${detail}`);
    }
    const body = await res.json();
    finished = body.is_execution_finished ?? finished;
    // A failed run is "finished" too, with no rows — without this it reads as
    // an empty success and overwrites the carried-forward series.
    if (body.state && body.state !== 'QUERY_STATE_COMPLETED') failure = `${body.state}: ${body.error?.type ?? ''}`;
    columns = body.result?.metadata?.column_names ?? columns;
    executedAt = body.execution_ended_at ?? executedAt;
    rows.push(...(body.result?.rows ?? []));
    url = body.next_uri ?? null;
  }
  if (!finished) throw new Error(`query ${queryId} has no finished execution — Run it in the Dune editor first`);
  if (failure) throw new Error(`query ${queryId} latest execution ${failure}`);
  return { queryId, executedAt, columns, rows };
}

function skip(label) {
  console.log(`[skip] ${label} — no key or query id; carrying forward`);
  return null;
}

// Normalize a Dune month value ("2026-03-01 00:00:00.000 UTC" or "2026-03-01")
// to a 'YYYY-MM-01' key.
function monthKey(value) {
  return `${String(value).slice(0, 7)}-01`;
}

// A turnover query's rows → ascending [[month, usd], ...]. Queries expose
// block_month + trn_usd (per-month gross turnover; stablecoins ≈ $1 face value).
function rowsToMonthly(result) {
  return (result?.rows ?? [])
    .map((r) => [monthKey(r.block_month), Math.round(Number(r.trn_usd) * 100) / 100])
    .filter(([m, v]) => m && Number.isFinite(v))
    .sort((a, b) => a[0].localeCompare(b[0]));
}

// Splice `incoming` onto kept history: keep existing months strictly before the
// earliest incoming month, then take all incoming. A FULL series (incoming
// starts at history's beginning) replaces everything; a SUFFIX replaces only its
// recent overlap and appends new months. Same code path for both.
function mergeMonthly(existing, incoming) {
  if (!incoming?.length) return existing ?? [];
  const cut = incoming[0][0];
  const kept = (existing ?? []).filter(([m]) => m < cut);
  return [...kept, ...incoming].sort((a, b) => a[0].localeCompare(b[0]));
}

// A count column off a Dune result → ascending [[month, n], ...].
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

// Loud warning if a query's cached execution predates the refresh by too much —
// it usually means the query wasn't re-Run in the Dune editor first.
function warnIfStale(label, executedAt) {
  if (!executedAt) return;
  const ageDays = (Date.now() - new Date(executedAt).getTime()) / 86400000;
  if (ageDays > DUNE_STALE_AFTER_DAYS) {
    console.warn(
      `[STALE] dune ${label}: cached execution is ${Math.round(ageDays)}d old (${executedAt}) — re-Run it in Dune`
    );
  }
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
    duneRailgun,
    duneTornado,
    dunePrivacyPools,
    baseFreezes,
    duneBlacklistCounts,
    duneUsdtTron,
    duneSolanaFreezes,
    ethFrozenValue,
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
    DUNE_API_KEY && DUNE_QUERIES.railgunTurnover
      ? safe('dune railgun turnover (recent suffix)', () => fetchDuneResults(DUNE_QUERIES.railgunTurnover))
      : skip('dune railgun turnover'),
    DUNE_API_KEY && DUNE_QUERIES.tornadoTurnover
      ? safe('dune tornado turnover (full)', () => fetchDuneResults(DUNE_QUERIES.tornadoTurnover))
      : skip('dune tornado turnover'),
    DUNE_API_KEY && DUNE_QUERIES.privacyPools
      ? safe('dune privacy pools turnover', () => fetchDuneResults(DUNE_QUERIES.privacyPools))
      : skip('dune privacy pools turnover'),
    safe('base usdc freezes (on-chain)', () => fetchBaseFreezes(BASE_FREEZE_CACHE)),
    DUNE_API_KEY && DUNE_QUERIES.blacklistCounts
      ? safe('dune blacklist counts (eth)', () => fetchDuneResults(DUNE_QUERIES.blacklistCounts))
      : skip('dune blacklist counts (eth)'),
    DUNE_API_KEY && DUNE_QUERIES.usdtTronBlacklist
      ? safe('dune usdt blacklist (tron)', () => fetchDuneResults(DUNE_QUERIES.usdtTronBlacklist))
      : skip('dune usdt blacklist (tron)'),
    DUNE_API_KEY && DUNE_QUERIES.stablecoinSolanaFreezes
      ? safe('dune stablecoin freezes (solana)', () => fetchDuneResults(DUNE_QUERIES.stablecoinSolanaFreezes))
      : skip('dune stablecoin freezes (solana)'),
    safe('ethereum frozen value (on-chain)', () => fetchEthFrozenValue(ETH_BLACKLIST_CACHE)),
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
      source: 'https://bitinfocharts.com/comparison/{monero,zcash}-{price,marketcap}.html + bitcoin-transactions.html',
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

  // Dune series: persist each query result verbatim (columns + rows). Build-time
  // shaping into chart series happens in pcData.js against these real columns.

  // Privacy-layer flows — per-month gross stablecoin turnover by protocol. Each
  // protocol's series is merged onto the carried-forward history: Railgun's query
  // returns only a recent suffix (the prefix stays cached in the repo, seeded once
  // from @amlbot — see seed-privacy-flows.mjs); Tornado + PP return full history.
  // mergeMonthly() handles both. pcData.js cumulates these for the chart.
  const prevFlows = await readExisting(prevFolder, 'dune-privacy-flows.json', { protocols: {} });
  const flowResults = { railgun: duneRailgun, tornado: duneTornado, privacyPools: dunePrivacyPools };
  const protocols = {};
  for (const [name, result] of Object.entries(flowResults)) {
    const prev = prevFlows.protocols?.[name] ?? null;
    if (result) {
      warnIfStale(name, result.executedAt);
      protocols[name] = {
        queryId: result.queryId,
        executedAt: result.executedAt,
        monthly: mergeMonthly(prev?.monthly, rowsToMonthly(result)),
      };
    } else if (prev) {
      protocols[name] = prev; // no fetch this run — keep the cached history
    }
  }
  if (Object.keys(protocols).length) {
    await writeData(folder, 'dune-privacy-flows.json', {
      source:
        'Dune Analytics — per-month gross stablecoin turnover by privacy protocol (our queries 7714782/7714895/7714910; Railgun prefix seeded from @amlbot 6702283).',
      fetchedAt: now,
      protocols,
    });
  } else {
    await carryForward(prevFolder, folder, 'dune-privacy-flows.json');
  }

  if (baseFreezes) {
    // File name kept from the Dune era: it is the site's input contract.
    await writeData(folder, 'dune-base-freeze.json', {
      source: 'Base chain — USDC (0x8335…2913) Blacklisted events, read on-chain',
      fetchedAt: now,
      ...baseFreezes,
    });
  } else {
    await carryForward(prevFolder, folder, 'dune-base-freeze.json');
  }

  // Blacklist (taint backdrop, §7): counts = monthly new blacklisted/frozen
  // addresses summed across chains (full history → replace); value = current
  // frozen balance of still-blacklisted addresses (Ethereum-only, on-chain).
  // Each part keeps the previous folder's copy if not fetched this run.
  const prevBlacklist = await readExisting(prevFolder, 'dune-blacklist.json', {});
  const blacklist = {
    source:
      'Dune Analytics — stablecoin blacklist/freeze counts (USDT: Eth 7714982 + Tron 7715354 + Solana 7715332; USDC: Eth + Solana); Ethereum frozen value read on-chain (balanceOf of still-blacklisted addresses).',
    fetchedAt: now,
  };
  if (duneBlacklistCounts || duneUsdtTron || duneSolanaFreezes) {
    warnIfStale('blacklist counts (eth)', duneBlacklistCounts?.executedAt);
    warnIfStale('usdt blacklist (tron)', duneUsdtTron?.executedAt);
    warnIfStale('stablecoin freezes (solana)', duneSolanaFreezes?.executedAt);
    // Per-contract-per-chain blacklisting → a token's true count is the
    // cross-chain sum. USDT: Eth + Tron + Solana; USDC: Eth + Solana (Circle
    // dropped Tron in 2024). A chain absent this run contributes nothing — the
    // [skip]/[FAIL]/[STALE] lines flag it for the human-gated refresh.
    blacklist.counts = {
      chains: {
        ethereum: duneBlacklistCounts?.queryId ?? null,
        tron: duneUsdtTron?.queryId ?? null,
        solana: duneSolanaFreezes?.queryId ?? null,
      },
      executedAt: duneBlacklistCounts?.executedAt ?? null,
      usdc: sumMonthly(
        countColumn(duneBlacklistCounts, 'usdc_blacklisted'),
        countColumn(duneSolanaFreezes, 'usdc_frozen')
      ),
      usdt: sumMonthly(
        countColumn(duneBlacklistCounts, 'usdt_blacklisted'),
        countColumn(duneUsdtTron, 'usdt_blacklisted'),
        countColumn(duneSolanaFreezes, 'usdt_frozen')
      ),
    };
  } else if (prevBlacklist.counts) {
    blacklist.counts = prevBlacklist.counts;
  }
  if (ethFrozenValue) {
    blacklist.value = ethFrozenValue;
  } else if (prevBlacklist.value) {
    blacklist.value = prevBlacklist.value;
  }
  if (blacklist.counts || blacklist.value) {
    await writeData(folder, 'dune-blacklist.json', blacklist);
  } else {
    await carryForward(prevFolder, folder, 'dune-blacklist.json');
  }

  const latestShieldedSupply = last(zcashSeries?.shieldedSupply);
  const latestShieldedTx = last(zcashSeries?.shieldedTxPerDay.rows);
  const latestMoneroTx = last(moneroSeries?.txPerDay);

  const snapshot = {
    date: today,
    fetchedAt: now,
    x402: x402AllTime && { allTime: x402AllTime, trailing30d: x402Trailing30d },
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
