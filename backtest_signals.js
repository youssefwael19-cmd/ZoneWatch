const candlesMod = require('./server/candles');
const autozones = require('./server/autozones');
const signalsMod = require('./server/signals');

const SYMBOLS = [
  { tkr: 'GC=F', sym: 'XAUUSD', name: 'Gold Futures' },
  { tkr: '^NDX', sym: 'NASDAQ', name: 'Nasdaq 100' }
];

async function backtestOne({tkr, sym}) {
  console.log(`\n=== Backtesting ${sym} (${tkr}) ===`);
  // Get more history
  const allBars = await candlesMod.getCandles(tkr, '15m', '1mo');
  console.log(`Got ${allBars.length} bars from ${new Date(allBars[0].t).toISOString()} to ${new Date(allBars[allBars.length-1].t).toISOString()}`);
  
  const trades = [];
  const minHistory = 60; // need enough for EMAs etc
  
  for (let i = minHistory; i < allBars.length - 10; i++) { // leave room to see outcome
    const currentBars = allBars.slice(0, i + 1);
    const currentPrice = currentBars[currentBars.length - 1].c;
    
    // Detect zones using only history up to now (no lookahead)
    const detected = autozones.detectZones(currentBars, { maxPerSide: 4 });
    if (detected.length === 0) continue;
    
    // Build zones in app format
    const zones = autozones.toAppZones(sym, detected, { 
      basisOffset: 0, // for futures, use as-is
      decimals: sym === 'XAUUSD' ? 2 : 1 
    });
    
    // Evaluate signal
    const signal = signalsMod.evaluateSignal({
      symbol: sym,
      price: currentPrice,
      zones: zones,
      candles: currentBars,
      decimals: sym === 'XAUUSD' ? 2 : 1
    });
    
    if (!signal) continue;
    
    // Look ahead to see outcome
    const entry = signal.entry;
    const stop = signal.stop;
    const target = signal.target;
    const side = signal.side;
    
    let outcome = null;
    let barsToOutcome = null;
    for (let j = i + 1; j < Math.min(i + 100, allBars.length); j++) { // look ahead up to ~25 hours
      const bar = allBars[j];
      if (side === 'BUY') {
        if (bar.l <= stop) { // hit stop
          outcome = 'LOSS';
          barsToOutcome = j - i;
          break;
        }
        if (bar.h >= target) { // hit target
          outcome = 'WIN';
          barsToOutcome = j - i;
          break;
        }
      } else if (side === 'SELL') {
        if (bar.h >= stop) { // hit stop
          outcome = 'LOSS';
          barsToOutcome = j - i;
          break;
        }
        if (bar.l <= target) { // hit target
          outcome = 'WIN';
          barsToOutcome = j - i;
          break;
        }
      }
    }
    
    if (outcome) {
      trades.push({
        time: new Date(currentBars[currentBars.length-1].t).toISOString(),
        side,
        confidence: signal.confidence,
        score: signal.score,
        entry,
        stop,
        target,
        outcome,
        barsToOutcome,
        rMultiple: outcome === 'WIN' ? 2 : -1
      });
    }
  }
  
  return trades;
}

async function main() {
  let allTrades = [];
  for (const s of SYMBOLS) {
    const trades = await backtestOne(s);
    allTrades = allTrades.concat(trades);
    console.log(`Found ${trades.length} completed trades`);
    if (trades.length > 0) {
      const wins = trades.filter(t => t.outcome === 'WIN').length;
      const losses = trades.filter(t => t.outcome === 'LOSS').length;
      console.log(`  Wins: ${wins}, Losses: ${losses}, Winrate: ${(wins/trades.length*100).toFixed(1)}%`);
      const avgBars = trades.reduce((a,b) => a + b.barsToOutcome, 0) / trades.length;
      console.log(`  Avg bars to outcome: ${avgBars.toFixed(1)} (${(avgBars*0.25).toFixed(1)} hours)`);
    }
  }
  
  console.log(`\n\n=== OVERALL RESULTS ===`);
  console.log(`Total trades: ${allTrades.length}`);
  if (allTrades.length > 0) {
    const wins = allTrades.filter(t => t.outcome === 'WIN').length;
    const losses = allTrades.filter(t => t.outcome === 'LOSS').length;
    const winrate = wins/allTrades.length*100;
    console.log(`Wins: ${wins}, Losses: ${losses}, Winrate: ${winrate.toFixed(1)}%`);
    const totalR = allTrades.reduce((a,b) => a + b.rMultiple, 0);
    console.log(`Total R: ${totalR.toFixed(2)}`);
    console.log(`Expectancy: ${(totalR/allTrades.length).toFixed(3)} R per trade`);
    
    // By confidence
    for (const conf of ['high', 'medium', 'low']) {
      const ct = allTrades.filter(t => t.confidence === conf);
      if (ct.length > 0) {
        const cw = ct.filter(t => t.outcome === 'WIN').length;
        console.log(`  ${conf}: ${ct.length} trades, ${(cw/ct.length*100).toFixed(1)}% win, ${ct.reduce((a,b)=>a+b.rMultiple,0).toFixed(2)} R total`);
      }
    }
  }
}

main().catch(console.error);
