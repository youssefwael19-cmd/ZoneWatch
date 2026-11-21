# Zone Watch — MT5 bridge

Runs on a **Windows** machine that has MetaTrader 5 installed and logged into the
Exness account. The app on Fly cannot reach MetaTrader directly: MT5 has no
public REST API, and MetaQuotes' Python package only works on Windows, next to a
running terminal. This bridge is the smallest thing that closes that gap.

## What you need

- Windows (your PC, or a Windows VPS if the PC isn't always on)
- MetaTrader 5 installed, logged into the **Exness demo** account
- Python 3.9+ from python.org
- In MT5: Tools → Options → Expert Advisors → **Allow algorithmic trading**

## The one-command path (recommended)

On a Windows VPS — so nothing has to stay on at home, and the app keeps trading
while your laptop is shut — or on a PC you leave running, open PowerShell as
Administrator in this folder and run:

```powershell
.\setup-windows.ps1 -Login 12345678 -Password 'mt5-password' -Server Exness-MT5Trial8 -EnableAutoLogon
```

That is the whole setup: Python, the MetaTrader5 package, the Exness terminal,
the bridge and its config, a startup task that restarts it if it dies, the
firewall rule, and the URL and secret to paste into the app. Add `-Live` only
when you mean to trade real money, and expect the first run to take a few
minutes while the installers download.

The manual steps below are what that script does, kept for reference and for the
case where something has to be done by hand.

## Setup by hand

```bat
pip install MetaTrader5

set ZW_BRIDGE_TOKEN=make-this-long-and-random
set MT5_LOGIN=your-demo-login
set MT5_PASSWORD=your-demo-password
set MT5_SERVER=Exness-MT5Trial8

python mt5_bridge.py
```

It prints the account it connected to and whether it is demo or live. If it says
LIVE, it exits — that is deliberate, and `ALLOW_LIVE=1` is the only way past it.

Then in Zone Watch → Risk → **Auto-trading**:

| Field | Value |
|---|---|
| Mode | Bridge (MetaTrader 5) |
| Bridge URL | `http://your-machine:8787` |
| Bridge secret | the same `ZW_BRIDGE_TOKEN` |

Press **Test bridge**. It should answer with the account balance, currency and
`demo: true`. **Read Exness account** then pulls the live balance, equity and
the broker's own open positions into the panel, and the app re-reads them every
five minutes while bridge mode is on so position sizing uses the real equity.

**Reconciliation** uses `GET /positions` (what the terminal still holds) and
`GET /closed?hours=N` (closing deals from the terminal's own history, with each
fill price and reason). The app no longer closes a bridge trade on its own
quotes: when the terminal stops, targets or stops out a position, that deal is
what the ledger books, so the journal and the account agree on both the exit and
its price. `POST /order` answers with both the order ticket and the position
ticket, because MT5 uses different numbers for the two.

Every reconciliation pass also compares the stop the terminal holds for each
position with the stop the app believes it set. When the terminal's stop is
behind the app's (or the position has none at all), the app sends its own stop
through `POST /modify` in the same pass, so a trail that did not land corrects
itself within one cycle instead of leaving the account less protected than the
panel says. When the terminal holds a *tighter* stop — someone changed it by
hand — the app adopts the broker's number instead of loosening it, because the
bridge refuses to move a stop the wrong way. A correction the bridge refuses
stays on the Trading panel with the reason, and the next cycle sends it again.

**Trailing stops** use `POST /modify` with `{"symbol": "XAUUSDm", "ticket": 123456,
"sl": 2401.5, "tp": 2420.0}`, which sends `TRADE_ACTION_SLTP` for that position and
answers with the stop the terminal actually holds. The app's stop ladder (break-even
at 1R, then 0.5R behind the best price) is applied to the broker's own stop, so a
position is protected where it lives rather than only in the app's memory. The
bridge refuses to loosen a stop and refuses an amend with no stop price.

**Read live spreads** uses `GET /spreads?symbols=XAUUSDm,USTECm,...` and returns,
per broker symbol, the current spread in points and in price units. The app uses
that number for the cost of every order and for the break-even table, because
only the broker knows its spread has widened for the news. The reading is treated
as stale after 15 minutes and the app falls back to its own table.

## Letting the app reach the bridge

On a VPS with a public IP there is nothing to do: the script opens the port and
prints `http://<vps-ip>:8787` for the Bridge URL. Keep the secret long — it is the
only thing guarding the account, so don't reuse it and don't paste it in chat.

If the bridge is on a PC at home instead, the app cannot see a local address.
Options, simplest first:

1. **Cloudflare Tunnel** — `cloudflared tunnel --url http://localhost:8787` gives
   you an HTTPS URL with no port forwarding. Paste that into Bridge URL.
2. **A Windows VPS** with a public IP and a firewall rule for port 8787. Keep the
   token long; it is the only thing protecting the account.
3. Port forwarding on your home router (least recommended — exposes the machine).

## What it will and will not do

- Sends the stop loss with every order, so the broker holds the stop even if the
  bridge or the app dies mid-trade — and moves it at the terminal as the trade
  runs, so the trailing stop is real protection, not a number in the app.
- Refuses a position on a symbol it already holds.
- Refuses lots above `ZW_MAX_LOTS` (default 5).
- Answers `403` on a live account unless `ALLOW_LIVE=1`.
- Reports the terminal's actual retcode rather than assuming success.

## The honest caveats

- **A demo account can lie.** Fills are instant and slippage is kind. Expect the
  real account to be worse, especially on gold around news.
- **This is Windows-only by necessity**, so it is the one part of the system I
  cannot run or test here. Test it on the demo account before trusting it.
- **The app's proof is still thin.** The executor is built so that being wrong is
  survivable — 0.5% per trade, a daily loss cap, and no orders at all when the
  brain gate is silent — not because the edge is confirmed.
- **Exness's own API is not an option**: it only serves Vietnam and Thailand and
  does not support indices.
