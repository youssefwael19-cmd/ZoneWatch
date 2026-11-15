const candlesMod = require('./server/candles');
const autozones = require('./server/autozones');
const signalsMod = require('./server/signals');

const SYMBOLS = [
  { tkr: 'GC=F', sym: 'XAUUSD' },
  { tkr: '^NDX', sym: 'NASDAQ' }
];

async function testConfig(config) {
  let allTrades = [];
  for (const s of SYMBOLS) {
    const allBars = await candlesMod.getCandles(s.tkr, '15m', '1mo');
    const trades = [];
    const minHistory = 60;
    
    for (let i = minHistory; i < allBars.length - 10; i++) {
      const currentBars = allBars.slice(0, i + 1);
      const currentPrice = currentBars[currentBars.length - 1].c;
      
      const detected = autozones.detectZones(currentBars, { 
        displacementMult: config.displacementMult || 1.4,
        maxPerSide: config.maxPerSide || 4 
      });
      if (detected.length === 0) continue;
      
      const zones = autozones.toAppZones(s.sym, detected, { 
        basisOffset: 0,
        decimals: s.sym === 'XAUUSD' ? 2 : 1 
      });
      
      // Custom scoring based on config
      if (!Array.isArray(currentBars) || currentBars.length < 60) continue;
      if (!Number.isFinite(currentPrice)) continue;
      
      const closes = currentBars.map((b) => b.c);
      // Simple EMA
      function ema(values, period) {
        const k = 2 / (period + 1);
        let prev = values[0];
        const out = [prev];
        for (let j = 1; j < values.length; j++) {
          prev = values[j] * k + prev * (1 - k);
          out.push(prev);
        }
        return out;
      }
      const fast = ema(closes, 20)[ema(closes,20).length-1];
      const slow = ema(closes, 50)[ema(closes,50).length-1];
      const trend = fast > slow ? "up" : fast < slow ? "down" : "flat";
      
      // ATR
      function atrValue(bars, period = 14) {
        if (bars.length < period + 1) return null;
        const slice = bars.slice(-(period + 1));
        let sum = 0;
        for (let j = 1; j < slice.length; j++) {
          const b = slice[j];
          const p = slice[j - 1];
          sum += Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c));
        }
        return sum / period;
      }
      const atr = atrValue(currentBars, 14) || 0;
      const bar = currentBars[currentBars.length - 1];
      
      const reach = atr * (config.reachMult || 0.35);
      const candidates = zones.filter((z) => priceIsNear(currentPrice, z, reach));
      if (!candidates.length) continue;
      
      function priceIsNear(p, z, r) {
        if (p >= z.low && p <= z.high) return true;
        return (p > z.high && p - z.high <= r) || (p < z.low && z.low - p <= r);
      }
      
      candidates.sort((a,b) => {
        const da = Math.max(0, a.low - currentPrice, currentPrice - a.high);
        const db = Math.max(0, b.low - currentPrice, currentPrice - b.high);
        return da - db;
      });
      
      const zone = candidates[0];
      const side = zone.type === "demand" ? "BUY" : "SELL";
      
      let score = 0;
      if (config.requireInside) {
        if (currentPrice >= zone.low && currentPrice <= zone.high) score += (config.insidePoints || 2);
        else continue; // must be inside
      } else {
        if (currentPrice >= zone.low && currentPrice <= zone.high) score += (config.insidePoints || 2);
        else score += (config.approachingPoints || 0);
      }
      
      if (!config.skipUntested && zone.touches === 0) score += (config.untestedPoints || 1);
      if (config.requireUntested && zone.touches !== 0) continue;
      
      if (config.requireTrendAgree) {
        if ((side === "BUY" && trend === "up") || (side === "SELL" && trend === "down")) {
          score += (config.trendPoints || 1);
        } else continue;
      } else if ((side === "BUY" && trend === "up") || (side === "SELL" && trend === "down")) {
        score += (config.trendPoints || 1);
      }
      
      const bullishBar = bar.c > bar.o;
      if (config.requireReaction) {
        if ((side === "BUY" && bullishBar) || (side === "SELL" && !bullishBar)) {
          score += (config.reactionPoints || 1);
        } else continue;
      } else if ((side === "BUY" && bullishBar) || (side === "SELL" && !bullishBar)) {
        score += (config.reactionPoints || 1);
      }
      
      if (Number(zone.strength) >= (config.minStrength || 2)) score += (config.strengthPoints || 1);
      
      if (score < (config.minScore || 3)) continue;
      
      const buffer = atr * (config.stopBuffer || 0.25);
      const stop = side === "BUY" ? zone.low - buffer : zone.high + buffer;
      const riskPerUnit = Math.abs(currentPrice - stop);
      const target = side === "BUY" ? currentPrice + riskPerUnit * (config.rr || 2) : currentPrice - riskPerUnit * (config.rr || 2);
      
      // Look ahead
      let outcome = null;
      for (let j = i + 1; j < Math.min(i + 150, allBars.length); j++) {
        const bbar = allBars[j];
        if (side === 'BUY') {
          if (bbar.l <= stop) { outcome = 'LOSS'; break; }
          if (bbar.h >= target) { outcome = 'WIN'; break; }
        } else {
          if (bbar.h >= stop) { outcome = 'LOSS'; break; }
          if (bbar.l <= target) { outcome = 'WIN'; break; }
        }
      }
      if (outcome) {
        trades.push({ outcome, score, rMultiple: outcome === 'WIN' ? config.rr || 2 : -1 });
      }
    }
    allTrades = allTrades.concat(trades);
  }
  
  if (allTrades.length === 0) return { winrate: 0, totalR: 0, count: 0 };
  const wins = allTrades.filter(t => t.outcome === 'WIN').length;
  const totalR = allTrades.reduce((a,b) => a + b.rMultiple, 0);
  return { 
    winrate: wins/allTrades.length*100, 
    totalR, 
    count: allTrades.length,
    expectancy: totalR/allTrades.length 
  };
}

async function main() {
  const configs = [
    { name: "current", displacementMult: 1.4, maxPerSide: 4, requireInside: false, minScore: 3, rr: 2, reachMult: 0.35, stopBuffer: 0.25 },
    { name: "inside only", displacementMult: 1.4, maxPerSide: 4, requireInside: true, minScore: 2, rr: 1, reachMult: 0.35, stopBuffer: 0.25 },
    { name: "untested only tight", displacementMult: 1.6, maxPerSide: 3, requireInside: true, requireUntested: true, requireTrendAgree: true, requireReaction: true, minScore: 4, rr: 1.5, reachMult: 0.2, stopBuffer: 0.3 },
    { name: "untested no trend", displacementMult: 1.5, maxPerSide: 3, requireInside: true, requireUntested: true, requireTrendAgree: false, requireReaction: true, minScore: 3, rr: 1.2, reachMult: 0.25, stopBuffer: 0.25 },
    { name: "very strict", displacementMult: 2.0, maxPerSide: 2, requireInside: true, requireUntested: true, requireTrendAgree: true, requireReaction: true, minScore: 5, rr: 1, reachMult: 0.15, stopBuffer: 0.2 },
    { name: "contrarian trend", displacementMult: 1.4, maxPerSide: 4, requireInside: true, requireUntested: true, requireTrendAgree: false, requireReaction: true, minScore: 3, rr: 1.3, reachMult: 0.3, stopBuffer: 0.25 },
  ];
  
  for (const cfg of configs) {
    const res = await testConfig(cfg);
    console.log(`${cfg.name}: ${res.count} trades, ${res.winrate.toFixed(1)}% win, ${res.totalR.toFixed(1)}R, ${res.expectancy.toFixed(3)}R/trade`);
  }
}
main().catch(console.error);
