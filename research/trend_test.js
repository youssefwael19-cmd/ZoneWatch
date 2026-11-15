/**
 * Portfolio trend-following test, with realistic retail spreads.
 *
 * Implements the documented time-series momentum rule (Moskowitz/Ooi/Pedersen,
 * Hurst et al.): go long when price is above where it was N days ago, short when
 * below, rebalance daily, no discretion.
 *
 * Everything is walk-forward: the lookback is chosen on earlier data and scored
 * on the block it has never seen. Spreads are charged on every position change,
 * because that is the cost that kills retail strategies.
 *
 * Run: node research/trend_test.js
 */

const candlesMod = require("../server/candles");

const MARKETS = [
  { tkr: "GC=F", sym: "XAUUSD", spread: 0.30 },
  { tkr: "^NDX", sym: "NASDAQ", spread: 2.0 },
  { tkr: "EURUSD=X", sym: "EURUSD", spread: 0.00012 },
  { tkr: "GBPUSD=X", sym: "GBPUSD", spread: 0.00016 },
  { tkr: "USDJPY=X", sym: "USDJPY", spread: 0.012 },
  { tkr: "AUDUSD=X", sym: "AUDUSD", spread: 0.00014 },
  { tkr: "USDCAD=X", sym: "USDCAD", spread: 0.00018 },
  { tkr: "USDCHF=X", sym: "USDCHF", spread: 0.00018 },
  { tkr: "AUDJPY=X", sym: "AUDJPY", spread: 0.018 },
  { tkr: "NZDJPY=X", sym: "NZDJPY", spread: 0.022 },
];

const LOOKBACKS = [20, 50, 100, 200];
const FOLDS = 4;

/**
 * Daily returns of the strategy for one market over [from, to).
 *
 * The signal is read from the PREVIOUS close and applied to today's return.
 * Using today's close to choose today's position is the classic lookahead bug
 * that produces impossible Sharpe ratios.
 */
function runMarket(bars, lookback, spread, from, to) {
  const rets = [];
  let prevPos = 0;

  for (let i = Math.max(from, lookback + 2); i < to; i++) {
    const signalBar = bars[i - 1];
    const referenceBar = bars[i - 1 - lookback];
    const today = bars[i];
    if (!signalBar || !referenceBar || !today) continue;
    if (![signalBar.c, referenceBar.c, today.c, bars[i - 1].c].every(Number.isFinite)) continue;

    const pos = signalBar.c > referenceBar.c ? 1 : signalBar.c < referenceBar.c ? -1 : 0;
    const ret = (today.c - bars[i - 1].c) / bars[i - 1].c;

    // Half the spread on each side traded; a full flip costs one full spread.
    const turnover = Math.abs(pos - prevPos);
    const cost = (turnover * spread) / 2 / bars[i - 1].c;

    rets.push(pos * ret - cost);
    prevPos = pos;
  }
  return rets;
}

function stats(rets) {
  const n = rets.length;
  if (!n) return { n: 0, sharpe: null, cagr: null, maxDD: null };
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1 || 1);
  const sd = Math.sqrt(variance);
  const sharpe = sd ? (mean / sd) * Math.sqrt(252) : 0;

  let equity = 1;
  let peak = 1;
  let maxDD = 0;
  for (const r of rets) {
    equity *= 1 + r;
    peak = Math.max(peak, equity);
    maxDD = Math.min(maxDD, equity / peak - 1);
  }
  const years = n / 252;
  const cagr = years > 0 ? Math.pow(equity, 1 / years) - 1 : 0;

  return {
    n,
    sharpe: Number(sharpe.toFixed(2)),
    cagr: Number((cagr * 100).toFixed(1)),
    maxDD: Number((maxDD * 100).toFixed(1)),
  };
}

function pool(list) {
  // Average across markets day-aligned by index position from the end.
  const len = Math.max(...list.map((r) => r.length));
  const out = new Array(len).fill(0);
  for (const rets of list) {
    const offset = len - rets.length;
    for (let i = 0; i < rets.length; i++) out[offset + i] += rets[i] / list.length;
  }
  return out;
}

async function main() {
  const data = [];
  for (const m of MARKETS) {
    try {
      const bars = await candlesMod.getCandles(m.tkr, "1d", "10y");
      data.push({ ...m, bars });
      console.log(
        `${m.sym.padEnd(7)} ${String(bars.length).padStart(5)} bars  ${new Date(bars[0].t).toISOString().slice(0, 10)} → ${new Date(bars[bars.length - 1].t).toISOString().slice(0, 10)}`
      );
    } catch (err) {
      console.log(`${m.sym}: no data (${err.message})`);
    }
  }

  if (!data.length) throw new Error("no data");

  // Common date range so markets are comparable
  const start = Math.max(...data.map((d) => d.bars[0].t));
  const end = Math.min(...data.map((d) => d.bars[d.bars.length - 1].t));
  console.log(`\ncommon window: ${new Date(start).toISOString().slice(0, 10)} → ${new Date(end).toISOString().slice(0, 10)}`);

  const aligned = data.map((d) => ({
    ...d,
    bars: d.bars.filter((b) => b.t >= start && b.t <= end),
  }));

  const minLen = Math.min(...aligned.map((d) => d.bars.length));
  for (const d of aligned) d.bars = d.bars.slice(-minLen);
  console.log(`aligned bars per market: ${minLen}`);

  const foldSize = Math.floor(minLen / FOLDS);
  const bounds = Array.from({ length: FOLDS + 1 }, (_, i) =>
    i === FOLDS ? minLen : i * foldSize
  );

  const steps = [];
  const oosPooled = [];

  for (let k = 0; k < FOLDS - 1; k++) {
    const trainEnd = bounds[k + 1];
    const testEnd = bounds[k + 2];

    let best = null;
    for (const lb of LOOKBACKS) {
      const pooled = pool(
        aligned.map((d) => runMarket(d.bars, lb, d.spread, 0, trainEnd))
      );
      const s = stats(pooled);
      if (!best || s.sharpe > best.s.sharpe) best = { lb, s };
    }

    const testPooled = pool(
      aligned.map((d) => runMarket(d.bars, best.lb, d.spread, trainEnd, testEnd))
    );
    const testStats = stats(testPooled);
    oosPooled.push(testPooled);

    steps.push({ step: k + 1, lb: best.lb, train: best.s, test: testStats });
    console.log(
      `step ${k + 1}: lookback ${best.lb}d (train Sharpe ${best.s.sharpe}, CAGR ${best.s.cagr}%) → ` +
        `OOS Sharpe ${testStats.sharpe}, CAGR ${testStats.cagr}%, maxDD ${testStats.maxDD}%`
    );
  }

  console.log("\n===== POOLED OUT-OF-SAMPLE PORTFOLIO =====");
  console.log(JSON.stringify(stats(pool(oosPooled)), null, 2));

  console.log("\n===== EACH MARKET, FIXED 100-DAY LOOKBACK (whole window) =====");
  const rows = aligned.map((d) => ({
    sym: d.sym,
    ...stats(runMarket(d.bars, 100, d.spread, 0, minLen)),
  }));
  rows.sort((a, b) => (b.sharpe ?? -9) - (a.sharpe ?? -9));
  for (const r of rows) {
    console.log(
      `  ${r.sym.padEnd(7)} Sharpe ${String(r.sharpe).padStart(6)}  CAGR ${String(r.cagr).padStart(6)}%  maxDD ${String(r.maxDD).padStart(7)}%`
    );
  }
}

main().catch((err) => {
  console.error("trend test failed:", err);
  process.exit(1);
});
