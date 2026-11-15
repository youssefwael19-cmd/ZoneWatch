#!/usr/bin/env python3
"""
Simple trade logger CLI.

Usage:
    python trade_logger.py add

It appends one trade to trades.json by prompting for the fields in a
consistent format you can copy into your journal or spreadsheet later.
"""

import json
import os
import sys
from datetime import datetime
from pathlib import Path

LOG_PATH = Path("trades.json")


def load_log(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, list):
        return data
    return []


def save_log(path: Path, trades: list[dict]) -> None:
    path.write_text(json.dumps(trades, indent=2, ensure_ascii=False), encoding="utf-8")


def prompt_field(label: str, default: str = "") -> str:
    value = input(f"{label} [{default}]: ").strip()
    return value or default


def add_trade() -> None:
    print("Add a trade to the log:\n")
    now = datetime.now()
    defaults = {
        "date": now.strftime("%Y-%m-%d"),
        "time": now.strftime("%H:%M"),
        "session": "NY",
        "instrument": "XAUUSD",
        "setup": "supply_demand",
        "direction": "long",
        "entry_price": "",
        "stop_price": "",
        "exit_price": "",
        "size": "",
        "risk_usd": "",
        "pnl_usd": "",
        "notes": "",
        "exit_reason": "manual",
    }

    trade = {
        "id": f"{now.strftime('%Y-%m-%d')}-{len(load_log(LOG_PATH)) + 1:03d}",
    }

    for key, default in defaults.items():
        value = prompt_field(key, default)
        trade[key] = value

    # Convert obvious numeric fields where possible
    for num_key in ("entry_price", "stop_price", "exit_price", "size", "risk_usd", "pnl_usd"):
        if trade.get(num_key) not in ("", None):
            try:
                trade[num_key] = float(trade[num_key])
            except ValueError:
                pass

    trades = load_log(LOG_PATH)
    trades.append(trade)
    save_log(LOG_PATH, trades)
    print("\nSaved.")
    print(LOG_PATH)


def show_help() -> None:
    print(sys.modules[__name__].__doc__)


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] == "--help" or sys.argv[1] == "-h":
        show_help()
        return

    command = sys.argv[1]
    if command == "add":
        add_trade()
    else:
        print(f"Unknown command: {command}")
        print("Commands: add")
        print("Run with --help for usage.")


if __name__ == "__main__":
    main()
