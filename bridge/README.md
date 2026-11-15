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

## Setup

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
`demo: true`.

## Letting the app reach the bridge

If Zone Watch is on Fly (the internet) and the bridge is on your PC at home, the
app cannot see a local address. Options, simplest first:

1. **Cloudflare Tunnel** — `cloudflared tunnel --url http://localhost:8787` gives
   you an HTTPS URL with no port forwarding. Paste that into Bridge URL.
2. **A Windows VPS** with a public IP and a firewall rule for port 8787. Keep the
   token long; it is the only thing protecting the account.
3. Port forwarding on your home router (least recommended — exposes the machine).

## What it will and will not do

- Sends the stop loss with every order, so the broker holds the stop even if the
  bridge or the app dies mid-trade.
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
