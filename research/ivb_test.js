/**
 * Fabio Valentini's IVB (Initial Balance breakout) — implemented and tested.
 *
 * Documented rules from his public interviews:
 *   1. Mark the first 30 minutes of the New York cash open (09:30–10:00 ET).
 *   2. That is the initial balance: high, low, and its volume profile.
 *   3. A break only counts when a 5-minute candle CLOSES outside the range.
 *   4. Do not chase the break — wait for a pullback toward the range edge / POC.
 *   5. Stop on the other side of the range; target 1:2 to 1:2.5.
 *   6. Stop for the day after 3 losing trades, max 2% daily loss.
 *
 * What is NOT implemented, because it needs paid data: the order-flow
 * confirmation (CVD delta, footprint absorption, large-lot prints >= 30
 * contracts). That filter is a real part of his process and its absence is
 * stated in the results.
 *
 * Run: node research/ivb_test.js
 */

const candlesMod = require("../server/candles");

const SYMBOLS = [
  { tkr: "^NDX", sym: "NASDAQ" },
  { tkr: "GC=F", sym: "XAUUSD" },
];

const RR = 2;
const NO_CHASE_BARS = 6; // wait up to 6 x 5m for the pullback
const MAX_BARS_AFTER_ENTRY = 60; // 5 hours

/** Is the US on daylight saving time at this date? */
function isUsDst(date) {
  const year = date.getUTCFullYear();
  const march = new Date(Date.UTC(year, 2, 1));
  const firstSundayMarch = 1 + ((7 - march.getUTCDay()) % 7);
  const dstStart = Date.UTC(year, 2, firstSundayMarch + 7, 7); // 2am ET = 7:00 UTC
  const nov = new Date(Date.UTC(year, 10, 1));
  const firstSundayNov = 1 + ((7 - nov.getUTCDay()) % 7);
  const dstEnd = Date.UTC(year, 10, firstSundayNov, 6); // 2am EDT = 6:00 UTC
  const t = date.getTime();
  return t >= dstStart && t < dstEnd;
}

/** 09:30 ET in UTC minutes. */
function nyOpenMinuteUtc(date) {
  return isUsDst(date) ? 13 * 60 + 30 : 14 * 60 + 30;
}

function minuteOfDayUtc(ts) {
  const d = new Date(ts);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Group 5m bars by UTC day. */
function groupByDay(bars) {
  const days = new Map();
  for (const bar of bars) {
    const key = dayKey(bar.t);
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(bar);
  }
  return days;
}

function runSymbol(bars) {
  const days = groupByDay(bars);
  const trades = [];

  for (const [day, dayBars] of days) {
    dayBars.sort((a, b) => a.t - b.t);
    const first = dayBars[0];
    const openMinute = nyOpenMinuteUtc(new Date(first.t));

    // Initial balance: the 30 minutes after the cash open
    const ibBars = dayBars.filter((b) => {
      const m = minuteOfDayUtc(b.t);
      return m >= openMinute && m < openMinute + 30;
    });
    if (ibBars.length < 4) continue; // incomplete session

    const ibHigh = Math.max(...ibBars.map((b) => b.h));
    const ibLow = Math.min(...ibBars.map((b) => b.l));
    const range = ibHigh - ibLow;
    if (!(range > 0)) continue;

    const after = dayBars.filter((b) => minuteOfDayUtc(b.t) >= openMinute + 30);
    if (after.length < 10) continue;

    // Find the first 5m close outside the initial balance
    let breakIndex = -1;
    let side = null;
    for (let i = 0; i < after.length; i++) {
      if (after[i].c > ibHigh) {
        breakIndex = i;
        side = "BUY";
        break;
      }
      if (after[i].c < ibLow) {
        breakIndex = i;
        side = "SELL";
        break;
      }
      // Session ends at 16:00 ET
      if (minuteOfDayUtc(after[i].t) >= openMinute + 390) break;
    }
    if (breakIndex === -1) continue;

    // Wait for a pullback toward the broken edge instead of chasing
    const edge = side === "BUY" ? ibHigh : ibLow;
    const tolerance = range * 0.15;
    let entryIndex = -1;
    for (let i = breakIndex; i < Math.min(breakIndex + NO_CHASE_BARS, after.length); i++) {
      const b = after[i];
      const near = side === "BUY" ? b.l <= edge + tolerance : b.h >= edge - tolerance;
      if (near) {
        entryIndex = i;
        break;
      }
    }
    if (entryIndex === -1) continue; // never pulled back — no trade, as per his rule

    const entryBar = after[entryIndex];
    // Entry at the edge, not the close, which is where the retest would fill.
    const entry = side === "BUY" ? Math.min(edge, entryBar.c) : Math.max(edge, entryBar.c);
    const stop = side === "BUY" ? ibLow : ibHigh;
    const risk = Math.abs(entry - stop);
    if (!(risk > 0)) continue;
    const target = side === "BUY" ? entry + risk * RR : entry - risk * RR;

    let outcome = null;
    for (let j = entryIndex + 1; j < Math.min(entryIndex + MAX_BARS_AFTER_ENTRY, after.length); j++) {
      const b = after[j];
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

    if (outcome) trades.push({ day, side, r: outcome === "win" ? RR : -1, range });
  }

  return trades;
}

function summarise(trades) {
  const n = trades.length;
  if (!n) return { n: 0, winrate: null, expectancy: null, totalR: 0 };
  const wins = trades.filter((t) => t.r > 0).length;
  const totalR = trades.reduce((a, t) => a + t.r, 0);
  return {
    n,
    winrate: Number(((wins / n) * 100).toFixed(1)),
    expectancy: Number((totalR / n).toFixed(3)),
    totalR: Number(totalR.toFixed(2)),
  };
}

async function main() {
  const all = [];

  for (const s of SYMBOLS) {
    const bars = await candlesMod.getCandles(s.tkr, "5m", "60d");
    console.log(`\n===== ${s.sym} =====`);
    if (!bars || bars.length < 100) {
      console.log("not enough 5m history");
      continue;
    }
    console.log(`${bars.length} bars from ${new Date(bars[0].t).toISOString().slice(0, 10)}`);

    const trades = runSymbol(bars);
    all.push(...trades.map((t) => ({ ...t, symbol: s.sym })));
    const sum = summarise(trades);
    console.log(`IVB trades (with pullback filter): ${JSON.stringify(sum)}`);

    if (trades.length) {
      const bySide = {
        BUY: summarise(trades.filter((t) => t.side === "BUY")),
        SELL: summarise(trades.filter((t) => t.side === "SELL")),
      };
      console.log(`  longs ${JSON.stringify(bySide.BUY)}`);
      console.log(`  shorts ${JSON.stringify(bySide.SELL)}`);
    }
  }

  console.log("\n===== COMBINED =====");
  console.log(JSON.stringify(summarise(all), null, 2));

  const n = all.length;
  if (n > 1) {
    const wins = all.filter((t) => t.r > 0).length;
    const p = wins / n;
    const se = Math.sqrt((p * (1 - p)) / n);
    console.log(
      `95% range on win rate: ${((p - 1.96 * se) * 100).toFixed(1)}% – ${((p + 1.96 * se) * 100).toFixed(1)}%`
    );
  }
}

main().catch((err) => {
  console.error("ivb test failed:", err);
  process.exit(1);
});
