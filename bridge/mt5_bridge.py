"""
Zone Watch — MetaTrader 5 bridge.

Why this exists: MetaTrader 5 has no public REST API, and MetaQuotes' Python
package is Windows-only and talks to a terminal running on the same machine.
So the terminal has to live somewhere (your PC, or a cheap Windows VPS) and this
small service sits in front of it, letting the app on Fly place orders over
HTTPS.

Run it on the Windows machine that has MetaTrader 5 installed and logged into
the Exness account:

    pip install MetaTrader5
    set ZW_BRIDGE_TOKEN=choose-a-long-random-string
    set MT5_LOGIN=12345678
    set MT5_PASSWORD=your-password
    set MT5_SERVER=Exness-MT5Trial8
    python mt5_bridge.py

Then in Zone Watch -> Risk -> Auto-trading, set:
    Bridge URL:  http://your-machine:8787   (or your https tunnel URL)
    Bridge secret: the same ZW_BRIDGE_TOKEN

Safety properties, on purpose:
  - Refuses to run without a token; every request must carry it.
  - Refuses to trade a live account unless ALLOW_LIVE=1 is set explicitly.
  - Sends the stop loss with every order, so the position is protected by the
    broker even if this process or the app dies.
  - Never opens a second position on the same symbol.
  - Reports what the terminal actually says, not what we hoped it said.
"""

import json
import os
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

try:
    import MetaTrader5 as mt5
except ImportError:
    print("MetaTrader5 package missing. Run: pip install MetaTrader5")
    sys.exit(1)

TOKEN = os.environ.get("ZW_BRIDGE_TOKEN", "")
ALLOW_LIVE = os.environ.get("ALLOW_LIVE", "") == "1"
PORT = int(os.environ.get("ZW_BRIDGE_PORT", "8787"))
LOT_STEP = 0.01
MAX_LOTS = float(os.environ.get("ZW_MAX_LOTS", "5"))

if not TOKEN or len(TOKEN) < 16:
    print("Set ZW_BRIDGE_TOKEN to a random string of at least 16 characters.")
    sys.exit(1)

def connect():
    login = int(os.environ["MT5_LOGIN"]) if os.environ.get("MT5_LOGIN") else None
    password = os.environ.get("MT5_PASSWORD")
    server = os.environ.get("MT5_SERVER")
    kwargs = {}
    if login:
        kwargs.update(login=login, password=password, server=server)
    if not mt5.initialize(**kwargs):
        raise RuntimeError(f"MT5 initialize failed: {mt5.last_error()}")
    return mt5.account_info()

def account_payload(info):
    return {
        "login": info.login,
        "server": info.server,
        "currency": info.currency,
        "balance": round(info.balance, 2),
        "equity": round(info.equity, 2),
        "leverage": info.leverage,
        "demo": info.trade_mode == mt5.ACCOUNT_TRADE_MODE_DEMO,
    }

def filling_mode(symbol):
    """Ask the symbol which filling modes it accepts; guessing returns 10030."""
    info = mt5.symbol_info(symbol)
    if info is None:
        return None
    for mode in (mt5.ORDER_FILLING_FOK, mt5.ORDER_FILLING_IOC, mt5.ORDER_FILLING_RETURN):
        if info.filling_mode & mode:
            return mode
    return mt5.ORDER_FILLING_RETURN

def open_positions():
    positions = mt5.positions_get() or []
    return [
        {
            "ticket": p.ticket,
            "symbol": p.symbol,
            "side": "BUY" if p.type == mt5.POSITION_TYPE_BUY else "SELL",
            "lots": p.volume,
            "entry": p.price_open,
            "sl": p.sl,
            "tp": p.tp,
            "profit": p.profit,
        }
        for p in positions
    ]

def spreads_for(symbols):
    """Current spread per broker symbol, in price units and in points.

    This is the number the account is actually being charged right now, which is
    why the app prefers it to its own spread table: gold spread triples around a
    news release and the table would never know.
    """
    out = {}
    for raw in symbols[:50]:
        name = raw.strip()
        if not name:
            continue
        if not mt5.symbol_select(name, True):
            out[name] = {"error": "not available on this account"}
            continue
        info = mt5.symbol_info(name)
        if info is None:
            out[name] = {"error": "no symbol info"}
            continue
        out[name] = {
            "spread": round(info.spread * info.point, info.digits),
            "points": info.spread,
            "point": info.point,
            "digits": info.digits,
            "contractSize": getattr(info, "trade_contract_size", None),
        }
    return out


def place_order(body):
    symbol = str(body.get("symbol", "")).strip()
    side = str(body.get("side", "")).upper()
    lots = round(float(body.get("lots", 0)) / LOT_STEP) * LOT_STEP
    sl = float(body.get("sl") or 0)
    tp = float(body.get("tp") or 0)

    if not symbol:
        return 400, {"ok": False, "error": "missing symbol"}
    if side not in ("BUY", "SELL"):
        return 400, {"ok": False, "error": "side must be BUY or SELL"}
    if lots <= 0:
        return 400, {"ok": False, "error": "lots must be positive"}
    if lots > MAX_LOTS:
        return 400, {"ok": False, "error": f"lots above the {MAX_LOTS} bridge limit"}
    if sl <= 0:
        # Refusing a naked position is deliberate: the broker must hold the stop.
        return 400, {"ok": False, "error": "refusing to open a position without a stop loss"}

    if not mt5.symbol_select(symbol, True):
        return 400, {"ok": False, "error": f"symbol {symbol} not available on this account"}

    for p in open_positions():
        if p["symbol"] == symbol:
            return 409, {"ok": False, "error": f"already holding {symbol} (ticket {p['ticket']})"}

    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return 502, {"ok": False, "error": "no tick for this symbol"}
    price = tick.ask if side == "BUY" else tick.bid

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": lots,
        "type": mt5.ORDER_TYPE_BUY if side == "BUY" else mt5.ORDER_TYPE_SELL,
        "price": price,
        "sl": sl,
        "tp": tp,
        "deviation": 20,
        "magic": 20261115,
        "comment": "zone-watch",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": filling_mode(symbol),
    }

    result = mt5.order_send(request)
    if result is None:
        return 502, {"ok": False, "error": f"order_send returned None: {mt5.last_error()}"}
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return 400, {
            "ok": False,
            "error": f"retcode {result.retcode}: {result.comment}",
            "retcode": result.retcode,
        }
    return 200, {
        "ok": True,
        "ticket": result.order,
        "price": result.price,
        "lots": result.volume,
        "symbol": symbol,
    }

def modify_position(body):
    """Move the stop (and target) on a position the terminal already holds.

    The app's stop ladder tightens a stop as a trade runs; on a real account
    that only means something if the broker's own stop is the one that moves.
    TRADE_ACTION_SLTP is the MT5 request for exactly this: it does not touch the
    open price or volume, only the protective orders.

    A position is found by ticket when the app has one, otherwise by symbol.
    The symbol fallback matters because MT5 returns an *order* ticket from
    order_send and a *position* ticket from positions_get, and they differ.
    """
    symbol = str(body.get("symbol", "")).strip()
    ticket = body.get("ticket")
    sl = float(body.get("sl") or 0)
    tp = float(body.get("tp") or 0)

    if sl <= 0:
        # Same rule as entry: no unprotected position, ever.
        return 400, {"ok": False, "error": "refusing to amend a position without a stop loss"}

    position = None
    if ticket:
        found = mt5.positions_get(ticket=int(ticket)) or []
        if found:
            position = found[0]
    if position is None:
        if not symbol:
            return 400, {"ok": False, "error": "missing symbol or ticket"}
        for p in open_positions():
            if p["symbol"] == symbol:
                found = mt5.positions_get(ticket=p["ticket"]) or []
                if found:
                    position = found[0]
                break
    if position is None:
        return 404, {"ok": False, "error": f"no open position for {symbol or ticket}"}

    # Only ever tighten: a stop that a request could move backwards is a way to
    # lose money by accident, so out-of-order messages are ignored.
    if position.sl > 0:
        tighter = sl > position.sl if position.type == mt5.POSITION_TYPE_BUY else sl < position.sl
        if not tighter:
            return 200, {
                "ok": True,
                "ticket": position.ticket,
                "sl": position.sl,
                "unchanged": True,
                "note": "existing stop is already at least as protective",
            }

    request = {
        "action": mt5.TRADE_ACTION_SLTP,
        "position": position.ticket,
        "symbol": position.symbol,
        "sl": sl,
        "tp": tp if tp > 0 else position.tp,
        "magic": 20261115,
        "comment": "zone-watch trail",
    }
    result = mt5.order_send(request)
    if result is None:
        return 502, {"ok": False, "error": f"order_send returned None: {mt5.last_error()}"}
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return 400, {
            "ok": False,
            "error": f"retcode {result.retcode}: {result.comment}",
            "retcode": result.retcode,
        }

    # Report what the terminal now holds, not what was asked for.
    after = mt5.positions_get(ticket=position.ticket) or []
    held = after[0].sl if after else sl
    if held and abs(float(held) - sl) > abs(sl) * 1e-7:
        return 502, {"ok": False, "error": f"terminal still shows the stop at {held}"}
    return 200, {"ok": True, "ticket": position.ticket, "sl": held or sl, "symbol": position.symbol}


class Handler(BaseHTTPRequestHandler):
    server_version = "ZoneWatchBridge/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _auth(self):
        if self.headers.get("x-bridge-token") != TOKEN:
            self._json(401, {"ok": False, "error": "bad or missing token"})
            return False
        return True

    def _json(self, code, payload):
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if not self._auth():
            return
        if self.path.startswith("/health"):
            info = mt5.account_info()
            if info is None:
                self._json(503, {"ok": False, "error": "terminal not logged in"})
                return
            payload = account_payload(info)
            if not payload["demo"] and not ALLOW_LIVE:
                self._json(403, {"ok": False, "error": "live account and ALLOW_LIVE is not set", **payload})
                return
            self._json(200, {"ok": True, **payload, "positions": open_positions()})
            return
        if self.path.startswith("/positions"):
            self._json(200, {"ok": True, "positions": open_positions()})
            return
        if self.path.startswith("/spreads"):
            params = parse_qs(urlparse(self.path).query)
            names = [n for n in (params.get("symbols", [""])[0]).split(",") if n.strip()]
            if not names:
                self._json(400, {"ok": False, "error": "symbols query parameter required"})
                return
            self._json(
                200,
                {
                    "ok": True,
                    "at": datetime.now(timezone.utc).isoformat(),
                    "spreads": spreads_for(names),
                },
            )
            return
        self._json(404, {"ok": False, "error": "unknown path"})

    def do_POST(self):
        if not self._auth():
            return
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._json(400, {"ok": False, "error": "invalid JSON"})
            return

        info = mt5.account_info()
        if info is None:
            self._json(503, {"ok": False, "error": "terminal not logged in"})
            return
        if info.trade_mode != mt5.ACCOUNT_TRADE_MODE_DEMO and not ALLOW_LIVE:
            self._json(403, {"ok": False, "error": "live account and ALLOW_LIVE is not set"})
            return

        if self.path.startswith("/order"):
            code, payload = place_order(body)
            self._json(code, payload)
            return
        if self.path.startswith("/modify"):
            code, payload = modify_position(body)
            self._json(code, payload)
            return
        if self.path.startswith("/close"):
            tickets = [p["ticket"] for p in open_positions()]
            closed = []
            for ticket in tickets:
                pos = mt5.positions_get(ticket=ticket)
                if not pos:
                    continue
                p = pos[0]
                tick = mt5.symbol_info_tick(p.symbol)
                closing_buy = p.type == mt5.POSITION_TYPE_SELL
                req = {
                    "action": mt5.TRADE_ACTION_DEAL,
                    "position": p.ticket,
                    "symbol": p.symbol,
                    "volume": p.volume,
                    "type": mt5.ORDER_TYPE_BUY if closing_buy else mt5.ORDER_TYPE_SELL,
                    "price": tick.ask if closing_buy else tick.bid,
                    "deviation": 20,
                    "magic": 20261115,
                    "comment": "zone-watch close",
                    "type_time": mt5.ORDER_TIME_GTC,
                    "type_filling": filling_mode(p.symbol),
                }
                r = mt5.order_send(req)
                closed.append({"ticket": p.ticket, "ok": bool(r and r.retcode == mt5.TRADE_RETCODE_DONE)})
            self._json(200, {"ok": True, "closed": closed})
            return
        self._json(404, {"ok": False, "error": "unknown path"})

if __name__ == "__main__":
    info = connect()
    acct = account_payload(info)
    print(f"Connected: {acct['login']} on {acct['server']} ({'DEMO' if acct['demo'] else 'LIVE'})")
    if not acct["demo"] and not ALLOW_LIVE:
        print("Refusing to start: live account. Set ALLOW_LIVE=1 only when you mean it.")
        sys.exit(1)
    print(f"Listening on 0.0.0.0:{PORT}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
