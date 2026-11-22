/**
 * The lab's promotions, kept.
 *
 * The lab nominates configs from whatever its latest run found, and that list
 * moves: a config that stops winning unseen bars stops being nominated. The
 * brain, meanwhile, has already spent real work measuring every condition for
 * the configs it was given, and may have crowned one of them champion.
 *
 * If the family simply disappeared from the rule list, brain.js would throw
 * away every cell measured for it — and, for any market whose champion was
 * that family, the whole market's result. A later lab run would then silently
 * retract a proof the app had earned. That is the wrong direction for a system
 * whose whole job is to remember what it has proven.
 *
 * So promotions are recorded here, on the state disk, and the lab hands the
 * brain the union of:
 *
 *  - what the lab nominates today, and
 *  - everything that was ever promoted and is still a rule this build tests.
 *
 * The list only grows. Nothing is removed for losing a later block: a block
 * that went against a rule is already handled where it belongs — by the brain
 * re-measuring it under the same bar and no longer calling it proven. Losing
 * the measurement entirely would just hide that answer.
 *
 * The bound is the lab's own grid: a family id is derived from the config, and
 * the grid is a dozen configs wide, so this list cannot grow without limit.
 */

const fs = require("fs");

const { writeJson } = require("./atomicWrite");
const { RULES_VERSION } = require("./strategies");

const FILE = require("./stateDir").file("promotions.json");

function empty() {
  return { rulesVersion: RULES_VERSION, at: null, configs: [] };
}

function normalise(entry) {
  const cfg = entry.cfg || {};
  return {
    id: String(entry.id),
    cfg: {
      mult: Number(cfg.mult),
      stopMode: cfg.stopMode === "zone_width" ? "zone_width" : "atr",
      rr: Number(cfg.rr),
    },
    firstPromotedAt: entry.firstPromotedAt || null,
    lastQualifiedAt: entry.lastQualifiedAt || null,
    best: entry.best
      ? {
          n: Number(entry.best.n) || 0,
          expectancy: Number(entry.best.expectancy) || 0,
          markets: Array.isArray(entry.best.markets) ? entry.best.markets.slice() : [],
        }
      : null,
  };
}

/**
 * The promotions a stored file still stands for.
 *
 * A promotion is a claim about how a rule is defined. When RULES_VERSION moves,
 * the definition did, so the old claim is about a rule this build no longer
 * runs — it goes with the rule rather than keeping a measurement alive under a
 * name whose behaviour changed. That case is a deliberate change to the rules,
 * not a lab run quietly deciding a winner is no longer interesting.
 */
function usable(parsed) {
  if (!parsed || parsed.rulesVersion !== RULES_VERSION) return empty();
  const configs = (Array.isArray(parsed.configs) ? parsed.configs : []).filter(
    (entry) => entry && entry.id && entry.cfg && Number.isFinite(Number(entry.cfg.mult))
  );
  return { rulesVersion: RULES_VERSION, at: parsed.at || null, configs: configs.map(normalise) };
}

function better(a, b) {
  if (!b) return true;
  if (!a) return false;
  if (b.expectancy !== a.expectancy) return b.expectancy > a.expectancy;
  return b.n > a.n;
}

/**
 * Fold this run's nominations into the standing list. Pure: no file access, so
 * the stickiness rule can be tested without a disk.
 *
 * Re-qualifying does not re-date a promotion — `firstPromotedAt` is when the
 * config earned its place and stays put. `best` keeps the strongest unseen
 * record it has shown, so a later, weaker nomination cannot make a rule that
 * was promoted look marginal.
 */
function merge(stored, nominated, now = new Date().toISOString()) {
  const current = usable(stored);
  const byId = new Map(current.configs.map((entry) => [entry.id, entry]));
  const added = [];
  let improved = false;

  for (const row of nominated || []) {
    if (!row || !row.id || !row.cfg) continue;
    const best = {
      n: Number(row.n) || 0,
      expectancy: Number(row.expectancy) || 0,
      markets: Array.isArray(row.markets) ? row.markets.slice() : [],
    };
    const seen = byId.get(row.id);
    if (!seen) {
      byId.set(row.id, {
        id: String(row.id),
        cfg: normalise({ id: row.id, cfg: row.cfg }).cfg,
        firstPromotedAt: now,
        lastQualifiedAt: now,
        best,
      });
      added.push(String(row.id));
      continue;
    }
    if (better(seen.best, best)) {
      seen.best = best;
      improved = true;
    }
    seen.lastQualifiedAt = now;
  }

  return {
    configs: [...byId.values()],
    added,
    changed: added.length > 0 || improved,
  };
}

/**
 * One standing promotion as the public report shows it: the rule, when it first
 * earned its place, whether the lab still nominates it, and the unseen record
 * that put it there. `currentlyNominated: false` is the interesting case — it
 * means the rule is being kept by this list rather than by a current result.
 */
function describe(entry, nominatedIds) {
  if (!entry) return null;
  const best = entry.best || null;
  return {
    id: entry.id,
    cfg: { ...entry.cfg },
    firstPromotedAt: entry.firstPromotedAt || null,
    lastQualifiedAt: entry.lastQualifiedAt || null,
    currentlyNominated: nominatedIds ? nominatedIds.has(entry.id) : null,
    unseen: best ? { n: best.n, expectancy: best.expectancy, markets: best.markets.slice() } : null,
  };
}

/**
 * The standing list for a read-only report. Never writes: the lab itself records
 * promotions when it nominates one, and a report is not a reason to touch state.
 */
function standingSummary(nominatedIds) {
  const standing = readStanding();
  return {
    updatedAt: standing.at || null,
    configs: standing.configs.map((entry) => describe(entry, nominatedIds)),
  };
}

function readStanding() {
  try {
    const raw = fs.readFileSync(FILE, "utf-8").trim();
    if (!raw) return empty();
    return usable(JSON.parse(raw));
  } catch {
    return empty();
  }
}

/**
 * The standing promotions after folding in today's nominations. Writes only
 * when a config is newly promoted or shows a stronger unseen record, so a
 * steady state costs nothing on the state disk.
 *
 * If the write fails the merged list is still returned: an unwritable disk is a
 * reason to keep the promotion in memory for this run, never a reason to let
 * the lab silently drop the cells the brain already measured.
 */
function standings(nominated) {
  const now = new Date().toISOString();
  const merged = merge(readStanding(), nominated, now);
  if (merged.changed) {
    try {
      writeJson(FILE, { rulesVersion: RULES_VERSION, at: now, configs: merged.configs }, 2);
    } catch {
      // see above: in-memory stickiness beats no stickiness
    }
  }
  return merged.configs;
}

module.exports = {
  FILE,
  empty,
  usable,
  merge,
  describe,
  readStanding,
  standingSummary,
  standings,
};
