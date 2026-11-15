const candlesMod = require('./server/candles');
const autozones = require('./server/autozones');

const SYMBOLS = [
  { tkr: 'GC=F', sym: 'XAUUSD' },
  { tkr: '^NDX', sym: 'NASDAQ' }
];

async function testConfig(config) {
  let allTrades = [];
  for (const s of SYMBOLS) {
    const allBars = await candlesMod.getCandles(s.tkr, '15m', '1mo');
    const trades = [];
    const minHistory = 80;
    
    for (let i = minHistory; i < allBars.length - 30; i++) {
      const currentBars = allBars.slice(0, i + 1);
      const currentPrice = currentBars[currentBars.length - 1].c;
      const bar = currentBars[currentBars.length - 1];
      const prevBar = currentBars[currentBars.length - 2];
      
      const detected = autozones.detectZones(currentBars, { 
        displacementMult: config.displacementMult || 1.5,
        maxPerSide: config.maxPerSide || 3 
      });
      if (detected.length === 0) continue;
      
      const zones = autozones.toAppZones(s.sym, detected, { 
        basisOffset: 0,
        decimals: s.sym === 'XAUUSD' ? 2 : 1 
      });
      
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
      const closes = currentBars.map((b) => b.c);
      const fast = ema(closes, 20)[ema(closes,20).length-1];
      const slow = ema(closes, 50)[ema(closes,50).length-1];
      const trend = fast > slow ? "up" : fast < slow ? "down" : "flat";
      
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
      
      for (const zone of zones) {
        if (!(currentPrice >= zone.low && currentPrice <= zone.high)) continue;
        const side = zone.type === "demand" ? "BUY" : "SELL";
        
        let ok = true;
        if (zone.touches !== 0) ok = false;
        if (!ok) continue;
        
        // Look for rejection
        if (side === "BUY") {
          // Bullish rejection - long wick down into zone
          const wickDown = bar.o > bar.l && (bar.o - bar.l) > (bar.h - bar.o) * 1.5;
          if (!wickDown) continue;
        } else {
          const wickUp = bar.o < bar.h && (bar.h - bar.o) > (bar.o - bar.l) * 1.5;
          if (!wickUp) continue;
        }
        
        if (config.requireTrendAgree) {
          if (!((side === "BUY" && trend === "up") || (side === "SELL" && trend === "down"))) ok = false;
        }
        if (!ok) continue;
        
        const buffer = atr * 0.1;
        const stop = side === "BUY" ? Math.min(bar.l, zone.low) - buffer : Math.max(bar.h, zone.high) + buffer;
        const riskPerUnit = Math.abs(currentPrice - stop);
        const target = side === "BUY" ? currentPrice + riskPerUnit * (config.rr || 0.5) : currentPrice - riskPerUnit * (config.rr || 0.5);
        
        let outcome = null;
        for (let j = i + 1; j < Math.min(i + 40, allBars.length); j++) {
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
          trades.push({ outcome, rMultiple: outcome === 'WIN' ? (config.rr || 0.5) : -1 });
        }
      }
    }
    allTrades = allTrades.concat(trades);
  }
  
  if (allTrades.length === 0) return { winrate: 0, totalR: 0, count: 0 };
  const wins = allTrades.filter(t => t.outcome === 'WIN').length;
  const totalR = allTrades.reduce((a,b) => a + b.rMultiple, 0);
  return { winrate: wins/allTrades.length*100, totalR, count: allTrades.length, expectancy: totalR/allTrades.length };
}

async function main() {
  const configs = [
    { name: "rejection rr0.5", rr: 0.5 },
    { name: "rejection+trend rr0.6", rr: 0.6, requireTrendAgree: true },
    { name: "rejection rr0.4", rr: 0.4 },
    { name: "rejection rr0.3", rr: 0.3 },
  ];
  for (const cfg of configs) {
    const res = await testConfig(cfg);
    console.log(`${cfg.name}: ${res.count} trades, ${res.winrate.toFixed(1)}% win, ${res.totalR.toFixed(1)}R`);
  }
}
main().catch(console.error);
