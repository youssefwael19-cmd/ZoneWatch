/**
 * Health monitor.
 *
 * The dashboard dots are computed in the browser, which means they only help
 * when you are looking at the screen. This does the same job on the server so
 * that a component going bad reaches you in Discord with your phone closed.
 *
 * Rules, deliberately boring:
 *  - a component must be bad twice in a row before it counts, so one slow
 *    provider request does not wake you up;
 *  - one message when it goes bad, at most one reminder every 30 minutes;
 *  - one message when it comes back.
 *
 * State lives in health.json on the volume, so a restart does not re-send
 * everything you already know.
 */

const fs = require("fs");
const path = require("path");
const { writeJson } = require("./atomicWrite");

const FILE = require("./stateDir").file("health.json");
const REALERT_MS = 30 * 60 * 1000;
const CONFIRM_CYCLES = 2;

function load() {
  try {
    const raw = fs.readFileSync(FILE, "utf-8").trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function save(state) {
  try {
    writeJson(FILE, state, 2);
  } catch {}
}

/**
 * Work out the current state of each component and decide what to say.
 *
 * @returns {{states: object, actions: Array<{component: string, state: string, detail: string, since: number}>}}
 */
function observe({ feed, discord, now = Date.now() }) {
  const stored = load();
  const previous = stored.components || {};
  const actions = [];

  const inputs = {
    // feed: bad when prices are stale while the market is open
    feed: feed.marketOpen && feed.stale > 0 ? "bad" : feed.checked > 0 ? "ok" : "warn",
    // discord: bad when a send actually failed this cycle
    discord: discord.failures > 0 ? "bad" : discord.configured ? "ok" : "warn",
  };

  for (const [name, raw] of Object.entries(inputs)) {
    const prev = previous[name] || { state: "ok", strikes: 0, since: null, notifiedAt: 0 };
    const strikes = raw === "bad" ? (prev.strikes || 0) + 1 : 0;
    const confirmedBad = raw === "bad" && strikes >= CONFIRM_CYCLES;
    const state = confirmedBad ? "bad" : raw === "bad" ? prev.state || "ok" : raw;

    const entry = {
      state,
      strikes,
      since: state === "bad" ? prev.since || (prev.state === "bad" ? prev.since : now) || now : null,
      notifiedAt: prev.notifiedAt || 0,
    };

    const wasBad = prev.state === "bad";
    const isBad = state === "bad";

    if (isBad && (!wasBad || now - (prev.notifiedAt || 0) > REALERT_MS)) {
      actions.push({
        component: name,
        state: "bad",
        detail: raw === "bad" ? "bad" : "warn",
        since: entry.since,
      });
      entry.notifiedAt = now;
    } else if (!isBad && wasBad) {
      actions.push({ component: name, state: "recovered", detail: "ok", since: prev.since });
      entry.notifiedAt = now;
    }

    previous[name] = entry;
  }

  stored.components = previous;
  stored.updatedAt = new Date(now).toISOString();
  save(stored);

  return {
    states: Object.fromEntries(Object.entries(previous).map(([k, v]) => [k, v.state])),
    actions,
  };
}

/**
 * The alert itself failed to deliver. Try again in a few minutes rather than
 * waiting the full re-alert window — an undelivered warning is the one case
 * where retrying is clearly worth the extra request.
 */
function markUndelivered(component, now = Date.now()) {
  const stored = load();
  const entry = stored.components && stored.components[component];
  if (!entry) return;
  entry.notifiedAt = now - REALERT_MS + 5 * 60 * 1000;
  save(stored);
}

module.exports = { observe, markUndelivered, FILE, REALERT_MS, CONFIRM_CYCLES };
