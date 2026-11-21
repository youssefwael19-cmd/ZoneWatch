/**
 * The exploration budget.
 *
 * The proven-rule gate is strict on purpose, but strict and silent are not the
 * same thing: a market with no champion never trades, so it never produces the
 * evidence that could make it a champion. The app sat at three signals, all
 * held, for two days — the rigor had become the reason there was nothing to
 * measure.
 *
 * So a small, explicit budget: a few tiny trades a day, at a fraction of the
 * normal risk, tagged as exploration wherever they are recorded. They are not
 * proof and are never counted as proof. They exist so the market produces
 * outcomes at all, and those outcomes are what the live-evidence path reads.
 *
 * The budget is per market and condition per day, plus a daily ceiling, so a
 * wedged feed or a re-evaluated signal cannot churn the account.
 */

const fs = require("fs");
const { writeJson } = require("./atomicWrite");

const FILE = require("./stateDir").file("exploration.json");

const DEFAULTS = {
  enabled: true,
  perDay: 3,
  perSymbolPerDay: 1,
  sizeMultiplier: 0.25,
};

function dayKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function read() {
  try {
    const raw = fs.readFileSync(FILE, "utf-8").trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

function write(entries) {
  try {
    writeJson(FILE, { day: dayKey(), entries: entries.slice(-120) }, 2);
  } catch {
    // A failed budget write must not block a trade the gate already approved.
  }
}

function config(patch = {}) {
  const n = (value, fallback, min, max) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  };
  return {
    enabled: patch.enabled === undefined ? DEFAULTS.enabled : Boolean(patch.enabled),
    perDay: Math.round(n(patch.perDay, DEFAULTS.perDay, 0, 12)),
    perSymbolPerDay: Math.round(n(patch.perSymbolPerDay, DEFAULTS.perSymbolPerDay, 0, 4)),
    sizeMultiplier: n(patch.sizeMultiplier, DEFAULTS.sizeMultiplier, 0.05, 0.5),
  };
}

/**
 * What is left of today's budget.
 * Pure given the entries, so the arithmetic can be tested without a clock.
 */
function remainingFor(entries, now, cfg) {
  const day = dayKey(now);
  const today = (entries || []).filter((e) => String(e.at || "").slice(0, 10) === day);
  return {
    day,
    used: today.length,
    limit: cfg.perDay,
    remaining: Math.max(0, cfg.perDay - today.length),
    today,
  };
}

function budget({ now = Date.now(), config: patch = {} } = {}) {
  const cfg = config(patch);
  const state = remainingFor(read(), now, cfg);
  return { ...cfg, ...state };
}

/** May this symbol take an exploration trade right now? */
function hasBudget({ symbol, now = Date.now(), config: patch = {} } = {}) {
  const cfg = config(patch);
  if (!cfg.enabled || cfg.perDay <= 0) return false;
  const state = remainingFor(read(), now, cfg);
  if (state.remaining <= 0) return false;
  const onSymbol = state.today.filter((e) => e.symbol === symbol).length;
  return onSymbol < cfg.perSymbolPerDay;
}

/**
 * Spend one exploration trade. Called only when the signal is approved, so a
 * signal that is evaluated again next cycle cannot spend the budget twice.
 */
function take({ symbol, condition = null, now = Date.now(), config: patch = {} } = {}) {
  if (!hasBudget({ symbol, now, config: patch })) return { ok: false };
  const cfg = config(patch);
  const entries = read();
  entries.push({ at: new Date(now).toISOString(), symbol, condition });
  write(entries);
  const state = remainingFor(entries, now, cfg);
  return { ok: true, remaining: state.remaining };
}

module.exports = { budget, hasBudget, take, config, remainingFor, DEFAULTS };
