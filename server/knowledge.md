# Zone Watch — measured facts

Everything in this file was measured by this project, not copied from a vendor.

## Signal logic (zone strategy)

- Entry: price inside an automatic supply/demand zone (order block from a
  displacement candle greater than 1.4 ATR, zone = last opposite-coloured base
  candle, broken zones discarded, overlaps merged).
- Confirmation: the last closed bar must have finished with the trade.
- Stop: beyond both the recent 20-bar sweep extreme and the far zone edge,
  with half an ATR of clearance.
- Target: 2R, measured from that wider stop.
- Higher-timeframe filter: one step above the entry timeframe (default 15m →
  1h; 5m → 30m; 1h → 4h; 4h → 1d) using EMA20 vs EMA50. Set with
  `ENTRY_TIMEFRAME`.

## Lab results (fixed live rule, no tuning grid)

The lab calls the live signal function and the live cost-aware resolver. It
walks the deepest history each feed provides, one trade at a time with the live
30-minute cooldown and 24-hour expiry, and applies spread, slippage and
commission. As of 25 November 2026, 15m entries: none of the 11 markets cleared
the gate. The best net result was XAUUSD at +0.089R per trade over 103 trades,
but t = 0.74; NASDAQ was +0.063R over 59 trades. Every other market was negative
net of modelled costs. The old grid-study numbers are retired: they measured a
different, overlapping-trade strategy and are not evidence for this rule.

## Order flow and levels

- Volume profile and structural levels were tested against 541 zone trades:
  no filter 31.2% (-0.063R), score>=2 31.3% (-0.063R), score>=4 29.3% (-0.122R).
- Conclusion: levels are shown as context, they are not used to filter.

## Trend following

- Daily time-series momentum (price above/below N days ago), 10 markets, 10
  years, spreads charged: pooled out-of-sample Sharpe 0.02.
- Individually: gold 0.60, Nasdaq 0.49, FX pairs -0.04 to -0.57.
- Conclusion: the documented effect does not survive at retail size and cost.

## Strategy lab gate

A market may send signal alerts only if, on unseen data, it has at least 100
trades, expectancy above 0.08R per trade, t-statistic of 2 or more, and at least
two of three entry blocks positive. The lab re-tests every market daily and can
block a market that used to pass. No verdict, or a verdict stored for another
timeframe or rule set, means held — never allowed by default.

## Published evidence referenced

- Currency momentum: Sharpe up to 0.95, returns up to ~10% a year, strongest in
  emerging-market currencies.
- Carry trade: Sharpe ~0.82, long high-yielders (AUD, NZD, MXN, BRL, ZAR, TRY)
  against funding currencies (JPY, CHF).
- Combining momentum and carry: Sharpe ~0.98.
- Trend following: positive in 67 markets from 1880 to 2016, average Sharpe ~0.4.
- Retail reality: 74-89% of retail CFD accounts lose money in a given period.

## Operating rules in the app

- Alerts are grouped: zones, signals, results to alerts; calendar, sessions and
  market open/close to news; weekly recap to recap.
- News blackout suppresses signals within 15 minutes of high-impact USD events.
- Daily guard stops signals after 3 losses or -2R in a day.
- Correlation guard skips an alert if a correlated market alerted in 45 minutes.
- Quiet hours suppress Discord delivery but not tracking.
