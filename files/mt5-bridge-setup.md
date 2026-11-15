# Connecting Zone Watch to your Exness demo account

Do this in order. Each step says what you should see — if you don't see it, stop there
rather than carrying on.

---

## 1. MetaTrader 5, logged into the **demo**

Open MT5. Top-right corner shows your account number and server.
It must be a **demo** account. Exness demo servers are named like `Exness-MT5Trial8`.

**You should see:** a green connection status bar at the bottom right and a moving price.

> If it says "Invalid account" or the prices don't move, nothing below will work.

---

## 2. Let MT5 accept algorithmic orders

In MT5: **Tools → Options → Expert Advisors** → tick **Allow algorithmic trading**.

Then check the toolbar has the **Algo Trading** button enabled (it looks like a robot
head; it should not be red).

**You should see:** the Algo Trading button not greyed out.

---

## 3. Install Python

Download Python 3.11 or newer from **python.org** and install it.
On the first installer screen, tick **Add python.exe to PATH** — this matters.

**You should see:** opening Command Prompt and typing `python --version` prints
something like `Python 3.13.2`.

---

## 4. Install the MT5 connector

In Command Prompt:

```
pip install MetaTrader5
```

**You should see:** `Successfully installed MetaTrader5-...`

---

## 5. Get the bridge onto that machine

Copy the `bridge` folder from the project onto the Windows machine, so you have
`mt5_bridge.py` somewhere like `C:\zone-watch\mt5_bridge.py`.

---

## 6. Pick a secret and start the bridge

In Command Prompt, in that folder:

```
set ZW_BRIDGE_TOKEN=make-up-a-long-random-string-here
set MT5_LOGIN=your-demo-account-number
set MT5_PASSWORD=your-demo-password
set MT5_SERVER=Exness-MT5Trial8
python mt5_bridge.py
```

Use the exact server name MT5 shows in its title bar.

**You should see:**

```
Connected: 12345678 on Exness-MT5Trial8 (DEMO)
Listening on 0.0.0.0:8787
```

If it says **LIVE**, it will exit on purpose. That is the safety working, not a bug.

Leave this window open. Closing it stops the bridge.

---

## 7. Make the bridge reachable from the app

The app runs on the internet; your PC is behind your router, so it cannot see `192.168...`.

Easiest: install **cloudflared** and run, in a second Command Prompt window:

```
cloudflared tunnel --url http://localhost:8787
```

**You should see:** a line with a URL like
`https://something-random.trycloudflare.com`.

That URL changes every time you restart the tunnel. Fine for setup; for daily use, a
named tunnel keeps one address.

---

## 8. Tell the app about it

In Zone Watch → **Risk** → *Auto-trading*:

- **Bridge URL**: the `https://…trycloudflare.com` URL (no trailing slash)
- **Bridge secret**: the same string you put in `ZW_BRIDGE_TOKEN`
- Leave the mode on **Paper** for now
- Press **Save**, then **Test bridge**

**You should see:** `bridge alive · 12345678 on Exness-MT5Trial8 · demo · balance 10000.00 USD`

Only when that appears should you change the mode to **Bridge (MetaTrader 5)**.

---

## 9. The first real order

Turn **Auto-trading** on and leave risk at 0.5%.

Leave **Max open positions** at 2 and the **daily loss limit** at 2%.

Nothing will happen until a signal fires on a market the brain gate has approved —
currently GBPUSD and USDCHF. The first order should appear in MT5's *Trade* tab and in
the panel's *Open positions*, with the stop loss already attached.

---

## If something goes wrong

| What you see | What it means |
|---|---|
| `bridge returned 401` | The secret in the panel doesn't match `ZW_BRIDGE_TOKEN` |
| `bridge returned 403` | Live account, and `ALLOW_LIVE` isn't set — correct behaviour |
| `bridge unreachable` | Tunnel is down, or the PC went to sleep |
| `already holding XAUUSDm` | The bridge refused a second position on that symbol |
| `refusing to open a position without a stop loss` | The signal arrived without a stop — treat as a bug, tell me |
| `symbol XAUUSDm not available` | The suffix is wrong; check the symbol name inside MT5's Market Watch |

## Two things to keep in mind

- **A demo account is kind.** Fills are instant, slippage is minimal. Real results will
  be worse, especially on gold around news.
- **Keep the PC awake.** If it sleeps, MT5 holds your stop, but nothing manages the
  trade until it wakes.
