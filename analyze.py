#!/usr/bin/env python3
"""
Run trade analysis.

Usage:
    python analyze.py              # reads trades.json
    python analyze.py my_log.json  # reads a custom log file
"""

import sys
from pathlib import Path

from analyzer import (
    load_trades,
    compute_summary,
    breakdowns,
    recurring_mistakes,
    print_summary,
    print_breakdowns,
)


def main() -> None:
    log_path = Path("trades.json")
    if len(sys.argv) > 1 and sys.argv[1]:
        log_path = Path(sys.argv[1])

    trades = load_trades(log_path)
    summary = compute_summary(trades)
    bd = breakdowns(trades)
    mistakes = recurring_mistakes(trades)

    print_summary(log_path, summary)

    print_breakdowns("instrument", bd["instrument"])
    print_breakdowns("setup", bd["setup"])
    print_breakdowns("session", bd["session"])

    print("--- Recurring notes / mistakes ---")
    if mistakes:
        for note in mistakes:
            print(f"  - {note}")
    else:
        print("  (no clear recurring patterns yet)")
    print()


if __name__ == "__main__":
    main()
