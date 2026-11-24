/**
 * Tracks signals from the moment they are posted until they hit their target,
 * hit their stop, or expire.
 *
 * Resolution walks the candles a signal lived through, in order, and takes the
 * first level that was touched. Checking only the live price is not the same
 * thing: a trade that hit its stop on Tuesday and is beyond its target by
 * Thursday would be scored as a win, which is how a tracker reports a 100% win
 * rate it did not earn. When no candle history is available (a market with no
 * bars, or a gap in the feed) it falls back to the live price, and says so.
 *
 * A bar that touches both levels is scored as a loss: intrabar order is
 * unknown, and assuming the exit you wanted is how backtests lie to you.
 *
 * State is persisted to signals.json so a restart does not lose open trades.
 */

const fs = require("fs");
const path = require("path");
const { writeJson } = require("./atomicWrite");

const stopsMod = require("./stops");

const FILE = require("./stateDir").file("signals.json");
const MAX_HISTORY = 200;
const EXPIRY_MS = 24 * 60 * 60 * 1000; // a day without resolution = expired

/**
 * Expired rows written before expiries were pinned to 0R still carry the
 * floating R they happened to be worth when the clock ran out. Normalising on
 * read keeps those old rows from skewing totals R and expectancy.
 */
function stripExpiredR(h) {
  if (!h || h.outcome !== "expired" || !h.rMultiple) return h;
  return { ...h, rMultiple: 0 };
}

function load() {
  try {
    const raw = fs.readFileSync(FILE, "utf-8").trim();
    if (!raw) return { open: [], history: [] };
    const parsed = JSON.parse(raw);
    return {
      open: Array.isArray(parsed.open) ? parsed.open : [],
      history: Array.isArray(parsed.history) ? parsed.history.map(stripExpiredR) : [],
    };
  } catch {
    return { open: [], history: [] };
  }
}

function save(state) {
  const trimmed = {
    open: state.open,
    history: state.history.slice(-MAX_HISTORY),
  };
  try {
    writeJson(FILE, trimmed, 2);
  } catch {}
}

function makeId(signal) {
  return [signal.symbol, signal.side, signal.zone.low, signal.zone.high, signal.at].join("|");
}

/** Add a freshly posted signal to the open list. */
function add(signal) {
  const state = load();
  const id = makeId(signal);

  if (state.open.some((s) => s.id === id)) return state.open;
  if (state.history.some((s) => s.id === id)) return state.open;

  // One live signal per market and direction. Auto zones drift by a fraction
  // of a pip between cycles, so without this the same setup is posted again and
  // again and each copy is scored separately.
  if (state.open.some((s) => s.symbol === signal.symbol && s.side === signal.side)) {
    return state.open;
  }

  // Do not track something that is already past its target or stop.
  if (signal.side === "BUY") {
    if (signal.price <= signal.stop || signal.price >= signal.target) return state.open;
  } else {
    if (signal.price >= signal.stop || signal.price <= signal.target) return state.open;
  }

  state.open.push({
    id,
    symbol: signal.symbol,
    side: signal.side,
    confidence: signal.confidence,
    entry: signal.entry,
    stop: signal.stop,
    target: signal.target,
    riskReward: signal.riskReward,
    zone: signal.zone,
    // Kept so the win/loss message can say what it was worth, not just R.
    sizing: signal.sizing || null,
    openedAt: signal.at || new Date().toISOString(),
  });

  save(state);
  return state.open;
}

/**
 * Did this signal's path touch its stop or its target first?
 *
 * Bars are walked oldest-first and only those at or after the signal's open are
 * used. Returns null when there is no history to judge from.
 */
function roundR(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(4)) : null;
}

function pathOutcome(s, bars, openedAtMs) {
  if (!Array.isArray(bars) || !bars.length) return null;

  // The stop ladder the live book runs (stops.js): break-even at 1R, then 0.5R
  // behind the best price. The tracker has to score the exit the bot would have
  // taken, otherwise its win rate describes a trade nobody placed.
  const entry = Number(s.entry ?? s.price);
  const openedWith = Number(s.stop);
  const risk = Math.abs(entry - openedWith);
  const canTrail = Number.isFinite(entry) && risk > 0;
  const targetR = canTrail && Number.isFinite(Number(s.target)) ? Math.abs(Number(s.target) - entry) / risk : null;
  let stop = openedWith;
  let peakR = 0;
  // Worst excursion since entry, in R. Negative means it went against the
  // trade; zero means the entry was never breached. Stored so an exit can be
  // judged on the whole path, not only on where it happened to end.
  let troughR = 0;
  let first1RAt = null;
  let trailed = false;

  for (const bar of bars) {
    const at = Number(bar.t) < 1e12 ? Number(bar.t) * 1000 : Number(bar.t);
    if (!Number.isFinite(at) || at + 60 * 1000 < openedAtMs) continue;
    const high = Number(bar.h);
    const low = Number(bar.l);
    if (!Number.isFinite(high) || !Number.isFinite(low)) continue;

    const hitStop = s.side === "BUY" ? low <= stop : high >= stop;
    const hitTarget = s.side === "BUY" ? high >= s.target : low <= s.target;

    // Both inside one bar: the order inside the bar is unknown, so take the
    // pessimistic reading. Anything else flatters the strategy.
    if (hitStop) {
      // Labelled by what the exit actually did. A stop trailed past entry has
      // not lost, and one filled exactly at entry has neither won nor lost —
      // counting that as a win inflates the win rate the dashboard reports.
      const better = s.side === "BUY" ? stop > entry : stop < entry;
      const outcome = !canTrail ? "loss" : stop === entry ? "breakeven" : better ? "win" : "loss";
      const stopR = canTrail ? (s.side === "BUY" ? stop - entry : entry - stop) / risk : -1;
      return {
        outcome,
        exit: stop,
        barAt: at,
        trailed,
        mfeR: roundR(peakR),
        maeR: roundR(Math.min(troughR, stopR, 0)),
        targetHit: false,
        first1RAt,
      };
    }
    if (hitTarget) {
      return {
        outcome: "win",
        exit: s.target,
        barAt: at,
        trailed,
        mfeR: roundR(Math.max(peakR, targetR || 0)),
        maeR: roundR(Math.min(troughR, 0)),
        targetHit: true,
        // A bar that reaches the target crossed +1R too, even if the high was
        // only sampled once in that bar. The delay is the same bar's close.
        first1RAt: first1RAt == null ? at : first1RAt,
      };
    }

    if (canTrail) {
      const favourable = s.side === "BUY" ? (high - entry) / risk : (entry - low) / risk;
      const adverse = s.side === "BUY" ? (low - entry) / risk : (entry - high) / risk;
      peakR = Math.max(peakR, favourable);
      troughR = Math.min(troughR, adverse);
      if (first1RAt == null && peakR >= 1) first1RAt = at;
      const next = stopsMod.protect({ side: s.side, entry, stop, peakR, initialStop: openedWith });
      if (next !== stop) trailed = true;
      stop = next;
    }
  }
  // No exit inside the bars seen, but the excursion is still evidence: an
  // expiry or a still-open trade has a best and worst point too.
  return {
    outcome: null,
    mfeR: roundR(peakR),
    maeR: roundR(Math.min(troughR, 0)),
    targetHit: false,
    trailed,
    first1RAt,
  };
}

/**
 * The same signal with its stop left where it opened — the counterfactual that
 * says what the trail was worth. The target and the initial stop are the same
 * levels, so the pair differs in exactly one rule.
 */
function fixedPath(s, bars, openedAtMs) {
  if (!Array.isArray(bars) || !bars.length) return null;
  const entry = Number(s.entry ?? s.price);
  const initialStop = Number(s.stop);
  const risk = Math.abs(entry - initialStop);
  if (!(risk > 0) || !Number.isFinite(Number(s.target))) return null;
  const targetR = Math.abs(Number(s.target) - entry) / risk;

  for (const bar of bars) {
    const at = Number(bar.t) < 1e12 ? Number(bar.t) * 1000 : Number(bar.t);
    if (!Number.isFinite(at) || at + 60 * 1000 < openedAtMs) continue;
    const high = Number(bar.h);
    const low = Number(bar.l);
    if (!Number.isFinite(high) || !Number.isFinite(low)) continue;

    const hitStop = s.side === "BUY" ? low <= initialStop : high >= initialStop;
    const hitTarget = s.side === "BUY" ? high >= s.target : low <= s.target;
    // A bar that touches both is a loss here too, for the same reason.
    if (hitStop) return { outcome: "loss", exit: initialStop, barAt: at, r: -1 };
    if (hitTarget) return { outcome: "win", exit: s.target, barAt: at, r: roundR(targetR) };
  }
  return null;
}

/**
 * Check open signals against current prices and the bars they lived through.
 * @param {Map|object} priceBySymbol
 * @param {number} now
 * @param {{barsFor?: (symbol: string) => Array}} [options]
 * @returns {{resolved: Array, open: Array}}
 */
function update(priceBySymbol, now = Date.now(), options = {}) {
  const barsFor = typeof options.barsFor === "function" ? options.barsFor : null;
  const state = load();
  const stillOpen = [];
  const resolved = [];

  for (const s of state.open) {
    const price = priceBySymbol instanceof Map ? priceBySymbol.get(s.symbol) : priceBySymbol[s.symbol];

    if (!Number.isFinite(price)) {
      stillOpen.push(s);
      continue;
    }

    let outcome = null;
    let exit = null;
    let barAt = null;

    const openedAtMs = new Date(s.openedAt).getTime();
    const bars = barsFor ? barsFor(s.symbol) : null;
    const path = bars ? pathOutcome(s, bars, openedAtMs) : null;
    // The same trade with the stop left at its opening level. Only used for the
    // audit; it can never change how this signal is scored.
    const fixed = path ? fixedPath(s, bars, openedAtMs) : null;

    if (path && path.outcome) {
      outcome = path.outcome;
      exit = path.exit;
      barAt = path.barAt;
    } else if (s.side === "BUY") {
      if (price <= s.stop) {
        outcome = "loss";
        exit = s.stop;
      } else if (price >= s.target) {
        outcome = "win";
        exit = s.target;
      }
    } else {
      if (price >= s.stop) {
        outcome = "loss";
        exit = s.stop;
      } else if (price <= s.target) {
        outcome = "win";
        exit = s.target;
      }
    }

    const age = now - openedAtMs;
    if (!outcome && age > EXPIRY_MS) {
      outcome = "expired";
      exit = price;
    }

    if (outcome) {
      // The R is what the exit actually paid, not what a full target would have
      // paid. With a stop ladder running, a winner that closed at +0.6R must not
      // be booked as the full 2R — that inflates expectancy the same way a
      // break-even counted as a win inflates the win rate.
      const entry = Number(s.entry ?? s.price);
      const risk = Math.abs(entry - Number(s.stop));
      const actualR =
        risk > 0 && Number.isFinite(exit)
          ? (s.side === "BUY" ? Number(exit) - entry : entry - Number(exit)) / risk
          : null;
      // An expiry is not a trade result: nothing was closed for a reason, and
      // the floating R at the moment the clock ran out is not something the
      // signal earned. Booking it would move totals R and expectancy every time
      // a slow signal timed out. Expired stays 0R; exit is kept so the message
      // can still say where price was.
      const rMultiple =
        outcome === "expired"
          ? 0
          : actualR != null
            ? Number(actualR.toFixed(2))
            : outcome === "win"
              ? Number(s.riskReward ?? 0.6)
              : outcome === "loss"
                ? -1
                : 0;
      // Excursion at the closing price, for the price-based fallback where no
      // candle path was available. It is a one-point measurement, not a path.
      const runningR =
        risk > 0 && Number.isFinite(Number(price))
          ? (s.side === "BUY" ? Number(price) - entry : entry - Number(price)) / risk
          : null;
      resolved.push({
        ...s,
        outcome,
        // Two decimals erased a EURUSD stop (1.095 became 1.1); ten
        // significant digits keep every market's own precision.
        exit: Number(Number(exit).toPrecision(10)),
        priceAtClose: Number(Number(price).toPrecision(10)),
        rMultiple,
        // The path, not just the ending: best and worst excursion in R, whether
        // the target itself was touched, whether the stop ladder moved, and how
        // long it took to get 1R. Exits can only be judged from these.
        mfeR: path ? path.mfeR : roundR(runningR == null ? null : Math.max(0, runningR)),
        maeR: path ? path.maeR : roundR(runningR == null ? null : Math.min(0, runningR)),
        targetHit: path ? path.targetHit === true : outcome === "win",
        trailMoved: Boolean(path && path.trailed),
        minutesTo1R:
          path && path.first1RAt ? Math.max(0, Math.round((path.first1RAt - openedAtMs) / 60000)) : null,
        // Same signal, stop never moved. Null when that path never resolved in
        // the bars seen, in which case there is no honest pair to compare.
        noTrailOutcome: fixed ? fixed.outcome : null,
        noTrailR: fixed && Number.isFinite(fixed.r) ? fixed.r : null,
        resolution: path ? "candles" : "price",
        touchedAt: barAt ? new Date(barAt).toISOString() : null,
        closedAt: new Date(now).toISOString(),
        heldMinutes: Math.round((barAt ? barAt - openedAtMs : age) / 60000),
      });
    } else {
      stillOpen.push(s);
    }
  }

  if (resolved.length) {
    state.history.push(...resolved);
    state.open = stillOpen;
    save(state);
  }

  return { resolved, open: stillOpen };
}

/**
 * The exit audit: what the closed signals did on the way to their exit.
 *
 * It answers two questions the win rate cannot: how often a trade got to +1R
 * before it ended, and what the stop trail was worth compared with leaving the
 * stop where it opened. The trail comparison is paired — same signal, same
 * bars, only the stop rule differs — and only rows where both paths resolved
 * are counted, so a one-sided sample cannot flatter it.
 *
 * Rows written before this audit existed have no excursion fields. They are
 * counted as excluded, never as zeroes, because "never reached 1R" and "never
 * measured" are different facts.
 */
function exitAudit(state = load()) {
  const history = Array.isArray(state.history) ? state.history : [];
  const closed = history.filter(
    (h) => h.outcome === "win" || h.outcome === "loss" || h.outcome === "breakeven" || h.outcome === "expired"
  );
  // `Number(null)` is 0, so an old row with no excursion would otherwise be
  // measured as a trade that never ran — exactly the fact this audit must not
  // invent. Only an actual number counts.
  const hasNumber = (value) => value != null && Number.isFinite(Number(value));
  const measured = closed.filter((h) => hasNumber(h.mfeR));
  const reached1 = measured.filter((h) => Number(h.mfeR) >= 1);
  const targetHit = measured.filter((h) => h.targetHit === true);

  const after1R = { target: 0, trailedWin: 0, breakeven: 0, stopped: 0, expired: 0 };
  for (const h of reached1) {
    if (h.targetHit) after1R.target += 1;
    else if (h.outcome === "win") after1R.trailedWin += 1;
    else if (h.outcome === "breakeven") after1R.breakeven += 1;
    else if (h.outcome === "expired") after1R.expired += 1;
    else after1R.stopped += 1;
  }

  const avg = (values) =>
    values.length ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)) : null;
  const pct = (n) => (measured.length ? Number(((n / measured.length) * 100).toFixed(1)) : null);

  // Only rows with both outcomes are a pair. A trail that kept a trade open
  // past the bars we have has no fixed-stop answer, so it cannot vote.
  const trailRows = measured.filter((h) => h.trailMoved === true);
  const paired = measured.filter((h) => hasNumber(h.noTrailR) && hasNumber(h.rMultiple));
  const deltas = paired.map((h) => Number(h.rMultiple) - Number(h.noTrailR));
  const helped = deltas.filter((d) => d > 0.005).length;
  const hurt = deltas.filter((d) => d < -0.005).length;
  const actualR = Number(paired.reduce((a, h) => a + Number(h.rMultiple), 0).toFixed(2));
  const noTrailR = Number(paired.reduce((a, h) => a + Number(h.noTrailR), 0).toFixed(2));

  return {
    closed: closed.length,
    measured: measured.length,
    excluded: closed.length - measured.length,
    reached1R: { n: reached1.length, pct: pct(reached1.length) },
    after1R,
    target: { n: targetHit.length, pct: pct(targetHit.length) },
    neverReached1R: measured.length - reached1.length,
    avgMfeR: avg(measured.map((h) => Number(h.mfeR))),
    avgMaeR: avg(measured.map((h) => Number(h.maeR))),
    avgTimeToExitMinutes: avg(
      measured.map((h) => Number(h.heldMinutes)).filter((n) => Number.isFinite(n))
    ),
    trail: {
      engaged: trailRows.length,
      pairs: paired.length,
      helped,
      hurt,
      same: paired.length - helped - hurt,
      actualR,
      noTrailR,
      deltaR: Number((actualR - noTrailR).toFixed(2)),
    },
  };
}

function stats() {
  const state = load();
  const closed = state.history.filter((h) => h.outcome === "win" || h.outcome === "loss");
  const wins = closed.filter((h) => h.outcome === "win").length;
  const losses = closed.filter((h) => h.outcome === "loss").length;
  const totalR = state.history.reduce((a, h) => a + (h.rMultiple || 0), 0);

  return {
    open: state.open.length,
    wins,
    losses,
    expired: state.history.filter((h) => h.outcome === "expired").length,
    winrate: closed.length ? Number(((wins / closed.length) * 100).toFixed(1)) : null,
    totalR: Number(totalR.toFixed(2)),
    recent: state.history.slice(-10).reverse(),
    openTrades: state.open,
  };
}

module.exports = { add, update, stats, load, exitAudit };
