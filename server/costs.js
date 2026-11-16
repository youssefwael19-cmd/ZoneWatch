/**
 * Broker costs — what a trade pays before it can pay you.
 *
 * The app's own P&L used to ignore the broker entirely, which flatters every
 * result: a 2R winner is not 2R once the spread and commission are taken out,
 * and a market whose average winner is smaller than its spread can never be
 * worth trading no matter how good the win rate looks.
 *
 * Spread comes from two places, best first:
 *
 *   1. the bridge's live reading of the account's own spread (Exness, via MT5),
 *      when it is fresh — this is the real number, including news widening;
 *   2. the table below, in price units, so it scales correctly with lot size
 *      and contract size. It is a starting point, not a quote feed.
 *
 * Commission is per lot, round turn (zero on Exness standard accounts, a few
 * dollars on raw-spread accounts). Swap is per lot per night held; it is
 * instrument- and direction-dependent and sometimes a credit, so it defaults to
 * zero and is configured rather than guessed.
 */

const SPREADS = {
  XAUUSD: 0.3, // 30 cents per ounce, typical standard-account gold spread
  NASDAQ: 1.5, // index points
  EURUSD: 0.00012, // 1.2 pips
  GBPUSD: 0.00014,
  USDJPY: 0.014,
  AUDUSD: 0.00016,
  USDCAD: 0.00018,
  USDCHF: 0.00018,
  AUDJPY: 0.02,
  NZDJPY: 0.02,
};

/**
 * Fallback stop distances, in price units, for the break-even table when there
 * is no closed or live signal to measure. Roughly a 20-point gold stop, a
 * 100-point index stop and a 20-pip FX stop — labelled as an assumption
 * wherever it is used.
 */
const DEFAULT_STOPS = {
  XAUUSD: 20,
  NASDAQ: 100,
  EURUSD: 0.002,
  GBPUSD: 0.002,
  USDJPY: 0.2,
  AUDUSD: 0.002,
  USDCAD: 0.002,
  USDCHF: 0.002,
  AUDJPY: 0.2,
  NZDJPY: 0.2,
};

const LIVE_MAX_AGE_MS = 15 * 60 * 1000;

function costConfig(config) {
  const costs = (config && config.costs) || {};
  return {
    spreads: costs.spreads && typeof costs.spreads === "object" ? costs.spreads : {},
    commissionPerLot: Number(costs.commissionPerLot) || 0,
    swapPerLotPerNight: Number(costs.swapPerLotPerNight) || 0,
  };
}

/**
 * Spread in price units, and where it came from.
 * @param {object} [live] map of symbol -> { price, at } read from the bridge
 */
function spreadInfo(symbol, config, live) {
  const reading = live && live[symbol];
  if (reading && Number.isFinite(Number(reading.price))) {
    const at = new Date(reading.at).getTime();
    if (Number.isFinite(at) && Date.now() - at <= LIVE_MAX_AGE_MS) {
      return { units: Number(reading.price), source: "broker" };
    }
  }

  const { spreads } = costConfig(config);
  const override = Number(spreads[symbol]);
  if (Number.isFinite(override) && override >= 0) return { units: override, source: "override" };

  const modelled = SPREADS[symbol];
  if (Number.isFinite(modelled)) return { units: modelled, source: "model" };
  return { units: null, source: "unknown" };
}

/** Spread in price units for a symbol. Kept for callers that want just the number. */
function spreadFor(symbol, config, live) {
  return spreadInfo(symbol, config, live).units;
}

/**
 * Cost charged when the position opens: the half-spread on entry plus the
 * round-turn commission. The exit half of the spread is charged on close.
 *
 * @param {{symbol: string, lots: number, valuePerUnit: number, config?: object, live?: object}} args
 */
function entryCost({ symbol, lots, valuePerUnit, config, live }) {
  const spread = spreadInfo(symbol, config, live);
  const { commissionPerLot } = costConfig(config);
  const halfSpread = Number.isFinite(spread.units) ? (spread.units / 2) * lots * valuePerUnit : 0;
  const commission = commissionPerLot * lots;
  return {
    spreadUnits: spread.units,
    spreadSource: spread.source,
    spread: Number(halfSpread.toFixed(2)),
    commission: Number(commission.toFixed(2)),
    total: Number((halfSpread + commission).toFixed(2)),
    known: Number.isFinite(spread.units),
  };
}

/** The other half of the spread, plus swap for however many nights it slept. */
function exitCost({ symbol, lots, valuePerUnit, nights = 0, config, live }) {
  const spread = spreadInfo(symbol, config, live);
  const { swapPerLotPerNight } = costConfig(config);
  const halfSpread = Number.isFinite(spread.units) ? (spread.units / 2) * lots * valuePerUnit : 0;
  const swap = swapPerLotPerNight * lots * Math.max(0, nights);
  return {
    spread: Number(halfSpread.toFixed(2)),
    swap: Number(swap.toFixed(2)),
    total: Number((halfSpread + swap).toFixed(2)),
  };
}

function money(n) {
  return Number((Number(n) || 0).toFixed(2));
}

/**
 * Today's closed trades, split into what the market gave and what the broker
 * took. The question it answers is the one that matters: does a typical winner
 * still win after the broker is paid?
 */
function summarize(closed = [], config = null, live = null, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const rows = (closed || []).filter((c) => String(c.closedAt || "").slice(0, 10) === today);

  const wins = rows.filter((c) => c.outcome === "win");
  const losses = rows.filter((c) => c.outcome === "loss");

  const gross = money(rows.reduce((a, c) => a + Number(c.grossPnl != null ? c.grossPnl : c.pnl), 0));
  const cost = money(rows.reduce((a, c) => a + Number(c.cost || 0), 0));
  const net = money(rows.reduce((a, c) => a + Number(c.pnl || 0), 0));

  const winGross = money(wins.reduce((a, c) => a + Number(c.grossPnl != null ? c.grossPnl : c.pnl), 0));
  const winCost = money(wins.reduce((a, c) => a + Number(c.cost || 0), 0));
  const lossGross = money(losses.reduce((a, c) => a + Number(c.grossPnl != null ? c.grossPnl : c.pnl), 0));
  const lossCost = money(losses.reduce((a, c) => a + Number(c.cost || 0), 0));

  const avgCost = rows.length ? money(cost / rows.length) : null;
  const avgWinGross = wins.length ? money(winGross / wins.length) : null;
  const avgWinNet = wins.length ? money((winGross - winCost) / wins.length) : null;

  // The specific question: can the winners pay the broker on their own?
  const winnersCoverBroker = wins.length ? money(winGross - winCost) > 0 : null;
  const winnersCoverEverything = wins.length ? money(winGross - cost) > 0 : null;

  return {
    date: today,
    trades: rows.length,
    wins: wins.length,
    losses: losses.length,
    gross,
    cost,
    net,
    winGross,
    winCost,
    lossGross,
    lossCost,
    avgCost,
    avgWinGross,
    avgWinNet,
    // Did the winners, after their own costs, still make money?
    winnersCoverBroker,
    // Did the winners pay for every trade taken today, winners and losers?
    winnersCoverEverything,
    model: costConfig(config),
  };
}

/**
 * Break-even table: for each market, the spread expressed in R (lots cancel
 * out, so it depends only on the stop distance), the win rate needed to cover
 * costs at a target R multiple, and the expectancy at a reference win rate.
 *
 * @param {object} args
 * @param {Array<{symbol: string, label?: string, valuePerUnit: number, stopDistance: number|null, stopSource: string}>} args.markets
 * @param {object} args.config exec config
 * @param {object} [args.live] live spreads from the bridge
 * @param {number} [args.targetR] reward multiple (default 2)
 * @param {number} [args.referenceWinRate] win rate to project at (default 0.411)
 */
function breakEvenTable({
  markets = [],
  config = null,
  live = null,
  targetR = 2,
  referenceWinRate = 0.411,
} = {}) {
  const { commissionPerLot } = costConfig(config);

  const rows = markets.map((m) => {
    const spread = spreadInfo(m.symbol, config, live);
    const stop = Number(m.stopDistance);
    const perUnit = Number(m.valuePerUnit);

    if (!Number.isFinite(stop) || stop <= 0 || !Number.isFinite(perUnit) || perUnit <= 0) {
      return {
        symbol: m.symbol,
        label: m.label || m.symbol,
        stopDistance: null,
        stopSource: m.stopSource,
        spreadUnits: spread.units,
        spreadSource: spread.source,
        costR: null,
        breakEvenWinRate: null,
        expectancy: null,
      };
    }

    // Cost in R: the spread is (spreadUnits × lots × valuePerUnit), risk is
    // (stop × lots × valuePerUnit), so lots and value cancel out entirely.
    const spreadR = Number.isFinite(spread.units) ? spread.units / stop : 0;
    const commissionR = commissionPerLot / (stop * perUnit);
    const costR = spreadR + commissionR;

    // p·targetR − (1−p)·1 − costR = 0  →  p = (1 + costR) / (1 + targetR)
    const breakEvenWinRate = (1 + costR) / (1 + targetR);
    const expectancy = referenceWinRate * targetR - (1 - referenceWinRate) - costR;

    return {
      symbol: m.symbol,
      label: m.label || m.symbol,
      stopDistance: stop,
      stopSource: m.stopSource,
      spreadUnits: spread.units,
      spreadSource: spread.source,
      costR: Number(costR.toFixed(4)),
      breakEvenWinRate: Number((breakEvenWinRate * 100).toFixed(2)),
      expectancy: Number(expectancy.toFixed(3)),
      expectancyGross: Number((referenceWinRate * targetR - (1 - referenceWinRate)).toFixed(3)),
    };
  });

  return {
    targetR,
    referenceWinRate,
    commissionPerLot,
    rows,
    note:
      "Cost is charged in R, so lot size cancels out: a tighter stop makes the same spread a bigger share of the risk. Break-even assumes the app's 1:2 target and stops winning full R.",
  };
}

module.exports = {
  SPREADS,
  DEFAULT_STOPS,
  LIVE_MAX_AGE_MS,
  spreadInfo,
  spreadFor,
  entryCost,
  exitCost,
  summarize,
  breakEvenTable,
  costConfig,
};
