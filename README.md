# Zone Watch — trading agent

A market-watching assistant for XAU/USD and NASDAQ. It polls price, watches your
supply and demand zones, warns you when price approaches or enters one, and
tracks the economic calendar so you know when news risk is about to hit.

## What it does

**Live watch**
- Polls price for XAU/USD and NASDAQ on an interval you control (default 30s)
- Evaluates every zone against the live price
- Fires an alert once per approach (not every poll) when price enters the
  alert band or steps inside a zone
- Beeps and can send a desktop notification
- Shows the nearest zone for each instrument

**Zones**
- Add, edit, disable and delete supply and demand zones
- Each zone has a price range, a type, a label, notes and an alert distance
- Alert distance is per zone: how close price must get before you are warned

**News**
- Economic calendar from a free feed, filtered to USD events
- Flags a "news risk" window in the 30 minutes before a high-impact event
- Recent headlines from financial RSS feeds
- All cached for 10 minutes so the feeds are not hammered

**Risk calculator**
- Account balance, risk %, stop distance and value per point → position size

**Journal**
- The trade review analyzer from earlier versions, unchanged

## Running it

```bash
npm install
npm start          # http://localhost:3000
```

It starts in **demo mode** with simulated prices, so you can try everything
without a key.

## Going live with real prices

TradingView's free plan has no price API, so the watcher uses Twelve Data's
free plan (real-time forex including XAU/USD, 8 requests/min, 800/day).

1. Sign up at twelvedata.com/register (free Basic plan, no card)
2. Copy the API key from your dashboard
3. Open the app, go to the **Settings** tab, paste the key, press **Save key**
4. Press **Test connection** to confirm both instruments return prices

The app switches to live prices automatically once a key is saved. The key is
written to `settings.json` on the machine running the app (permissions 600) and
is never sent back to the browser — the screen only shows the last four
characters. Remove it any time with **Remove key**.

You can also supply the key as an environment variable instead, which takes
precedence over the saved one:

```bash
TWELVE_DATA_API_KEY=your_key npm start
```

## Where each price comes from

Each instrument has its own source, chosen on the Settings screen.

| Instrument | Default source | Symbol | Needs a key? |
| --- | --- | --- | --- |
| XAU/USD gold | Twelve Data | `XAU/USD` | Yes |
| NASDAQ 100 | Yahoo | `^NDX` | No |

**Why Nasdaq uses Yahoo.** Twelve Data's free plan covers real-time US stocks,
ETFs, forex and crypto, but *not* index symbols like `NDX` — those need a paid
tier. Yahoo's chart endpoint returns the real index level for free, so Nasdaq
gets the actual index number rather than a proxy. It is an unofficial endpoint,
so treat it as best effort: if it ever stops working, switch the instrument's
source to `twelvedata` and use the symbol `QQQ`, which is the Nasdaq-100 ETF.

Be aware `QQQ` trades around 1/45th of the index level. If you switch, redraw
your Nasdaq zones on the new scale. The Zones tab flags any zone whose price is
wildly far from the live price with a **check scale** badge.

### Changing a source or symbol

Settings → **Instruments & sources**. Each row has a source dropdown
(`auto`, `yahoo`, `twelvedata`, `demo`) and a symbol box. Press
**Save instruments**, then **Test connection**.

Saving an instrument preference never clears a saved API key.

The dashboard shows a clear error on the price card if a symbol is unavailable,
rather than failing silently.

### Environment variable overrides

Useful for scripting, and they take precedence over the saved ones:

```bash
TWELVE_DATA_API_KEY=your_key   # the API key
TWELVE_XAUUSD_SYMBOL=XAU/USD   # override gold's provider symbol
TWELVE_NASDAQ_SYMBOL=QQQ       # override Nasdaq's provider symbol
MARKET_PROVIDER=demo           # force simulated prices everywhere
```

### Polling and rate limits

The free Twelve Data plan allows 8 requests per minute but only ~800 per day.
Run continuously, that is one request every ~108 seconds — nowhere near fast.

So the app protects your key instead of spending it in an afternoon:

| Provider | Minimum gap between requests |
| --- | --- |
| Twelve Data | 120 seconds |
| Yahoo | 5 seconds |
| demo | none |

When a request is skipped, the last known price is returned and marked as
cached with its age, so the dashboard never pretends a stale number is fresh.
There is also a daily counter that stops at 780 requests and says so.

**Practical consequence:** gold on Twelve Data spot updates about every two
minutes. If you want gold updating every 10 seconds, switch its source to
**yahoo** (`GC=F`, gold futures) in Settings. That is key-free and fast, but it
is the futures contract, which trades a few dollars away from spot XAU/USD. The
app automatically shifts detected zones by that difference so levels still line
up with the price you are watching.

### Candle history from OANDA (optional)

Zones, signals, the lab and the research scripts all read candle history, not
the live quote. That history comes from Yahoo by default. If you have an OANDA
account — the free **practice** account is enough, and it is the same token the
direct broker uses — the app can read those candles from the broker instead:

```bash
OANDA_API_TOKEN=your_practice_token npm start
```

With a token set, the ten instruments OANDA lists move to broker candles:

| App symbol | OANDA instrument |
| --- | --- |
| XAUUSD | `XAU_USD` |
| NASDAQ | `NAS100_USD` |
| EURUSD, GBPUSD, USDJPY, AUDUSD, USDCAD, USDCHF, AUDJPY, NZDJPY | `EUR_USD`, `GBP_USD`, `USD_JPY`, … |

BTCUSD stays on Yahoo: OANDA no longer lists crypto instruments. Any symbol
OANDA does not recognise also stays on Yahoo — a mapping is never guessed.

| Variable | What it does |
| --- | --- |
| `OANDA_API_TOKEN` | The only switch. With no token, every instrument reads Yahoo. |
| `OANDA_ENVIRONMENT` | `practice` (default) or `live`. The practice host is used unless you ask for live. |
| `CANDLE_PROVIDER=yahoo` | Start on Yahoo even though a token is saved, e.g. to compare feeds for a day without deleting the token. A feed saved in Settings wins; the variable is only the default before a choice is saved. |

Bars are cached for three minutes, and long ranges are paged from OANDA in
5,000-bar requests, so a year of hourly history is complete rather than
silently cut short. Only market data is read: no order, stop or account call is
made from this path.

If OANDA rejects the token, does not offer an instrument on your account, or is
unreachable, that instrument falls back to Yahoo and logs one warning. A
credential problem costs freshness, not the dashboard.

Two scale notes, because broker data is not the same series as the feed it
replaces:

- Nasdaq candles switch from the cash index (`^NDX`) to OANDA's `NAS100_USD`
  CFD. They track each other closely but are not identical, so levels can sit
  a few points apart.
- Gold candles switch from the `GC=F` futures contract to spot `XAU_USD`. The
  two differ by the futures basis, which moves.

If a pair only has to be consistent with itself, that is fine — the zones and
stops on it are all built from the same bars. Redraw a market's zones after
switching if you want them to sit exactly where the new series trades.

### Candle history from Deriv (no account)

OANDA needs an account. Deriv's market-data API does not: `ticks_history` is
unauthenticated, so candle history can come from Deriv with no login, key or
account of any kind.

Choose **Settings → Candle feed → Deriv**, or start once with
`CANDLE_PROVIDER=deriv npm start`. The saved choice is what the server uses;
the variable is only the default before a choice is saved.

It speaks Deriv's public WebSocket API
(`wss://api.derivws.com/trading/v1/options/ws/public`) and asks for
`style: "candles"` in 5,000-bar pages, walking backwards with `end` until the
requested range is covered. That is enough depth for the app's windows — a year
of hourly bars is about two pages.

| App symbol | Deriv symbol |
| --- | --- |
| XAUUSD | `frxXAUUSD` |
| NASDAQ | `OTC_NDX` |
| EURUSD, GBPUSD, USDJPY, AUDUSD, USDCAD, USDCHF, AUDJPY, NZDJPY | `frxEURUSD`, `frxGBPUSD`, … |
| BTCUSD | `cryBTCUSD` |

| Variable | What it does |
| --- | --- |
| `CANDLE_PROVIDER=deriv` | Default a fresh install to Deriv. The choice saved in Settings → Candle feed wins, and Deriv also quotes live prices from the same Deriv instruments. |

Live quotes follow the candles. One Deriv socket stays open and subscribes to
the same instrument the candles use (`frxXAUUSD` for gold, `OTC_NDX` for the
Nasdaq and so on), so a market's bars and its live price are one series rather
than two feeds joined by a basis offset. The Watch tab's feed table marks those
markets `matched`; a market that keeps a Yahoo or Twelve Data quote is marked
`split feeds`. The tick subscription reads a quote, bid, ask and timestamp
only — still no account, order or proposal call.

Markets that are not configured for Deriv candles keep their normal quote
source, and a Deriv candle fetch that falls back to Yahoo is shown as a split
rather than hidden.

Deriv's socket needs a WebSocket client, which Node 22 and newer ship. On Node
20 the provider logs one warning and falls back to Yahoo rather than failing
the dashboard, as it also does when Deriv refuses or cannot be reached. The
warning is logged once per instrument, and only the market-data call is made —
no account, order or proposal request is sent.

Two scale notes, because this is again a different series:

- Gold moves from the `GC=F` futures contract to Deriv's spot `frxXAUUSD`.
- Nasdaq moves from the cash index (`^NDX`) to Deriv's `OTC_NDX` US Tech 100
  CFD. They track closely but are not the same series, so redraw zones after
  switching if you want exact levels.

Deriv's CFDs also quote only while their market is open, so a 5-day intraday
request contains fewer bars than Yahoo's series — about 170 fifteen-minute bars
on the Nasdaq rather than 480. Indicators use the bars that exist; closed hours
are not padded with flat candles.

## TradingView charts

The Watch tab embeds TradingView's free chart widget for viewing. Those charts
are for looking at price structure while you manage zones — the alerts
themselves run on the polling provider. Change the chart symbols in
`server/market.js` (`tradingView` field) if you prefer different brokers or
contracts.

## Discord alerts

Alerts can be pushed into a Discord channel as rich embeds showing the
instrument, zone, live price and distance.

1. In Discord, right-click the channel → **Edit Channel → Integrations →
   Webhooks → New Webhook → Copy Webhook URL**
2. In the app: **Settings → Discord alerts**, paste the URL, press
   **Save webhook**
3. Press **Send test alert** — a green "Connection test" card should appear in
   the channel

A webhook is used rather than a bot, so there is no bot token to host and
nothing that has to stay connected to Discord. The URL is stored server-side
and only ever shown back as its last six characters.

The server polls the market on its own every 30 seconds, so Discord alerts
arrive even when no browser is open. High-impact news warnings are posted once
per event and can be switched off with the checkbox.

### Separate channels

One webhook is enough to start, but alerts, signals and recaps can each go to
their own channel. Create a webhook in each channel you want (same steps as
above) and paste them under **Settings → Discord alerts** — each purpose has
its own box, and news has its own section with a save and test button:

| Channel | Carries |
| --- | --- |
| Alerts | price entering or approaching a zone, broken zones, daily-loss guard, feed watchdog, heartbeat and health warnings |
| Signals | signal entries, approach warnings, IVB breakouts |
| Results | every **win**, **loss** and expiry, with the pips and the money |
| News | economic-calendar warnings, session and market open/close |
| Daily recap | the 21:00 UTC daily recap and the daily gate digest |
| Weekly recap | the weekly recap and the weekly paper review |

Any box left empty falls back to the default webhook, so nothing is lost by
filling in only the ones you care about — except **news**, which is deliberately
never sent to the alerts channel. News has its own webhook and its own
**Save news channel** / **Send test to news** buttons; with no news webhook
saved, news posts pause rather than mixing into alerts. Alerts keep using the
default webhook exactly as before.

Alerts, signals and results are three separate places on purpose: zones fire all
day, entries are the setups to act on, and results are the record of how they
went. Keeping the last two out of the zone stream means a channel you can read
like a scorecard, and muting zone noise never mutes a win or a loss.

### Asking the assistant from Discord: `/ask`

The assistant can answer inside Discord through a slash command. That is the one
place the app receives data from Discord: a small HTTPS endpoint Discord calls
for every command, with an Ed25519 signature over the exact request body. No bot
connection is kept open, and the endpoint is not protected by the dashboard
password — Discord cannot send a cookie — so the signature and a single allowed
Discord user id are the access control. Every answer spends the owner's model
credits, which is why only one user id may ask.

Setup, once:

1. Create an application at **discord.com/developers/applications**.
2. Copy its **Application ID** and **Public Key**.
3. In **Settings → Discord alerts → Ask the assistant from Discord**, paste both
   plus your own Discord user id (Discord settings → Advanced → Developer Mode,
   then right-click yourself → **Copy User ID**), and press **Save /ask setup**.
4. Copy the **Interactions endpoint URL** shown there and paste it into the
   application's **Interactions Endpoint URL**. Discord immediately sends a
   signed PING; the app answers it, so the URL saves only when the fields above
   were saved first.
5. To create the command without hand-written API calls: on the app's **Bot**
   tab reset the token, paste it into the same panel, press **Register /ask
   command**, then wait a minute for Discord to publish it. Invite the app with
   the `applications.commands` scope so the command appears in your server.

Then `/ask question: is gold near a zone?` in the channel answers there. The
answer arrives as a follow-up a few seconds later because Discord wants an
acknowledgement within three seconds and the assistant takes longer. The bot
token is only ever used to register the command and is stored server-side,
never shown back. The same conversation history as the panel is used, so a
question asked in Discord and the next one in the panel share context.

One caveat specific to this deployment: a command that arrives while the host is
restarting has to wait for the app to come back and may overrun Discord's
three-second acknowledgement. Nothing idles the app out on an always-on host, so
this only happens around a restart or an update; repeating the command once the app
is back works.

### Pips, not price distance

Every signal, zone alert and result also states the distance in **pips**
(`server/pips.js`): a EURUSD stop 30 pips away reads `30 pips`, gold reads in
0.1 steps, yen pairs use the second decimal. The Nasdaq index is quoted in
index points, so its messages say `pts` rather than calling a point a pip.

Win and loss messages add the pips the trade actually moved, and — when the
signal carried a position size — what that was worth in money. A paper trade
risks exactly its `riskMoney` at 1R, so the money line is the R multiple
applied to the risk: a 2R win on a $10 risk reads `+$20.00`.

### The spread comes first

A trade has to clear the broker before it pays you, so every result is stated
three ways: `Pips` (what price moved), `Spread` (what the broker took), and
`Net` (what is left, in pips and in R). Money is calculated from **net** R.

The spread is the account's own live reading from the MT5 bridge when it is
under fifteen minutes old (`server/executor.js` → `liveSpreads`), and otherwise
the modelled table in `server/costs.js`. Signal messages show the spread in
force at the moment the signal was sent, because a 4-pip target against a 2-pip
spread is not a 4-pip trade — and a winner that only just beat the spread reads
as the near-nothing it is: a 2R winner on EURUSD becomes `+58.8 pips
(+1.96R)`, not `+60 pips (+2.00R)`.

Discord cannot host the dashboard itself: the app stays in the browser and
Discord receives the alerts.

### The daily recap

Once a day, at or after 21:00 UTC, the app posts one recap to the **daily
recap** channel (falling back to the default webhook if none is set). It is kept
separate from the weekly recap, which goes to the **weekly recap** channel:

```
**Zone Watch · daily recap · Mon, 16 Nov 2026 21:00:00 UTC**
Feed: 10 markets · 36 zones (36 auto) · live.
Alerts: 12 sent, 3 held by a gate · 2 zones broke.
Signals: 3 closed today (1W/1L, 1 expired, +1R) · 2 open now.
Auto-trading (paper): equity $1032.50 · today +$8.40 · 1 open, 12 closed all time.
Gate: 2 markets cleared (EURUSD, AUDJPY).
Closest to a zone: GBPUSD 0.0004 away of supply 1.32–1.3214 · XAUUSD inside of demand 3800–3810.
```

It is sent whether or not anything happened, which is the difference between it
and the older conditional digest — a quiet day is still a fact worth knowing,
and silence should mean the app is down, not that it had a dull day. The old
digest's text is still available at `/api/digest`, and `GET /api/recap/daily`
returns tonight's recap without sending it. **Send daily recap now** in Discord
settings posts it immediately; `POST /api/recap/daily/send` with
`{"preview":true}` builds it without touching Discord. The day it last sent is
stored in `dailyrecap.json`, so a restart cannot send the same day twice.

### The daily gate digest

Right after the recap, the same channel gets a gate digest: one line per market
saying which gates are holding it and why. It is built from the same lock
readings as **Held back** in the dashboard, so the two can never disagree:

```
**Zone Watch · gate digest · Mon, 23 Nov 2026 21:00:00 UTC**
11 markets: 1 held · 10 partly open · 0 open.

**XAUUSD** — partial
• Strategy lab: no edge — -0.078R per trade (needs above 0.08R) — exploration only: one quarter-size trade to gather evidence
• Proven rule: no rule is proven in ranging-volatile — exploration can still take one quarter-size trade

**NASDAQ** — held
• Market hours: no fresh price for 3495 minutes — the feed looks shut
• Strategy lab: no edge — 77 unseen trades (needs 100) — exploration only: one quarter-size trade to gather evidence
```

Only gates that are actually in the way are listed, so the first bullet is the
one that stopped the market. A market whose lab verdict is "no edge" still
shows the lab as partly open while the exploration budget has room, because it
is not silent — it is reduced to one small evidence trade. Long days are split
across messages rather than trimmed, and the day it last sent lives in
`gatedigest.json` so a restart cannot double-send.

## Entry timeframe

`ENTRY_TIMEFRAME=5m|15m|30m|1h|4h` selects the candle interval used for entries
and for the lab. It defaults to `15m`, and the live watcher and the lab read the
same setting so a verdict can never describe a different rule from the one that
sends alerts. The higher-timeframe filter is one step above the entry (5m →
30m, 15m → 1h, 30m → 1h, 1h → 4h, 4h → 1d). Yahoo has no native 4h interval, so
Yahoo 4h bars are aggregated from its 1h bars; Deriv and OANDA serve 4h directly.

Changing the timeframe requires a restart and a fresh lab run. Stored verdicts
carry their timeframe and rule set, and a verdict from another timeframe is
treated as untested — which means held, not allowed.

A redeploy, a rule change, a live-filter or cost change, or a provider switch
retires the verdicts that were measured on the old inputs. Every affected market
is then measured back to back,
one per watch cycle, instead of one per 45 minutes — a restart that invalidates
five markets refills in a few minutes rather than a few hours. A market that
fails is tried once per change and its error is kept, so a broken feed cannot
spin the lab.

`/api/lab` reports that state in `pending`: one row per market with no usable
verdict, the `reason` (for example `entry series changed (60d/yahoo → 1y/deriv)`,
`rules changed (...)`, `never measured`), `open` for whether the market is
trading right now — a holiday shows as `open: false` rather than as a feed
fault — and `error` for the last failure while measuring it. An empty `pending`
means every market has a verdict this build stands behind. The dashboard shows
the same list under **Not measured**.

### Research families

The lab can also measure a rule that is not live. The first is the NASDAQ
opening-range breakout: three 5-minute bars make a 15-minute range, the first
completed 5m close outside it is the entry, the range midpoint is the stop, the
target is 1R, and anything still open exits at that session's last 5m bar. It
pays the same modelled spread, slippage and commission and must clear the same
100-trade, expectancy, t-stat and fold gate.

Its verdict lives under `research`, not `results`, and is never read by
`tradable()`, the brain's family list or the live watcher. A passing test is
evidence, not permission. It records its own 5m series identity and the range it
was actually served (2y requested; Yahoo can only serve 60d of 5m). The
scheduler refreshes it every 12 hours, and **Test NASDAQ ORB** in the dashboard
runs it on demand.

## Automatic zones

The bot can draw its own supply and demand zones from the configured entry
timeframe — 15-minute candles by default — so you are not starting from a blank
chart.

How it works, in plain terms:

1. Volatility is measured with ATR, so "a big move" means the same thing on
gold as it does on the Nasdaq.
2. It looks for **displacement** — a candle closing more than 1.4 ATR from the
   previous close. That is the impulsive move that leaves a footprint.
3. The zone is the **last opposite-coloured base candle** before that move.
   A strong rally leaves a demand zone beneath it; a strong drop leaves supply above.
4. Zones that price has since closed through are discarded — they failed.
5. Touches are counted, so untested zones rank above used ones.
6. Overlapping zones merge, keeping three per side.

Zones are re-detected every 5 minutes and marked **AUTO** in the Zones tab.
They sit alongside the zones you draw yourself, and both go through the same
alert logic. Switch the whole feature off in Settings → Automation.

This is a mechanical approximation of reading order blocks by eye. It will mark
zones you would not have drawn, and it does not know about news, sessions or
higher-timeframe context.

## Signals

When price reaches a zone, the bot scores a small set of conditions:

| Condition | Points |
| --- | --- |
| Price is at the zone | +2 |
| Zone is untested | +1 |
| Trend filter agrees (EMA 20 vs 50) | +1 |
| Last candle reacted in the signal's direction | +1 |
| Zone came from a strong displacement (≥2 ATR) | +1 |

Six points maximum. Below 3 no signal is shown at all. Each signal carries an
entry, a stop beyond the recent 20-bar sweep extreme and the zone edge with
half an ATR of clearance, and a 2R target measured from that wider risk unit.

### How a signal is scored after it is posted

One live signal per market and direction, and no new one for that market within
30 minutes. The zone key is rounded to two pips, because auto zones are redrawn
every cycle and an unrounded key turns one setup into a stream of identical
signals — seven near-identical USDCAD buys were once scored as seven trades.

A signal resolves by walking the 5-minute candles from the moment it was posted
and taking the **first** level touched. A bar that touches both the stop and the
target counts as a **loss**: the order inside a bar is unknown, and assuming the
exit you wanted is how a backtest lies. Only when there are no candles does it
fall back to the live price, and the history records `resolution: "price"` so you
can see which trades were judged that way.

The older price-only rule scored three of thirteen tracked trades as wins that
had already hit their stop, and reported a 100% win rate. If you see a suspicious
win rate, check `resolution` before believing it.

Every resolved signal also records its **exit path**: `mfeR` (the best excursion
above entry, in R), `maeR` (the worst excursion below it), whether the target
itself was touched (`targetHit`), whether the stop ladder moved (`trailMoved`),
how many minutes it took to reach +1R, and the same signal replayed with a fixed
stop (`noTrailOutcome`, `noTrailR`) as a counterfactual. The Journal tab's
**Exit audit** turns those into the two questions a win rate cannot answer: how
often a trade reached +1R before it ended, and whether the trail helped or hurt
against leaving the stop where it opened. Rows written before the audit existed
have no path and are reported as excluded, never as zeroes. This is measurement
only; it changes no signal, stop or order.

**Read this before using them.** These are mechanical confluence checks, not
predictions. The higher-timeframe filter only refuses a setup that is fighting
the trend; it is not a forecast, and the checks do not know the news. Treat them
as a prompt to look at the chart, never as a reason to place a trade on their
own.

### How it decides to trade at all

Three answers, in order, and each one says which it gave:

1. **A proven rule.** The brain measures every strategy family on every market,
   grouped by the condition the market was in, and keeps a champion only where a
   cell clears 30 unseen trades, 0.10R each, t ≥ 2.5, and a positive result in all
   three unseen blocks. That still means most markets have no champion.
2. **The market's own live book** (`liveEvidence`, on by default). Twenty or more
   closed trades at a positive expectancy (t ≥ 1.5) buys **half** the risk when no
   backtest proof exists. This is the path that makes the app learn from its own
   results instead of only from history: the gate was previously deaf to them.
3. **The exploration budget** (`exploration`, on by default). When neither of the
   above applies, up to three trades a day (one per market) at a quarter of the
   normal risk, tagged `exploration` in the journal and never counted as proof.
   Without it an unproven market produced nothing, so it could never produce the
   evidence that would make it proven — the app sat at three signals, all held.

   This budget also reaches markets the **lab** has measured as having no edge.
   Those markets used to be silenced before the brain was ever asked, which shut
   the only door that could produce the live evidence to contradict the lab. Now
   their setups still run the rest of the funnel (reaction, thin stop, chop rule,
   proven rule) and, if nothing else allows them, can take the same quarter-size
   exploration trade. They stay labelled `exploration`, still count against the
   daily budget, and still never count as proof.

Both lanes are switches in Settings (`POST /api/exec/config` with
`{"exploration":{"enabled":false}}` or `{"liveEvidence":{"enabled":false}}`),
and every clamped value lives in `EXEC_DEFAULTS` in `server/settings.js`.

The statistics had a bug worth knowing about: a sample of identical results has
no spread, and floating-point noise made the t-statistic around 10¹⁶, which
clears any bar. Twenty identical trades could have been called proven. A sample
with no spread now returns no t-statistic at all, and `BAR_VERSION` was raised so
cells judged under the old number are re-measured rather than trusted.

A measurement records the hourly series, the rule list and the cost model it was
taken on, and a market is re-measured when any of those stops matching what the
build is using now — a provider switch, a promoted or removed rule, a new cost
model or a new build. Every affected market is measured back to back, one per
watch cycle, instead of one per half hour: a redeploy that retires all eleven
refills in minutes, not half a day. A market that fails is tried once per change
with its error kept, so a broken feed cannot spin the brain.

`/api/brain` reports that in `pending` (and the dashboard shows it under **Not
measured**): one row per market with no usable verdict, the `reason` (`entry series changed (1y/deriv → 1y/yahoo)`, `rule list
changed (added lab_orb)`, `measured before the last build change`, `never
measured`), `open` for whether the market is trading now, and `error` for the
last failure while measuring it. An empty `pending` means every market has a
verdict the build stands behind.

### Which book a number came from

Three things happen to a signal and they are counted separately, everywhere:

| Book | What it is |
| --- | --- |
| signals | what the app decided: `open`, `closed`, `expired` |
| live | what was actually ordered into the paper/live account |
| shadow | what the gate's refusals would have paid |

The journal and money panels both report these three, plus a `consistent` flag
and a list of gaps: a tracked result with no journal entry (back-filled on the
next start), or a journal entry closed with no tracked signal behind it. Before
this, the panels answered "how many trades" with three different numbers and
nothing on the screen said why.

### What the live-rule lab actually found

The old walk-forward numbers came from a different strategy: hourly bars, a
close inside a zone, and a grid of 180 or 1,440 configurations. They were not
evidence for the 15-minute rule the watcher sends. The lab now calls the same
`signals.evaluateSignal` and `strategies.resolve` as the live path: the
configured entry timeframe, the higher-timeframe EMA20/50 filter, last-closed-bar
confirmation, the 20-bar sweep stop, one position at a time, the 30-minute
cooldown, 24-hour expiry, and modelled spread, slippage and commission. It walks
three entry cohorts over the deepest history each feed provides and applies one
fixed gate: 100+ trades, above 0.08R net per trade, t ≥ 2, and 2 of 3 blocks
positive. There is no parameter grid and no tuning.

As of 25 November 2026, 15m entries, Deriv candles, modelled costs:

| Market | Trades | Net R/trade | t | Positive blocks | Gate |
| --- | ---: | ---: | ---: | ---: | --- |
| XAUUSD | 103 | +0.089 | 0.74 | 2/3 | no edge |
| NASDAQ | 59 | +0.063 | 0.43 | 2/3 | no edge |
| BTCUSD | 160 | -0.097 | -1.09 | 1/3 | no edge |
| EURUSD | 100 | -0.098 | -0.84 | 1/3 | no edge |
| GBPUSD | 106 | -0.224 | -2.11 | 0/3 | no edge |
| USDJPY | 105 | -0.092 | -0.81 | 1/3 | no edge |
| AUDUSD | 107 | -0.296 | -2.85 | 1/3 | no edge |
| USDCAD | 90 | -0.218 | -1.93 | 1/3 | no edge |
| USDCHF | 95 | -0.258 | -2.58 | 0/3 | no edge |
| AUDJPY | 89 | -0.157 | -1.26 | 0/3 | no edge |
| NZDJPY | 130 | -0.195 | -2.03 | 0/3 | no edge |

None passed. XAUUSD and NASDAQ are the only positive net results; XAUUSD's
t-statistic is far below 2, and NASDAQ has only 59 trades. The gate was not
lowered to make either pass. A market with no current verdict — or a verdict
from another timeframe or rule set — is **held**, not allowed.

## The assistant

The assistant sits at the top of the **Watch** tab — the first thing on the
front page — so asking "why is gold blocked?" never means opening Settings
first. It is read-only to use. Its provider, model and API-key fields live in
**Settings → Assistant (LLM + retrieval)**, behind the dashboard password.

It answers from the app's own state and can look things up instead of guessing. Its tools are read-only except one, and every one of them
returns plain data the model must quote rather than invent:

| tool | what it reads |
|---|---|
| `market_state`, `zones_state` | live quotes, every zone with its state, distance and touches |
| `auto_trading_status` | executor mode, kill switch, equity, today's P&L, risk limits (no secrets) |
| `alerts_today`, `signal_results`, `journal_summary` | alerts sent and held, tracked outcomes, the trade log |
| `lab_verdict`, `brain_status`, `brain_gate` | out-of-sample verdicts and the per-market gate |
| `learning_summary`, `search_notes` | what the learner muted, and the project's own notes |
| `news_outlook`, `market_hours`, `discord_activity` | calendar risk, session state, recent Discord deliveries |
| `app_settings` | markets, trading rules, quiet hours, broker mode, cost settings |
| `daily_recap_preview` | tonight's recap text |
| `send_discord` | **writes** one message to alerts/signals/results/news/recap, only when you ask it to |
| `web_search` | the live internet, via Exa |

### Internet search

Set an Exa API key in **Settings → Assistant** (**Save search key**) or as
`EXA_API_KEY` in the environment. The key stays server-side; the API only ever
reports its last four characters. Exa's free tier covers a few thousand searches
a month, and the tool is capped at five results per call with 500-character
excerpts, so a chatty assistant cannot burn the budget in one question. With no
key the tool tells the model search is unavailable, and the model is instructed
to say so rather than answer as if it had checked.

## Auto-trading

Off by default, and paper mode until you change it. Signals the app would post
can be placed as orders, with limits that can only ever refuse a trade: 0.5% of
equity risked per trade (sized from the real stop distance), one position per
market, no stop closer than four spreads, and a daily stop that is **off by
default** — switch it on with
**Daily stop** in the paper-trade panel and it stops the day at the loss limit
above it. The manual kill switch survives restarts either way.

Every order is charged the broker's cut: half the spread on entry, the other
half plus commission and swap on exit. Spreads come from the broker itself once
the bridge is connected — "Read live spreads" pulls the account's current spread
for each market, and it is refreshed with the account every few minutes. Until
then a table is used (gold 0.30, Nasdaq 1.5 points, majors about 1.2 pips), and
`costs.spreads` overrides either. Commission and swap are set in the panel.

Paper fills slip as well, because a market order never fills at the price on the
screen. Every entry is moved against the trade by a quarter of the spread
(`costs.slippageSpreadMultiple`, or `costs.slippage` per market), and a stop
fills at the stop plus that slippage — or at the price the market actually
gapped to when it blew through both. Targets stay at the target: a gap running
past one is not booked as a better fill than the one that was planned. Paper
results are net of costs, and the status line answers the only question
that matters for a small edge: whether today's winners still paid for every
trade taken, broker included.

Paper sizes fractionally, down to a ten-thousandth of a lot, so the risk
percentage is the risk the settings promise rather than whatever a 0.01 lot
minimum happens to be. At a small balance that is the difference between
risking $1 and risking $20 on gold. These sizes are not broker-legal: paper
here tests decisions at the stated risk, not the smallest order a broker will
accept — worth remembering when a paper result is read as a promise.

The shadow book is the other half of the gate question. Every setup the
proven-rule gate refuses is also paper-traded in its own ledger
(`shadow.json`), with the same balance, risk, spread, slippage and stop rules,
and each fill records the verdict that rejected it. It never places an order
and never touches the live account.

News blackouts are priced the same way. When a high-impact event puts the app
into a blackout, the setups that appear during it used to be dropped before
they were written down, so the filter had never been measured. They now go to
the shadow book with the event named in `heldReason` and `newsBlocked: true`,
at the same risk, spread and costs as any other shadow trade. They still cannot
reach the tracker, Discord or the executor. The panel and the daily recap can
then say what the blackout cost or saved, separately from what the gate cost or
saved.

Paper capital is set once from `capital.json` in the repository: on boot the
app applies that figure to the executor's balance, the shadow book's balance and
the account size signal sizing uses, then records it in `capital.json` in the
state folder so a restart never re-applies an old number over newer results.
Closed trades are kept — this changes the money behind the ledger, not its
history. `PAPER_CAPITAL=0` in the environment skips the step.

The book needs the refusals to reach it, so while it is running the lab's
verdict no longer keeps a setup away from the gate: a market the lab measured
as having no edge still sends its setups through, the gate still refuses them
(or takes its one exploration trade), and whatever it refuses is priced. Only
what the gate approves is ever sent or traded. The daily recap reports its equity, today's
money and win/loss record beside the live paper account, so the gate can be
judged on what it prevented instead of taken on faith.

The break-even panel turns that into a decision per market. Because spread and
risk both scale with lot size, the two cancel: cost in R is just the spread over
the stop distance. So the table shows what share of your risk the spread eats,
the win rate needed to finish ahead at the app's 1:2 target, and the expectancy
at the reference win rate shown in the table — measured stops come from your own
closed signals, then the signals on the board, and an assumed stop is labelled
as one.

### Exness, through the MT5 bridge

Exness accounts are MetaTrader 4/5 accounts, and MetaTrader has no public REST
API, so the broker is reached through the small service in `bridge/` that runs
next to a logged-in MT5 terminal. See `bridge/README.md` for setup.

### Running 24/5 without your PC

Two machines are involved, and only one of them has to be yours. The app runs on an always-on free host (see *Deploying for free* below), which never
sleeps, so it is already watching and polling.
The bridge is the part that needs Windows, because the MetaTrader5 Python
package only talks to a terminal on the same Windows machine.

So the bridge goes on a **cheap Windows VPS** — a few dollars a month, stays up
whether your laptop is open or not, and gives the app a fixed address. Setup is
one command in PowerShell (as Administrator) inside the bridge folder:

```powershell
.\setup-windows.ps1 -Login 12345678 -Password 'mt5-password' -Server Exness-MT5Trial8 -EnableAutoLogon
```

It installs Python and the MetaTrader5 package, installs the Exness terminal,
copies the bridge, writes its config with a generated secret, locks that file to
your user, registers a startup task that restarts the bridge if it dies, opens
the firewall port, then prints the Bridge URL and secret to paste into the app.
`-EnableAutoLogon` makes the VPS sign itself in after a reboot; without it the
task starts at your next sign-in.

Practise on the demo exactly like that. When you mean it, add `-Live`, which is
the only thing that lets the bridge touch a real account.

Once the bridge is configured, **Risk → Auto-trading → Read Exness account**
pulls the real login, server, currency, balance, equity and the broker's own
open positions. The account is re-read every five minutes while bridge mode is
on, and position sizing uses that equity rather than the typed-in balance. A
reading older than fifteen minutes is ignored, so a dead bridge cannot quietly
size trades off a stale number.

The broker's positions are shown for comparison only. The app keeps its own
ledger of what it opened: two owners of one position is how a daily loss cap
stops meaning anything.

### Direct broker API — no machine of yours

A broker with a real HTTP API removes the machine entirely: the app places the
order from wherever it runs (your host), the broker holds the stop and the target,
and nothing has to stay switched on. Set **Mode → Direct broker API**, fill in the account ID and token,
save, then press **Test broker API** and **Read account**.

OANDA v20 is the implementation in `server/brokers/oanda.js`:

- **Practice and live are different hosts**, so a practice token cannot reach a
  live account. The token is stored server-side and never sent back to the page.
- **Sizes are units, not lots.** Gold is 100 oz per lot, FX 100,000 units, the
  index 1 unit per lot. A size below the broker's minimum is **refused with a
  reason**, never rounded up, because rounding up would multiply the risk the
  limit exists to cap.
- **The broker owns the exits.** Stops and targets are attached to the order, so
  they work even if this process dies. The app stops managing exits itself and
  instead reconciles: when the broker no longer holds a position, the app settles
  it at the current price, marks whether it won or lost, charges the exit cost,
  and notes that the broker closed it.
- **Equity, balance and spreads come from the broker** and feed sizing, the cost
  model and the break-even table, the same way the bridge readings do.

**cTrader** (Pepperstone, IC Markets, and most other cTrader brokers) is the
second implementation, in `server/brokers/ctrader.js`. It speaks the Open API
over a WebSocket on port 5036 using JSON, so there is no protobuf toolchain and
no extra dependency. Choose **cTrader** in the Direct broker list and fill in:

- **client ID** and **client secret** — from an application you register at
  <https://openapi.ctrader.com>. Set its redirect URL to anything you control
  (the app does not host the callback); you only need the code once.
- **refresh token** — exchange the one-time code at
  `https://openapi.ctrader.com/apps/token` (`grant_type=authorization_code`).
  Ask for `scope=trading` on the consent URL, not `accounts`: the latter is
  view-only and a token carrying it cannot place an order.
  Access tokens expire after about 30 days, so store the refresh token and the
  adapter renews the access token by itself; that is what keeps it running
  unattended.
- **account ID** — the numeric `ctidTraderAccountId`, not the login shown in the
  platform. The adapter lists your accounts and picks the configured one.

**No terminal at all, from the phone.** Put the app's client ID and secret in the
Direct broker panel, register `<the app URL>/api/exec/ctrader/callback` as a
redirect URI on the cTrader application, then press **Connect cTrader**. The
dashboard hands the browser to cTrader's own consent page, cTrader sends the
one-time code back to that callback, and the server redeems it, asks the trading
socket which account it belongs to, and writes the client ID, secret, tokens,
environment and account id into `settings.json` — then returns to the dashboard
with a one-line result. The client secret never leaves the server, no token is
ever shown in the URL, and a `state` value ties the callback to a sign-in this
process started, so a stray callback cannot inject someone else's code.

If you would rather see the exchange happen, or the redirect has to land
somewhere else, the same flow exists as one guided command; you only copy the
code cTrader puts on your redirect URL:

```bash
node scripts/ctrader-auth.js --client-id <id> --client-secret <secret> \
  --redirect-uri <the app's redirect URL>
```

It prints the consent URL, takes the redirect URL or the bare code back (paste
it, or pipe it: `echo "<code>" | node scripts/ctrader-auth.js …`), exchanges it,
then finds your `ctidTraderAccountId` over the trading socket — the token
endpoint never returns it — by trying the demo host and then the live one,
writes the client ID, secret, refresh token, account and environment into
`settings.json`, and finally reads the account back to prove the connection,
showing the broker, login, balance and equity. If discovery cannot reach cTrader
it still saves the tokens and tells you to enter the account id in the panel.

`--account <id>` and `--environment practice|live` skip discovery when you
already know them, `--print-only` writes nothing, and the client ID, secret and
redirect URL can also come from `CTRADER_CLIENT_ID`, `CTRADER_CLIENT_SECRET` and
`CTRADER_REDIRECT_URI`. It is a one-time step: the app renews the access token
itself from then on.

Practice and live are separate hosts (`demo.` and `live.`), so a demo token
cannot reach a live account. cTrader allows one trading connection per account:
stop the desktop platform's connection, or the order requests will be refused.
Sizes are converted to the broker's own volume units using the symbol metadata
it reports, and a size below the minimum volume is refused rather than rounded
up.

Adding another broker is a new file in `server/brokers/` plus one line in its
registry — the executor does not know which one is configured. Worth knowing
before choosing: OANDA's v20 API is not offered to its Global Markets division,
and Exness publishes its API only for Vietnam and Thailand, which is why cTrader
exists here as well.

### On the phone

The dashboard is the phone client; there is no separate app to install from a
store. Open the dashboard (`https://zone-watch.<username>.serv00.net` from step 7
of *Deploying for free*, or `http://<vm-ip>:3000` plus the Caddy step on a VM) in
Safari or Chrome and use **Add to Home Screen**. It runs standalone (its own icon,
no browser chrome), remembers nothing locally because the server owns all the
state, and every screen works — watch, zones, news, risk, auto-trading, the
assistant and its microphone (which needs an HTTPS address, so use the proxy site
with a certificate if you want voice on the phone).

Wide tables scroll sideways inside their panel rather than pushing the page, and
form fields use a 16px font so iOS doesn't zoom in when you tap one. The
auto-trading panel is the important one on a phone: it is where you can see an
open position, hit the kill switch, and read whether today's winners paid the
broker.

### TradingView alerts

TradingView has **no public API for placing orders** — its REST API is a
broker-integration product, and its support pages say there is no data or
execution API for individual traders. What it does have is an alert that POSTs
to a URL you own, so that is the integration: TradingView decides, Zone Watch
receives, the executor places.

1. Risk → Auto-trading → tick **TradingView alerts**, set a **webhook secret**,
   save. The panel shows the URL to paste into the alert.
2. In TradingView, create an alert with *Webhook URL* set to
   `https://your-host/api/tv/webhook?token=<your secret>`.
3. Send either JSON in the alert message:

```json
{"symbol":"XAUUSD","action":"buy","entry":4010,"stop":3990,"target":4050}
```

   or one line, which is easier to write by hand:

```
BUY XAUUSD entry=4010 stop=3990 target=4050
```

Symbols are normalised, so `OANDA:XAUUSD`, `^NDX`, `NAS100` and the Exness
`XAUUSDm`/`EURUSDm` forms all resolve to the right market. A malformed alert is
rejected with the reason (`400`), a bad token gets `401`, and a refused order
gets `422` with the executor's reason.

**Require the brain gate** is on by default: an alert is only placed if the
brain has a proven rule for that market in its current condition. Turning it
off lets any alert through and is labelled *gate bypassed* in the status panel.

Caveat worth stating plainly: an alert is only as good as the strategy behind
it, and TradingView's own alert tester sends a real order.

## The dashboard password

The dashboard can start auto-trading, switch it to a live broker and fire the
kill switch, so it is not open to whoever finds the URL. The first time it is
opened it asks you to choose a password (at least 8 characters); after that the
browser keeps a signed, httpOnly session cookie for 60 days, so the phone signs
in once and stays signed in. The password is stored as a scrypt hash, never as
text, and the cookie is signed with a secret generated on the server, so a forged
cookie is refused.

**The dashboard reads without a password; changing it does not.** Zones,
signals, news, journal and learning are public — that is what makes a cron job,
a bookmark or a monitoring service able to load the app (and wake a stopped
machine) with no cookie at all. The **Settings tab** is the locked part: open it
and it asks for the password before it shows a single field.

What needs the session, listed once in `server/index.js` as `AUTH_ONLY_PREFIXES`
and `AUTH_ONLY_PATHS`:

| Locked | Why |
| --- | --- |
| `/api/settings*` | Discord webhooks, watch list, alert switches |
| `/api/exec*` | broker bridge, account number, risk rules |
| `/api/websearch*` | search API key |
| `/api/recap*` | recap schedule and sends |
| `/api/status-ping*` | uptime ping URL |
| `/api/delivery` | delivery history |
| `/api/ai/status`, `/api/ai/config`, `/api/ai/test`, `/api/ai/clear` | model key and endpoint |
| `/api/discord/test`, `/api/lab/run`, `/api/brain/run` | send and run actions |

Everything else stays public, including `/healthz`, `/api/heartbeat` (a status
probe with no secrets, for cron jobs that must be able to wake a stopped machine),
`/api/tv/webhook` (it carries its own token and cannot work behind a cookie) and
the assistant's `/api/ai/ask` and `/api/ai/agent`, which the front page uses.
Adding a new `/api/exec/*` or `/api/settings/*` route is private automatically;
anything outside those prefixes is public by design, so never put a secret on a
path that is not in that list.

**Locked out and no shell to fix it with?** Set `ZW_DASH_PASSWORD` (8 characters
or more) in the host's environment or secret store and restart the app. On
start-up it adopts that value as the dashboard password, keeping the cookie
signing secret, and logs `dashboard password adopted from ZW_DASH_PASSWORD`.
Sign in, change the password in Settings if you want a different one, then remove
the variable — while it is set it wins over the hash in `settings.json` on every
start, **except** the value you just replaced: a password set in Settings records
that value as spent, so a host that keeps injecting a variable you have deleted
(some do, until the release is recreated) can no longer undo your password at
every restart. Setting the variable to a *new* value is honoured again, so the
recovery route still exists. It is a server variable rather than a reset form on the site precisely
because anyone who found the URL could otherwise use a reset form to lock you out.
The variable's **value** is the password; its name, `ZW_DASH_PASSWORD`, is only
the label. A value shorter than 8 characters is ignored (and logged).
`/api/auth/status` reports `envManaged: true` while it is in force, and
`envAdopted: true` only when that value really is the hash on file — that is the
field to read when a password that "should" work is refused, because it separates
a wrong string from a value the server never took. The value is also accepted at
sign-in and as the current password when changing it, so recovery does not depend
on the start-up write to `settings.json` succeeding. If that write fails anyway
(a read-only or full disk) the app still starts — locked, with the password
already on file — and logs the reason instead of failing to boot.

On a host you can reach, the other way is to remove the `auth` object from
`settings.json` (`~/zone-watch/settings.json` in Serv00's file manager or over SSH,
`sudo nano /opt/zone-watch/settings.json` on the VM, or `docker exec` on a Docker
box) and restart it: the app offers the setup page again. Signing out is `POST /api/auth/logout`; the
login page also explains this.

### Deploying for free (no card)

This app has to poll prices around the clock and keep its ledger, and no free
*platform* does both in 2026. Render's Free web service spins down after 15
minutes without traffic, may restart at any time, and gives the process no disk
at all, so its filesystem is wiped on every restart. The ledger half of that has
an answer (*When the host has no disk* below); the fifteen quiet minutes do not. Koyeb now wants a card and a $29 hold, Heroku's free tier
ended in 2022, Fly's free allowances ended in 2024, Railway's Free plan is $1 of
usage a month, and alwaysdata's Free plan forbids programs that run 24/7. None of
them can host this.

What can is a **free shared shell host**: a small account with SSH, a reserved
port and a few gigabytes of real disk, where your process is allowed to stay
running. It is not a VM — there is no root, no Docker and no `apt` — but this app
is plain Node and three JavaScript libraries, so it does not need any of that.

**Serv00** is the one to use. It has been running for years, it asks for no card,
and it gives 3 GB of SSD, 512 MB of RAM, three open TCP ports, SSH and long-running
processes on a `*.serv00.net` subdomain that can carry a real Let's Encrypt
certificate.

**Registration is often closed.** Serv00 caps each server at 10,000 accounts, so
<https://www.serv00.com/register-account> sometimes answers "registration is
currently disabled". Try again in a few days, or use the Waifly fallback below.

**Setup, once: one command.** Register, verify the email, set **Additional
services → Run your own applications → Enabled** in the panel, then paste this
over SSH:

```sh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/youssefwael19-cmd/ZoneWatch/main/deploy/serv00-setup.sh)"
```

It checks Node, reserves a port if you have none, downloads the code into
`~/zone-watch`, installs the dependencies, starts it under PM2, waits until it
answers on the port, then adds the `zone-watch.<username>.serv00.net` proxy site
and asks Let's Encrypt for a certificate. Run it twice and it updates and
restarts rather than starting a second watcher.

It fetches both itself and the app from GitHub over HTTPS, so this repository has
to be public for that one line to work. If it is not, clone it yourself on the
server (or upload the folder through the panel's file manager) and run
`sh deploy/serv00-setup.sh` from inside it — the script does the same work either
way. The steps below are the same thing done by hand, and are worth reading even
if you use the script.

**The same setup by hand, about twenty minutes**

1. Register at <https://www.serv00.com/register-account>. The form asks what
   hosting will cost you — the answer is `free`. Use a real email address, verify
   it, then open the panel address from the welcome mail and create the free
   account.
2. In the panel, **Additional services → Run your own applications → Enabled**.
   Without this nothing in your home directory may be executable.
3. **Port reservation → Add port → TCP**, and write the number down. Every
   listener needs one of these; you get three.
4. SSH in (the host is `s<N>.serv00.com`, shown in the panel) and check Node:
   ```bash
   ssh <username>@s<N>.serv00.com
   node -v
   ```
   If that prints nothing or an old version, their Node guide
   (<https://docs.serv00.com/Node.js>) covers picking a current LTS in the panel;
   reconnect afterwards so `node` is on your path.
5. Get the code and its dependencies:
   ```bash
   git clone https://github.com/youssefwael19-cmd/ZoneWatch.git ~/zone-watch
   cd ~/zone-watch && npm install --omit=dev
   ```
6. Keep it running with PM2, bound to the port from step 3:
   ```bash
   npm config set prefix ~/.npm-global
   npm install -g pm2
   echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.profile
   . ~/.profile
   PORT=<reserved-port> NODE_ENV=production pm2 start server/index.js --name zone-watch
   pm2 save
   ```
   PM2 restarts the app if it crashes and the app keeps polling with no browser
   open. A reboot of the shared server needs one `pm2 resurrect` over SSH — there
   is no init system you can hook, so this is the one manual thing.
7. Give it a URL with HTTPS. In **WWW websites → Add new website**: domain
   `zone-watch.<username>.serv00.net`, type **Proxy**, target `localhost`, port the
   number from step 3. Then **Manage SSL certificates → Add certificate → Let's
   Encrypt** for that same domain. `https://zone-watch.<username>.serv00.net` is
   now the dashboard, and the password and session cookie travel encrypted — do
   not skip this, the password is the only thing between the internet and the
   trading account.
8. Open that URL. It asks for a dashboard password; that is the normal first-run
   page, not an error. Then in the Settings tab set what the old install had:
   paper balance **200**, leverage **2000**, stop-out level **100%**, risk **0.5%**,
   max positions **2**, then the Twelve Data key, the Discord webhook, the watch
   list and the unproven markets.
9. Confirm it is alive over SSH: `curl -s localhost:<port>/api/health` returns ok,
   and `curl -o /dev/null -w '%{http_code}\n' localhost:<port>/healthz` returns
   `200` while the watcher is running (503 means it is stuck).

**Waifly, if Serv00 sign-ups are closed.** <https://waifly.com> gives 300 MB of
RAM, 1 GB of disk, one port and a container that never sleeps, with no card and no
trial. Create a server with the **NodeJS** egg, upload the repo over SFTP, set the
start command to `npm start` (the port arrives in an environment variable — do not
hard-code one), and start it. The catch is free-plan TLS: there is no free
subdomain with a certificate, so you reach it at `http://<ip>:<port>` and the
dashboard password crosses the network in clear text. Fine for a look around, not
for a live broker token you care about.

**The honest catches.** No root means no Caddy, no systemd unit, no Docker — that
is why the steps above use PM2 and the panel's proxy instead. 512 MB of RAM is
plenty for this process but leaves nothing for a heavy analyzer run. It is FreeBSD,
so `apt` and prebuilt Linux binaries do not exist. There is no SLA and support is
a forum. And a free Serv00 account is deleted after **90 days without a login to
the panel or SSH**, data unrecoverable — put a recurring reminder in your calendar,
because nothing in the app can protect you from that. None of this is a trial or a
30-day offer; it stays free for as long as you keep it alive.

### When the host has no disk: an external state store

A host with no persistent disk — Render's Free web service is the obvious one —
loses every file the app writes on each restart. Nothing inside the app can
change that. What it can do is keep a copy of those files somewhere that does
survive, and put them back at boot.

Set these on the service:

| Variable | What it does |
| --- | --- |
| `STATE_STORE=supabase` | switches it on. Unset, or anything else: plain local files, exactly as before. |
| `SUPABASE_URL` | `https://<project>.supabase.co` |
| `SUPABASE_SERVICE_KEY` | the service role key (also read as `SUPABASE_KEY`) |
| `STATE_TABLE` | optional, defaults to `zone_watch_state` |

Then run `deploy/supabase-state.sql` once in the Supabase SQL editor. It creates
one table with one row per state file and leaves row level security on with no
policy, so only the service role key can read it. That key is a real secret: it
goes in the host's environment settings, never the repo or the Settings tab.

How it behaves:

- On boot, before the app serves anything, every stored file that is newer than
  the local one is written back to disk. Any file replaced this way is first
  copied to `state-backup/`, so a real ledger is never silently lost.
- A local file that is genuinely newer — from a push that failed on the way out —
  wins and is pushed again rather than overwritten.
- After every save (the ledger, the journal, the settings) the new contents are
  pushed in the background, so a 10-second watch cycle never waits on the
  network. A failed push keeps the local file, logs once, and retries.
- With `STATE_STORE` unset none of it runs and nothing about the app changes.

Supabase's Free plan needs no card and holds 500 MB; the app pushes a few tens of
kilobytes a minute, and its own activity keeps a Free project from being paused
for inactivity.

What this does **not** fix, on Render Free specifically:

- **Spin-down.** Fifteen minutes without inbound traffic and the watcher stops.
  A free pinger (cron-job.org, UptimeRobot) hitting `/api/health` every 5–10
  minutes counts as traffic and keeps it awake, but the workspace's 750 free
  instance-hours a month are barely one always-on service, and the month it runs
  over, everything is suspended until the next one.
- **A fifth of the paid CPU.** A Free instance is 0.1 CPU and 512 MB, and Render
  may restart it at any time. Expect slower cycles, and an OOM restart is just
  another restore from the store.

If you have a host with real disk, leave all of this switched off — local files
are faster and have no network in the path.

### ProductEcho: free, no card, no SSH

**ProductEcho** (<https://app.productecho.com/signup>) is the least work of all
of them, and it is free forever with no card: an app runs there as an ordinary
server process that stays up, gets a public HTTPS address on
`your-app.productecho.com`, and is deployed from a GitHub repository — private
ones included — with a rebuild on every push. The Free plan allows 10 apps, a
1 GB PostgreSQL database, and unlimited build time on a shared cluster.

Its one trap is the same one Render has, with a fix that Render does not: a
full-stack app's own disk starts empty on every restart or redeploy. ProductEcho
sells the fix as **persistent storage** — one folder, here `/data`, that survives
restarts, redeploys and pauses, shared by every copy of the app. The app has to be
told to keep its files there, which is what `STATE_DIR` is for.

1. Sign up, then in the console connect your GitHub repository and pick the
   branch. Deploy it as a full-stack app; Node is detected and `npm start` is the
   command it runs. The app already listens on the `PORT` the host provides.
2. On the app's Settings tab, add a **storage path** of `/data`. That is the
   whole change: at boot the app finds that folder on its own and reads and
   writes all 18 state files there, carrying over anything already on the
   disposable disk rather than losing it. `STATE_DIR` still works if you would
   rather name the folder yourself, but it is not needed for the usual path.
   Nothing is written next to the code, which matters because a volume makes the
   app run as the folder's owner and leaves `/app` read-only.
3. Redeploy so the app starts with the folder mounted. Every push to that branch
   now rebuilds and keeps the ledger, the journal and the dashboard password.
4. Open the HTTPS address it gives you. It asks for a dashboard password, which
   is the usual first-run page; then set paper balance **200**, leverage **2000**,
   stop-out **100%**, risk **0.5%**, max positions **2**, plus your Twelve Data key
   and Discord webhook.

Without step 2 everything still works — until the first restart, when the app
comes back with an empty ledger, settings at their defaults and no password. Two
ways to tell it worked: the log says `State folder: /data (18 of 18 state files
there)`, and `/api/health` carries a `state` block whose `mode` reads
`persistent` with the folder and how many state files it holds, or `local` with
the reason the folder was rejected.
Check it after any change here rather than trusting the log alone.

Two things I could not confirm from their public pages: whether the Free plan
can use persistent storage (I found no plan restriction in the docs, and the
console will say if it wants an upgrade — if it does, the Supabase store above is
the way to keep the data instead), and how many copies of a single free app run,
since two copies would both watch the same markets. Run one.

### If you have a card: Oracle Cloud Always Free

A card buys something better — a real VM with root, 1 GB of RAM and no shared
neighbours. **Oracle Cloud Always Free** has been free since 2019 and is not a
trial: always-on compute, a real disk, no sleep, no expiry.

- **VM.Standard.E2.1.Micro** (AMD, 1 GB RAM, 1/8 OCPU) is enough for this app, and
  it is the shape that is always available.
- The **Ampere A1** shape (2 OCPU / 12 GB, also Always Free) is a big upgrade when
  your region has capacity; these steps are the same either way.
- 200 GB of block storage and 10 TB of outbound traffic a month across the account.

**The honest catches.** Oracle asks for a card at sign-up for identity
verification only — Always Free resources are not billed, and the usual result is
a small authorisation that is refunded. If your bank refuses the card, use the
Serv00 path above: it is free too, just smaller. Oracle also reclaims Always Free
instances that sit genuinely idle — this one polls every ten seconds, so it never
is.

**Setup, once, about fifteen minutes**

1. Sign up at <https://cloud.oracle.com>. The home region is permanent, so pick the
   one nearest you.
2. **Compute → Instances → Create instance**: image **Ubuntu 24.04**, shape
   **VM.Standard.E2.1.Micro** (listed under Always Free), keep the 50 GB boot
   volume, and download the SSH key when the page offers it.
3. Open the ports in **two** places, because the cloud firewall and the VM's own
   firewall are separate. In the instance's **Subnet → Security list**, add ingress
   rules for TCP **22**, **80**, **443** and **3000** from `0.0.0.0/0`. Then on the
   box run `sudo bash deploy/open-port.sh 3000 80 443`: Oracle's Ubuntu image
   ships an iptables ruleset that drops everything except SSH, and without this
   step the app answers locally and nowhere else.
4. `ssh ubuntu@<public-ip>`, then install Node 22 and git:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs git
   ```
5. Get the code and start it:
   ```bash
   sudo git clone https://github.com/youssefwael19-cmd/ZoneWatch.git /opt/zone-watch
   sudo bash /opt/zone-watch/deploy/install.sh
   ```
   `install.sh` runs `npm install --omit=dev`, writes a systemd unit that starts
   the app on boot and restarts it if it ever crashes, and starts it now.
6. Open `http://<public-ip>:3000`. The app asks for a dashboard password; that is
   the normal first-run page, not an error. Pick at least 8 characters — it is the
   only thing between the internet and the trading account.
7. In the Settings tab set what the old install had: paper balance **200**,
   leverage **2000**, stop-out level **100%**, risk **0.5%**, max positions **2**,
   then the Twelve Data key, the Discord webhook, the watch list and the unproven
   markets.
8. Confirm it is alive: `curl -s localhost:3000/api/health` returns ok, and
   `curl -o /dev/null -w '%{http_code}\n' localhost:3000/healthz` returns `200`
   while the watcher is running (503 means it is stuck).

**One gigabyte of swap.** 1 GB of RAM is enough for this process, but a build or a
busy analyzer can spike. Swap removes the out-of-memory kill:

```bash
sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

**HTTPS, free, ten more minutes.** Step 6 is plain HTTP, so the dashboard password
and the session cookie would cross the internet readable. Fly and Render handed
you TLS automatically; on a VM you add it once:

1. Get a free hostname at <https://www.duckdns.org> — sign in, create a subdomain,
   paste the VM's public IP.
2. `sudo apt-get install -y caddy`, then put this in `/etc/caddy/Caddyfile`:
   ```
   <yoursub>.duckdns.org {
       reverse_proxy 127.0.0.1:3000
   }
   ```
3. `sudo systemctl restart caddy`. Caddy fetches and renews a Let's Encrypt
   certificate on its own, so `https://<yoursub>.duckdns.org` is the dashboard from
   then on. Ports 80 and 443 must already be open from step 3, and if you use
   cTrader, this is the hostname for its redirect URI.

**Moving the old data from Fly**

Honest answer: while the Fly trial is ended, its volume cannot be read — `flyctl`
refuses every command until a card is added, so `fly ssh console` cannot copy
`/app/data` out. The new host therefore starts empty on purpose: the setup page
gives you a fresh password and the Settings tab gives you the $200 paper balance,
which is the same starting point the old install had. If you ever get the Fly
account back, tar `/app/data` there and drop those files into the app's own
working directory (`/opt/zone-watch` on a VM, `~/zone-watch` on Serv00 — no paths
change either way), then restart. Do not run both apps at once afterwards: two
watchers double-post to Discord and each keeps its own ledger.

**Keeping it healthy**

- **Logs:** `pm2 logs zone-watch` on Serv00, `journalctl -u zone-watch -f` on a VM.
- **Restart:** `pm2 restart zone-watch`, or `sudo systemctl restart zone-watch` on
  a VM.
- **Update:** `cd ~/zone-watch && git pull && npm install --omit=dev && pm2 restart
  zone-watch` on Serv00; `cd /opt/zone-watch && sudo git pull && sudo bash
  deploy/install.sh` on a VM. Every update restarts the process, a gap of seconds,
  so expect one missed poll.
- Run **one copy only**. Two watchers double-post to Discord and both trade the
  same paper ledger. In particular, stop the old Fly app before starting a new
  host, or every alert arrives twice.
- Back up `settings.json`, `journal.json`, `executor.json` and `brain.json` from
  the app directory; those four cannot be rebuilt. On Serv00 the panel's file
  manager can download them, and an SSH `scp` works too.
- For an outside monitor use `/api/health` (200 even when the watcher is stale),
  not `/healthz` — a stalled watcher would otherwise look like a dead server.
- `fly.toml` and `render.yaml` stay in the repo for the record; neither host above
  uses them.

**Docker instead.** `deploy/docker-compose.yml` builds the same Dockerfile, keeps
`/app/data` on a named volume (so the settings, credentials and dashboard password
survive), restarts unless stopped, and health-checks `/healthz`:

```bash
docker compose -f deploy/docker-compose.yml up -d
```

Then point the phone at `http://<host>:8080`. This is a VM or laptop option only —
Serv00 and Waifly have no Docker, which is why their steps use PM2. Use one method,
not both, or the two copies will double-post and keep separate ledgers.

### Uptime monitoring (Healthchecks.io)

Settings → **Uptime monitoring** takes a ping URL (`https://hc-ping.com/<uuid>`).
The app sends a GET every 20 seconds while it is running; the service alerts you
when the pings **stop**, which is the one failure the app cannot report itself.

Because the ping is attempted from the watch cycle, the worst-case gap is the
interval plus one cycle — 30 seconds. Set the check's period to **1 minute** (2 is
safer) and its grace period to **3 minutes**: long enough that a slow ping never
shows as late, short enough that a stopped machine is reported within minutes
instead of after an hour. A check period shorter than the cadence shows as
permanently "late" no matter how healthy the app is.

Healthchecks only *receives* pings; it never calls the app, so it cannot restart
it or notice the gap before the app's own alert does. The app's own heartbeat
notice fires at 15 minutes, which is usually the first thing you hear. Nothing
stops the process from outside on an always-on host, so a missing ping means the
machine is down or the process is wedged and deserves a look at the process log
(`pm2 logs zone-watch`, or `journalctl -u zone-watch` on a VM), not a wake-up call.

Settings shows `last ping …` so you can see pings leaving, `Send test ping` fires
one immediately, and `/healthz` reports the same state for other monitors (200
while the watcher is alive, 503 when it is stuck).

### The cron job that wakes it

An always-on host never sleeps, so nothing has to wake it and a cron job is only a
second opinion from outside. If you keep one, use **`/api/heartbeat`** as the
URL, not `/healthz` and not `/`. It needs no
password, it answers `200` even when the watcher is stale, and it returns the
last check time so the service's history is meaningful. Point a cron at `/` and
the `302` to the login page looks like a failure to some services; point it at
`/healthz` and a genuinely stuck watcher makes the job fail 26 times in a row,
which is how such jobs get disabled automatically. `401 Unauthorized` in that
history means the URL is behind the dashboard password — that is a URL problem,
not a password problem, and the fix is this endpoint, not turning auth off.

When the job says it was disabled after repeated failures, re-enable it in the
cron service after fixing the URL; the app cannot re-enable it from here.

That same `/healthz` also counts **outside checks** — requests from a cron job or
URL monitor — and `/api/settings` shows the count next to the ping hint. If it
says "no outside check since start", nothing is actually knocking on the app, and
a stopped machine will stay stopped however the pings are configured. Every ping stops when the
container is down, so "down" from Healthchecks means the app is not running, not
that the ping URL is wrong.

## Running it 24/5

The server watches and posts to Discord whether or not a browser is open — but
only while the process is alive. To keep it alive you need a host that stays on —
the free one in *Deploying for free* above, a small VPS, a Raspberry Pi, or a PC
you leave running.

**systemd (recommended on a VPS or Pi):**

```bash
# copy the app to /opt/zone-watch, then:
sudo bash deploy/install.sh
journalctl -u zone-watch -f      # watch the logs
```

It installs dependencies, enables the service on boot, and restarts it
automatically if it crashes. Edit `deploy/zone-watch.service` if your app lives
somewhere other than `/opt/zone-watch`.

**PM2 (anywhere Node runs):**

```bash
npm install -g pm2
pm2 start deploy/ecosystem.config.js
pm2 save && pm2 startup
```

**Everyday tips:**

- Set `WATCH_INTERVAL_MS=10000` (the default) for 10-second checks.
- Keep `settings.json` private — it holds your API key and Discord webhook.
- Back up `zones.json` if you hand-draw levels you care about.
- The dashboard needs a password (see *The dashboard password* above), but the
  password and the session cookie travel in clear text over plain HTTP. Put it
  behind HTTPS — the proxy site plus certificate in *Deploying for free*, or Caddy
  on a VM — before you reach it from outside your own network.

## Important limits

- **The server does the watching, not the browser.** Alerts and Discord
  messages keep coming while the page is closed, but only while the server
  process is alive. A real 24/5 watcher still needs a machine or server that
  stays switched on.
- **Alerts are a prompt to look, not a signal to trade.** They tell you price is
  near a level you already drew. The decision, the stop and the size are yours.
- **Demo prices are random.** They exist so the app is usable before you add a
  key, not to represent a real market.
- **News feeds can lag or miss events.** Treat the calendar as a second opinion,
  not the only one. The calendar host also rate-limits datacenter IPs, so the
  app falls back to a reader for the same JSON, keeps the last good calendar on
  disk (`newscalendar.json`, reused for up to 36 hours) and slows retries to five
  minutes after a failure. A week-old file is still the right week's events; an
  empty one means the app would be blind to news risk entirely.

## Files

| File | Purpose |
| --- | --- |
| `server/index.js` | HTTP server and API routes |
| `server/market.js` | Price provider adapter (demo / Twelve Data) |
| `server/zones.js` | Zone validation, proximity logic, alert state |
| `server/news.js` | Economic calendar and headline fetching |
| `public/index.html` | The dashboard |
| `zones.json` | Your zones (created/updated by the app) |
| `alerts.json` | Alert history (capped at 200) |
| `analyzer.py` | Trade journal analysis |
| `analyze.py` | Journal CLI |
| `trade_logger.py` | Journal CLI logger |
