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

Discord cannot host the dashboard itself: the app stays in the browser and
Discord receives the alerts.

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
  not the only one.

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
