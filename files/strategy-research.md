# What actually has evidence — trading strategy research

Research summary, November 2026. Sources linked at the bottom. Read the caveat at
the end before doing anything with this.

## The honest headline

There is no publicly verifiable list of "most profitable" retail strategies. What
exists is a body of **academic and institutional evidence** for a small number of
return drivers that have persisted for decades — and those are run across dozens
of instruments at portfolio scale, not as single-pair entries.

Meanwhile the retail result is well documented: **74–89% of retail CFD and forex
accounts lose money** in a given period (ESMA/FCA/CySEC disclosures), the CFTC
puts it at roughly two out of three US retail forex accounts per quarter, and a
French AMF study of ~15,000 clients over four years found **89% finished
unprofitable**.

## The four strategies with real evidence

### 1. Carry trade
Borrow a low-interest currency, hold a high-interest one, collect the
differential.

- **Documented Sharpe:** ~0.82 annualised (Menkhoff, Sarno, Schmeling & Schrimpf).
- **Long side:** AUD, NZD, MXN, BRL, ZAR, TRY — historically higher yielders.
- **Short side:** JPY, CHF, and EUR in low-rate periods.
- **Classic expression:** AUD/JPY and NZD/JPY are the textbook retail pairings.
- **The catch:** crash risk. Carry returns are steady then suffer violent
  drawdowns in risk-off events (2008, August 2015, March 2020). The losses
  cluster exactly when leverage is highest.

### 2. Cross-sectional currency momentum
Rank currencies by recent return against the dollar; buy winners, sell losers.

- **Documented returns:** up to ~10% a year; Sharpe ~0.95 for a 1-month
  formation/1-month holding version (Menkhoff et al., 2012).
- **Where it's strongest:** emerging-market and high-idiosyncratic-volatility
  currencies (about 8% a year vs about 4% for low-vol currencies).
- **Universe:** a broad basket — 48–63 currencies in the studies. It is a
  relative-value strategy, so it needs many currencies, not one pair.
- **Important:** momentum and carry are largely **uncorrelated**. Combining them
  lifts Sharpe to ~0.98 versus 0.79 and 0.63 individually.

### 3. Time-series momentum / trend following
The most robust of the lot, and the only one that directly covers gold and equity
indices.

- **Century of evidence:** Hurst, Ooi & Pedersen tested 67 markets from **1880 to
  2016** — 29 commodities, 11 equity indices, 15 bond markets, 12 currency
  pairs. Positive average returns in *every* market, average Sharpe ~0.4.
- **Currencies in the study:** AUD, CAD, EUR/DEM, JPY, NZD, NOK, SEK, CHF, GBP,
  USD.
- **Works on:** gold futures, equity index futures (S&P, Nasdaq-type indices),
  bonds, commodities.
- **Known weakness:** whipsaw in range-bound markets, and sharp losses when a
  long trend reverses (e.g. March–May 2009).
- **Practical shape:** simple moving-average or 12-month momentum rules, wide
  stops, small position size, many instruments.

### 4. Value (PPP-based)
Cheap vs expensive currencies by purchasing power. Real but slow, and the weakest
of the four on its own. Usually used as a third leg alongside carry and momentum.

## What has no published evidence

Supply-and-demand zones, "smart money concepts", order blocks, liquidity sweeps,
support/resistance scalping, and most indicator combinations sold online. They
can be *described* precisely, but there is no public out-of-sample evidence that
they beat costs. This is not a claim that they never work — it's that nobody has
shown it, and the burden of proof is on the seller.

Relevant retail data point: across 500,000+ analysed accounts, **swing traders
were the most profitable group at 27.5% net profitable, scalpers 19.3%, day
traders 17.3%**. Faster trading, worse outcomes.

## What this means for XAUUSD and NASDAQ

Both of your instruments appear directly in the trend-following literature (gold
futures and equity index futures are two of the four asset classes in the
century study). Neither appears in the carry literature, because neither is a
currency pair with an interest differential.

So the honest read: **your instruments suit trend following, which has the
strongest evidence base; they do not suit zone scalping, which has none.** That
matches what our own testing found — zone entries at 15-minute resolution measured
41% at 1:2 out of sample, which is thin.

## Caveat that matters most

Every result above comes from **institutional execution**: tiny spreads,
portfolio diversification across dozens of markets, multi-year holding periods,
and no leverage constraints. A retail account trading two instruments on a
15-minute chart with a 2-point spread is a different game, and the published
Sharpes do not transfer. The studies show these effects exist; they do not show
that you can capture them at retail size.

## Sources

- Menkhoff, Sarno, Schmeling & Schrimpf — Currency momentum strategies, JFE 2012
  https://www.sciencedirect.com/science/article/abs/pii/S0304405X12001353
- Hurst, Ooi & Pedersen — A Century of Evidence on Trend-Following Investing
  https://fairmodel.econ.yale.edu/ec439/hurst.pdf
- Moskowitz, Ooi & Pedersen — Time series momentum, JFE 2012
  https://pages.stern.nyu.edu/~lpederse/papers/TimeSeriesMomentum.pdf
- Strategy diversification: combining FX momentum and carry, JDHF 2013
  https://link.springer.com/article/10.1057/jdhf.2013.16
- Is there momentum or reversal in weekly currency returns? 2014
  https://www.sciencedirect.com/science/article/pii/S0261560614000400
- Economic momentum and currency returns, JFE 2020
  https://www.sciencedirect.com/science/article/abs/pii/S0304405X19302211
- ESMA / FCA / CySEC broker loss disclosures, and AMF four-year study
  https://tradingbusinessreview.com/market-intelligence/broker-loss-disclosures-compared
- CFTC — Forex frauds and retail profitability data
  https://www.cftc.gov/LearnAndProtect/forexfrauds
- Retail profitability by trading style, 500,000 accounts
  https://hoc-trade.com/blogs/case-studies/what-percentage-of-day-traders-are-profitable
