# Zone Watch — measured facts

Everything in this file was measured by this project, not copied from a vendor.

## Signal logic (zone strategy)

- Entry: price inside an automatic supply/demand zone (order block from a
  displacement candle greater than 1.4 ATR, zone = last opposite-coloured base
  candle, broken zones discarded, overlaps merged).
- Stop: beyond both the recent 20-bar sweep extreme and the far zone edge,
  with half an ATR of clearance.
- Target: 2R, measured from that wider stop.
- Higher-timeframe filter: 1-hour EMA20 vs EMA50 must agree with the direction.

## Walk-forward results (tuning on early data, scoring only on unseen data)

- 0.6R version, 6 months, 3 blocks: 44.6% win, -0.108R per trade. No edge.
- 2R version, 1 year, 180 configurations: 41.1% win, +0.234R per trade over 158
  unseen trades. Positive but small, wide uncertainty.
- 2R version with 1,440 configurations and zone-quality filters: 36.5% win,
  +0.094R. Worse than the smaller grid — evidence of overfitting.
- 2R version across 4 instruments, 2,266 trades: 33.6% win at min confluence 0
  (+0.009R). Requiring higher confluence scores made it worse: min 3 gave 30.3%
  and -0.091R.

Interpretation: the zone strategy is approximately break-even before costs and
negative after spread. Confluence filters (trend, daily bias, volatility,
session, freshness) did not improve it.

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
one profitable block. The lab re-tests every market daily and can block a market
that used to pass.

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
