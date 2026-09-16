// Distance below the all-time peak for x402, on ONE window definition.
//
// The article's 'x402 transactions sit N% below the November–December 2025
// peak' compares two trailing-30-day transaction totals from the daily series:
// the total to the last full day, and the highest such total anywhere in the
// history. Both come from the same rows, so the ratio cannot mix windows.
//
// Why this exists: the 2026-09-15 refresh hand-computed 56% (Sept) and 92%
// (June) with no recorded method, and no window definition reproduces that
// pair — the nearest is a calendar-month total as the peak against a
// trailing-30-day numerator. On this definition the figures are 62% and 93%,
// the latter matching the June reading and CoinDesk's ~2.5M/day peak. The
// article's Data Sources section states this definition; keep them in step.

const DAY_MS = 86_400_000;

function toDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// rows: [[date, txCount, ...], ...] — x402-series.json's `rows`.
export function x402PeakStats(rows, windowDays = 30) {
  const byDay = new Map(rows.map((r) => [r[0], r[1]]));
  const days = rows.map((r) => Date.parse(r[0])).sort((a, b) => a - b);
  if (days.length === 0) return null;
  const first = days[0];
  const last = days[days.length - 1];
  let peak = { txCount: -1, windowEnd: null };
  let current = null;
  let sum = 0;
  for (let end = first; end <= last; end += DAY_MS) {
    sum += byDay.get(toDay(end)) || 0;
    const dropped = end - windowDays * DAY_MS;
    if (dropped >= first) sum -= byDay.get(toDay(dropped)) || 0;
    current = { txCount: sum, windowEnd: toDay(end) };
    if (sum > peak.txCount) peak = { ...current };
  }
  return {
    windowDays,
    peak,
    current,
    belowPeakPct: Math.round((1 - current.txCount / peak.txCount) * 1000) / 10,
  };
}
