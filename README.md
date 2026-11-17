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
above) and paste them under **Settings → Discord alerts → Separate channels**:

| Channel | Carries |
| --- | --- |
| Alerts | price entering or approaching a zone, broken zones, daily-loss guard, feed watchdog, heartbeat and health warnings |
| Signals | signal entries, approach warnings, IVB breakouts |
| Results | every **win**, **loss** and expiry, with the pips and the money |
| News | economic-calendar warnings, session and market open/close |
| Recap | the daily recap, the weekly recap and the weekly paper review |

Any box left empty falls back to the default webhook, so nothing is lost by
filling in only the ones you care about.

Alerts, signals and results are three separate places on purpose: zones fire all
day, entries are the setups to act on, and results are the record of how they
went. Keeping the last two out of the zone stream means a channel you can read
like a scorecard, and muting zone noise never mutes a win or a loss.

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

Once a day, at or after 21:00 UTC, the app posts one recap to the **recap**
channel (falling back to the default webhook if none is set):

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

## Automatic zones

The bot can draw its own supply and demand zones from 15-minute candles, so
you are not starting from a blank chart.

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
entry, a stop just beyond the far edge of the zone, and a 2R target.

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

**Read this before using them.** These are mechanical confluence checks, not
predictions. Nothing here accounts for the news, the session or what the higher
timeframe is doing. Treat them as a prompt to look at the chart, never as a
reason to place a trade on their own.

### What the walk-forward testing actually found

An early version of this scoring reported a ~63% win rate. That number came
from one month of data the parameters had been tuned on, so it was in-sample
and meaningless as evidence.

Proper tests live in `research/`:

- `backtest_walkforward.js` — 6 months of 1h candles, three blocks, tune on the
  early blocks and measure on the unseen one. The old 0.6R version scored
  **44.6% win / -0.108R per trade** out of sample: no edge.
- `research/edge_search.js` — 180 configurations, fixed 1:2 target, stop half a
  zone-width beyond the far edge. Best honest result: **41.1% win rate,
  +0.234R per trade over 158 unseen trades**.
- `research/edge_search2.js` — 1,440 configurations with zone-quality filters.
  Out of sample it got **worse**: 36.5% and +0.094R. More filters, less edge —
  the signature of overfitting.

The live signal now uses the structure that survived: enter when price is
inside a zone, stop half a zone width beyond the far edge, target at 2R.

| Metric | Value |
| --- | --- |
| Trades (out of sample) | 158 |
| Win rate | 41.1% |
| Expectancy | **+0.234R per trade** |
| Target | 45% at 1:2 — **not reached** |

At 1:2 you need 33.4% just to break even, so 41% is positive on paper — but the
sample is small enough that the true figure could plausibly sit anywhere from
roughly 33% to 49%. Treat it as promising, not proven, and do not size up on it.

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
can be placed as orders, with three limits that can only ever refuse a trade:
0.5% of equity risked per trade (sized from the real stop distance), a hard
daily loss cap, and one position per market. The kill switch survives restarts.

Every order is charged the broker's cut: half the spread on entry, the other
half plus commission and swap on exit. Spreads come from the broker itself once
the bridge is connected — "Read live spreads" pulls the account's current spread
for each market, and it is refreshed with the account every few minutes. Until
then a table is used (gold 0.30, Nasdaq 1.5 points, majors about 1.2 pips), and
`costs.spreads` overrides either. Commission and swap are set in the panel.
Paper results are net of costs, and the status line answers the only question
that matters for a small edge: whether today's winners still paid for every
trade taken, broker included.

The break-even panel turns that into a decision per market. Because spread and
risk both scale with lot size, the two cancel: cost in R is just the spread over
the stop distance. So the table shows what share of your risk the spread eats,
the win rate needed to finish ahead at the app's 1:2 target, and the expectancy
at a 41.1% win rate — measured stops come from your own closed signals, then the
signals on the board, and an assumed stop is labelled as one.

### Exness, through the MT5 bridge

Exness accounts are MetaTrader 4/5 accounts, and MetaTrader has no public REST
API, so the broker is reached through the small service in `bridge/` that runs
next to a logged-in MT5 terminal. See `bridge/README.md` for setup.

### Running 24/5 without your PC

Two machines are involved, and only one of them has to be yours. The app runs on
Fly with `auto_stop_machines = false`, so it is already always on and polling.
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
order from Fly, the broker holds the stop and the target, and nothing has to stay
switched on. Set **Mode → Direct broker API**, fill in the account ID and token,
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
store. Open the Fly URL in Safari or Chrome and use **Add to Home Screen**. It
runs standalone (its own icon, no browser chrome), remembers nothing locally
because the server owns all the state, and every screen works — watch, zones,
news, risk, auto-trading, the assistant and its microphone (which needs the
HTTPS address Fly already gives you).

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

To reset a forgotten password, remove the `auth` object from `settings.json` on
the server (`fly ssh console` → edit `/app/data/settings.json`) and reload: the
app offers the setup page again. Signing out is `POST /api/auth/logout`; the
login page also explains this.

### When the host keeps stopping it

Fly's trial plan stops a machine **five minutes after it starts**. The log says so
outright (`Trial machine stopping. To run for longer than 5m0s, add a credit
card`), and nothing in the app can prevent it: `auto_stop_machines = false` stops
Fly parking an idle machine, it does not lift the trial limit. A machine that
keeps being stopped never accumulates zone-touch counts or signal history, so
signals look rarer than they are.

Two honest fixes, in order of effort:

1. **Add a payment method** at <https://fly.io/trial>. A `shared-cpu-1x` with 1GB
   and a 1GB volume is a few dollars a month and the machine then runs
   continuously.
2. **Run it anywhere with Docker.** `deploy/docker-compose.yml` builds this
   Dockerfile, keeps `/app/data` on a named volume (so the settings, credentials
   and dashboard password survive), restarts unless stopped, and health-checks
   `/healthz`:

   ```bash
   docker compose -f deploy/docker-compose.yml up -d
   ```

   Then point the phone at `http://<host>:8080`. Use a host that does not idle
   containers out — a free tier that sleeps on inactivity has the same problem as
   the trial, just with a longer timer.

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
wakes a stopped Fly machine except an incoming request to its URL: a monitor that
polls `/healthz` (a dead-man's switch will not) starts it each time, because
`auto_start_machines = true` is set. That keeps the gap near a minute but pauses
the watcher on every wake-up, so it is a workaround for the trial, not a fix.

Settings shows `last ping …` so you can see pings leaving, `Send test ping` fires
one immediately, and `/healthz` reports the same state for other monitors (200
while the watcher is alive, 503 when it is stuck).

### The cron job that wakes it

A cron service pointed at the app every minute is what keeps the gap near a
minute: the request starts the stopped machine (`auto_start_machines = true`).
Use **`/api/heartbeat`** as the URL, not `/healthz` and not `/`. It needs no
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
a stopped machine will stay stopped however the pings are configured. Every ping stops when the Fly
machine is stopped by the trial limit, so "down" from Healthchecks during a trial
is usually the machine sleeping, not a broken ping.

## Running it 24/5

The server watches and posts to Discord whether or not a browser is open — but
only while the process is alive. To keep it alive you need a machine that stays on:
a small VPS, a Raspberry Pi, or a PC you leave running.

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
- The app has no login. Do not expose port 3000 to the open internet; reach it
  over SSH tunnelling or a private network.

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
