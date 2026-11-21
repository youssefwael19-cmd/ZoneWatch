/**
 * Why each market is quiet.
 *
 * Every gate in this app is silent by design: when nothing is proven, nothing
 * is sent, and when a market is held there is no message saying so. That is
 * the right behaviour and the wrong user experience — a working app and a
 * broken one both show an empty signal list.
 *
 * This turns the gates into one sentence per market: the first lock that would
 * stop a setup there, and the state of every lock behind it. It is a reading,
 * never a decision: it cannot approve or refuse anything, and it is computed
 * from the same stored state the gates themselves use.
 *
 * The order is the order the watcher applies them, so the first held lock is
 * the one that actually did the stopping. Three gates cannot be judged without
 * a setup in hand — the reaction confirmation, the thin-stop check and the
 * learner's mute all need a direction, an entry and a stop — so they are named
 * on the card but left out of the chain instead of being guessed at.
 */

const NAMES = {
  market: "Market hours",
  feed: "Live feed",
  news: "News blackout",
  guard: "Daily loss guard",
  lab: "Strategy lab",
  correlation: "Correlation",
  brain: "Proven rule",
  chop: "Chop rule",
  cooldown: "Cooldown",
};

/** Gates that only exist once there is a setup to judge. */
const PER_SETUP = ["Reaction confirmation", "Thin stop", "Learner mute"];

/* The states a lock can be in, worst first. */
const HELD = "held"; // stops every setup in this market
const PARTIAL = "partial"; // stops some setups, named in the detail
const OPEN = "open"; // not in the way

function diagnoseMarket(facts = {}) {
  const locks = [];
  const put = (id, state, detail) =>
    locks.push({ id, name: NAMES[id], state, detail: String(detail || "") });

  put(
    "market",
    facts.marketOpen === false ? HELD : OPEN,
    facts.marketOpen === false
      ? facts.marketReason || "the market is closed"
      : facts.marketNote || "open"
  );

  put(
    "feed",
    facts.feedStale ? HELD : OPEN,
    facts.feedStale
      ? facts.feedDetail || "the price feed has stopped ticking"
      : "prices ticking"
  );

  put(
    "news",
    facts.newsActive ? HELD : OPEN,
    facts.newsActive ? facts.newsDetail || "news blackout" : "no blackout"
  );

  put(
    "guard",
    facts.guardStop ? HELD : OPEN,
    facts.guardStop ? facts.guardReason || "daily loss limit" : "nothing hit today"
  );

  // The lab is the outermost lock that talks about the market itself: a market
  // it has measured as having no edge is silenced before any setup is looked
  // at. An explicit override posts them anyway, clearly labelled — that is a
  // delivery promise, so it is reported as partial rather than open.
  if (facts.labTradable === true) {
    put("lab", OPEN, facts.labVerdict ? `edge: ${facts.labVerdict}` : "edge measured");
  } else if (facts.labTradable == null) {
    put("lab", OPEN, "never tested — allowed until it is");
  } else if (facts.unproven) {
    put("lab", PARTIAL, `${facts.labVerdict || "no measured edge"} — posted anyway, labelled unproven`);
  } else {
    put("lab", HELD, facts.labVerdict || "no measured edge");
  }

  put(
    "correlation",
    facts.correlatedWith ? HELD : OPEN,
    facts.correlatedWith
      ? `${facts.correlatedWith} alerted in the same group minutes ago`
      : "no group member just alerted"
  );

  if (facts.brainGateOn === false) {
    put("brain", OPEN, "gate switched off");
  } else if (facts.brainChampion) {
    put(
      "brain",
      OPEN,
      `${facts.brainChampion.name} is proven in ${facts.brainCondition}` +
        (facts.brainChampion.n ? ` (${facts.brainChampion.n} trades)` : "")
    );
  } else if (facts.brainAdjacent) {
    put(
      "brain",
      PARTIAL,
      `nothing proven in ${facts.brainCondition}; ${facts.brainAdjacent.name} next door buys half size`
    );
  } else {
    put(
      "brain",
      HELD,
      facts.brainCondition
        ? `no rule has been measured to work in ${facts.brainCondition}`
        : "this market has not been measured yet"
    );
  }

  put(
    "chop",
    facts.chopHeld ? PARTIAL : OPEN,
    facts.chopHeld
      ? "scalp setups are refused in a ranging-volatile tape; wider setups still get through"
      : "no scalp veto"
  );

  put(
    "cooldown",
    facts.cooldownMinutes != null ? HELD : OPEN,
    facts.cooldownMinutes != null
      ? `a signal went out ${facts.cooldownMinutes} min ago; the next can follow shortly`
      : "no recent signal"
  );

  const firstHeld = locks.find((l) => l.state === HELD) || null;
  const firstPartial = locks.find((l) => l.state === PARTIAL) || null;
  const state = firstHeld ? HELD : firstPartial ? PARTIAL : OPEN;

  return {
    symbol: facts.symbol,
    label: facts.label || facts.symbol,
    state,
    stoppedBy: firstHeld ? firstHeld.name : null,
    headline: firstHeld
      ? firstHeld.detail
      : firstPartial
        ? firstPartial.detail
        : "nothing is standing in the way",
    openLocks: locks.filter((l) => l.state === OPEN).length,
    totalLocks: locks.length,
    locks,
  };
}

/** One row per market, plus the counts the card shows above them. */
function explain(factsList = []) {
  const rows = (factsList || []).map(diagnoseMarket);
  return {
    rows,
    perSetup: PER_SETUP,
    open: rows.filter((r) => r.state === OPEN).length,
    partial: rows.filter((r) => r.state === PARTIAL).length,
    held: rows.filter((r) => r.state === HELD).length,
    at: new Date().toISOString(),
  };
}

module.exports = { diagnoseMarket, explain, PER_SETUP, NAMES, HELD, PARTIAL, OPEN };
