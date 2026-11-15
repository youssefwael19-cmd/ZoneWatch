/**
 * Walk-forward backtest.
 *
 * The point: the earlier 63% number came from one month of in-sample data.
 * This splits history into three consecutive blocks and, for each step,
 * tunes the two free parameters on the earlier blocks and then measures on the
 * block it has never seen. That is the honest test.
 *
 * Run: node backtest_walkforward.js
 */

const candlesMod = require("./server/candles");
const autozones = require("./server/autozones");

const SYMBOLS = [
  { tkr: "GC=F", sym: "XAUUSD", decimals: 2 },
  { tkr: "^NDX", sym: "NASDAQ", decimals: 1 },
];

const GRID = [];
for (const mult of [1.4, 1.8]) {
  for (const rr of [0.4, 0.6, 0.8, 1.0]) GRID.push({ mult, rr });
}

const WINDOW = 200;

function atrOf(bars, period = 14) {
  if (bars.length < period + 1) return null;
  const slice = bars.slice(-(period + 1));
  let sum = 0;
  for (let i = 1; i < slice.length; i++) {
    const b = slice[i];
    const p = slice[i - 1];
    sum += Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c));
  }
  return sum / period;
}

function simulate(bars, from, to, cfg) {
  const trades = [];

  for (let i = Math.max(from, WINDOW); i < to; i++) {
    const win = bars.slice(i - WINDOW, i + 1);
    const price = bars[i].c;

    const detected = autozones.detectZones(win, {
      displacementMult: cfg.mult,
      maxPerSide: 4,
    });
    if (!detected.length) continue;

    const zones = autozones.toAppZones("X", detected, { basisOffset: 0, decimals: 2 });
    const zone = zones.find((z) => price >= z.low && price <= z.high);
    if (!zone) continue;

    const side = zone.type === "demand" ? "BUY" : "SELL";
    const atr = atrOf(win, 14);
    if (!atr) continue;

    const stop = side === "BUY" ? zone.low - atr * 0.1 : zone.high + atr * 0.1;
    const risk = Math.abs(price - stop);
    if (!(risk > 0)) continue;

    const target = side === "BUY" ? price + risk * cfg.rr : price - risk * cfg.rr;

    let outcome = null;
    for (let j = i + 1; j < Math.min(i + 60, to); j++) {
      const b = bars[j];
      if (side === "BUY") {
        if (b.l <= stop) {
          outcome = "loss";
          break;
        }
        if (b.h >= target) {
          outcome = "win";
          break;
        }
      } else {
        if (b.h >= stop) {
          outcome = "loss";
          break;
        }
        if (b.l <= target) {
          outcome = "win";
          break;
        }
      }
    }

    if (outcome) trades.push(outcome === "win" ? cfg.rr : -1);
  }

  return trades;
}

function summarise(trades) {
  const n = trades.length;
  if (!n) return { n: 0, wins: 0, winrate: null, totalR: 0, expectancy: null };
  const wins = trades.filter((r) => r > 0).length;
  const totalR = trades.reduce((a, b) => a + b, 0);
  return {
    n,
    wins,
    winrate: Number(((wins / n) * 100).toFixed(1)),
    totalR: Number(totalR.toFixed(2)),
    expectancy: Number((totalR / n).toFixed(3)),
  };
}

async function main() {
  const oosAll = [];

  for (const s of SYMBOLS) {
    console.log(`\n===== ${s.sym} (${s.tkr}) =====`);
    const bars = await candlesMod.getCandles(s.tkr, "1h", "6mo");
    console.log(
      `bars: ${bars.length} | ${new Date(bars[0].t).toISOString().slice(0, 10)} → ${new Date(bars[bars.length - 1].t).toISOString().slice(0, 10)}`
    );

    const foldSize = Math.floor(bars.length / 3);
    const folds = [
      [0, foldSize],
      [foldSize, foldSize * 2],
      [foldSize * 2, bars.length],
    ];

    for (let k = 0; k < folds.length - 1; k++) {
      const trainEnd = folds[k][1];
      const testStart = folds[k + 1][0];
      const testEnd = folds[k + 1][1];

      let best = null;
      for (const cfg of GRID) {
        const trades = simulate(bars, 0, trainEnd, cfg);
        const sum = summarise(trades);
        if (!best || sum.totalR > best.sum.totalR) best = { cfg, sum };
      }

      const testTrades = simulate(bars, testStart, testEnd, best.cfg);
      const testSum = summarise(testTrades);
      oosAll.push(...testTrades);

      console.log(
        `fold ${k + 1}: tuned mult=${best.cfg.mult} rr=${best.cfg.rr} ` +
          `(train ${best.sum.n} trades, ${best.sum.totalR}R) → ` +
          `out-of-sample ${testSum.n} trades, ${testSum.winrate}% win, ${testSum.totalR}R`
      );
    }
  }

  console.log("\n===== OUT-OF-SAMPLE TOTAL =====");
  console.log(JSON.stringify(summarise(oosAll), null, 2));
}

main().catch((err) => {
  console.error("Backtest failed:", err);
  process.exit(1);
});
