#!/usr/bin/env python3
"""
Trade analysis engine for the daytrading agent.

Reads trades.json (or another JSON log) and computes:
- Overall stats: total trades, win rate, average P&L, R, expectancy, profit factor
- Breakdowns by instrument, setup, and session
- Trade quality notes and recurring mistakes
"""

from __future__ import annotations

import json
import statistics
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass
class Trade:
    data: dict[str, Any]
    profitable: bool
    r: float | None = None


@dataclass
class Summary:
    total_trades: int = 0
    wins: int = 0
    losses: int = 0
    breakeven: int = 0
    avg_pnl: float = 0.0
    avg_r: float = 0.0
    win_rate: float = 0.0
    expectancy_usd: float = 0.0
    expectancy_r: float = 0
    profit_factor: float = 0.0
    biggest_win_usd: float = 0.0
    biggest_loss_usd: float = 0.0
    avg_win_usd: float = 0.0
    avg_loss_usd: float = 0.0
    total_pnl_usd: float = 0.0


def _safe_float(value: Any, default: float = 0.0) -> float:
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return default
    return default


def load_trades(path: Path) -> list[Trade]:
    if not path.exists():
        print(f"No log found at {path}.")
        print(f"Copy example_trades.json to {path} and edit it, or run:")
        print("    python trade_logger.py add")
        sys.exit(1)

    with path.open("r", encoding="utf-8") as f:
        raw = json.load(f)

    if not isinstance(raw, list):
        print(f"Expected a JSON array in {path}.")
        sys.exit(1)

    trades: list[Trade] = []
    for row in raw:
        pnl = _safe_float(row.get("pnl_usd"))
        risk = _safe_float(row.get("risk_usd"))
        entry = _safe_float(row.get("entry_price"))
        stop = _safe_float(row.get("stop_price"))

        if risk > 0:
            r = pnl / risk if risk else None
        elif entry and stop and entry != stop:
            risk_distance = abs(entry - stop)
            r = pnl / risk_distance if risk_distance else None
        else:
            r = None

        profitable = pnl > 0
        trades.append(Trade(data=row, profitable=profitable, r=r))

    return trades


def compute_summary(trades: list[Trade]) -> Summary:
    if not trades:
        return Summary()

    pnls = [t.data.get("pnl_usd", 0.0) for t in trades]
    rs = [t.r for t in trades if t.r is not None]

    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]
    breakevens = [p for p in pnls if p == 0]

    total_pnl = sum(pnls)
    win_rate = len(wins) / len(trades) if trades else 0.0
    avg_win = statistics.mean(wins) if wins else 0.0
    avg_loss = statistics.mean(losses) if losses else 0.0
    avg_r = statistics.mean(rs) if rs else 0.0
    avg_pnl = statistics.mean(pnls) if pnls else 0.0
    biggest_win = max(wins) if wins else 0.0
    biggest_loss = min(losses) if losses else 0.0
    profit_factor = (sum(wins) / abs(sum(losses))) if losses else float("inf")

    win_rs = [r for r in rs if r > 0]
    loss_rs = [r for r in rs if r < 0]
    win_rate_r = len(win_rs) / len(rs) if rs else 0.0
    loss_rate_r = len(loss_rs) / len(rs) if rs else 0.0
    avg_win_r = statistics.mean(win_rs) if win_rs else 0.0
    avg_loss_r = statistics.mean(loss_rs) if loss_rs else 0.0
    expectancy_r = win_rate_r * avg_win_r - loss_rate_r * abs(avg_loss_r)

    return Summary(
        total_trades=len(trades),
        wins=len(wins),
        losses=len(losses),
        breakeven=len(breakevens),
        avg_pnl=avg_pnl,
        avg_r=avg_r,
        win_rate=win_rate,
        expectancy_usd=avg_pnl,
        expectancy_r=expectancy_r,
        profit_factor=profit_factor,
        biggest_win_usd=biggest_win,
        biggest_loss_usd=biggest_loss,
        avg_win_usd=avg_win,
        avg_loss_usd=avg_loss,
        total_pnl_usd=total_pnl,
    )


def _key(trade: Trade, field_name: str) -> str:
    value = trade.data.get(field_name, "")
    if not value:
        return "unknown"
    return str(value)


def breakdowns(trades: list[Trade]) -> dict[str, dict[str, Summary]]:
    by_instrument: dict[str, list[Trade]] = defaultdict(list)
    by_setup: dict[str, list[Trade]] = defaultdict(list)
    by_session: dict[str, list[Trade]] = defaultdict(list)

    for t in trades:
        by_instrument[_key(t, "instrument")].append(t)
        by_setup[_key(t, "setup")].append(t)
        by_session[_key(t, "session")].append(t)

    result: dict[str, dict[str, Summary]] = {}
    result["instrument"] = {k: compute_summary(v) for k, v in by_instrument.items()}
    result["setup"] = {k: compute_summary(v) for k, v in by_setup.items()}
    result["session"] = {k: compute_summary(v) for k, v in by_session.items()}
    return result


def recurring_mistakes(trades: list[Trade]) -> list[str]:
    notes: list[str] = []
    if not trades:
        return notes

    streak = 0
    for t in trades:
        pnl = _safe_float(t.data.get("pnl_usd"))
        if pnl < 0:
            streak += 1
            if streak >= 2:
                notes.append(f"Back-to-back losses around {t.data.get('date')} {t.data.get('time')}")
        else:
            streak = 0

    risk_by_setup: dict[str, list[float]] = defaultdict(list)
    for t in trades:
        risk = _safe_float(t.data.get("risk_usd"))
        risk_by_setup[_key(t, "setup")].append(risk)
    if risk_by_setup:
        largest_avg_setup = max(
            risk_by_setup.items(),
            key=lambda kv: (statistics.mean(kv[1]) if kv[1] else 0.0),
        )
        notes.append(f"Highest average risk per trade came from '{largest_avg_setup[0]}'")

    exits: dict[str, list[float]] = defaultdict(list)
    for t in trades:
        reason = _key(t, "exit_reason")
        pnl = _safe_float(t.data.get("pnl_usd"))
        exits[reason].append(pnl)
    if exits:
        worst_reason = min(
            exits.items(),
            key=lambda kv: (statistics.mean(kv[1]) if kv[1] else 0.0),
        )
        notes.append(f"Worst average result by exit reason: '{worst_reason[0]}'")

    stopped_trades = [
        t
        for t in trades
        if _key(t, "exit_reason") == "stop" and _safe_float(t.data.get("pnl_usd")) < 0
    ]
    if stopped_trades:
        notes.append(
            f"{len(stopped_trades)} stopped trades. Review whether stops were placed at real invalidation points."
        )

    session_pnl: dict[str, list[float]] = defaultdict(list)
    for t in trades:
        session_pnl[_key(t, "session")].append(_safe_float(t.data.get("pnl_usd")))
    if session_pnl:
        weakest_session = min(session_pnl.items(), key=lambda kv: sum(kv[1]) if kv[1] else 0.0)
        notes.append(
            f"Weakest session by total P&L: '{weakest_session[0]}'. Consider rules for when you sit out."
        )

    return notes


def print_summary(path: Path, summary: Summary) -> None:
    print("\n========================================")
    print("         TRADE REVIEW SUMMARY")
    print("========================================\n")
    print(f"Log file: {path}")
    print(f"Total trades: {summary.total_trades}")
    print(f"Wins / Losses / Breakeven: {summary.wins} / {summary.losses} / {summary.breakeven}")
    print(f"Win rate: {summary.win_rate:.1%}")
    print(f"Total P&L: ${summary.total_pnl_usd:,.2f}")
    print(f"Average P&L per trade: ${summary.avg_pnl:,.2f}")
    print(f"Biggest win: ${summary.biggest_win_usd:,.2f}")
    print(f"Biggest loss: ${summary.biggest_loss_usd:,.2f}")
    print(f"Average win: ${summary.avg_win_usd:,.2f}")
    print(f"Average loss: ${summary.avg_loss_usd:,.2f}")
    print(f"Average R per trade: {summary.avg_r:.2f}R")
    print(f"Expectancy per trade: {summary.expectancy_r:.2f}R (${summary.expectancy_usd:,.2f})")
    print(f"Profit factor: {summary.profit_factor:.2f}")
    print()


def print_breakdowns(by_key: str, items: dict[str, Summary]) -> None:
    print(f"--- By {by_key} ---")
    if not items:
        print("  (no data)")
        return
    for label, s in sorted(items.items()):
        print(f"  {label}")
        print(f"    trades: {s.total_trades}, win rate: {s.win_rate:.1%}, total P&L: ${s.total_pnl_usd:,.2f}")
    print()


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
