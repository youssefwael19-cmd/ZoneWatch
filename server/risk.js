/**
 * Position sizing.
 *
 * Turns "I risk 1% of my account" plus a stop distance into a lot size, so an
 * alert can tell you how much to trade rather than only where.
 *
 * Gold: 1 lot = 100 oz, so $1 of price movement = $100 per lot.
 * Nasdaq index CFDs: conventionally $1 per point per lot.
 */

function roundLots(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value < 0.01) return 0.01; // broker minimum
  return Number(value.toFixed(2));
}

/**
 * @param {object} args
 * @param {number} args.accountSize   account balance in your currency
 * @param {number} args.riskPercent   percent of the account to risk
 * @param {number} args.entry         entry price
 * @param {number} args.stop          stop price
 * @param {number} args.valuePerPointPerLot  money per 1.0 of price per lot
 */
function sizePosition({ accountSize, riskPercent, entry, stop, valuePerPointPerLot }) {
  const balance = Number(accountSize);
  const riskPct = Number(riskPercent);
  const entryPrice = Number(entry);
  const stopPrice = Number(stop);
  const perPoint = Number(valuePerPointPerLot);

  if (![balance, riskPct, entryPrice, stopPrice, perPoint].every(Number.isFinite)) return null;
  if (balance <= 0 || riskPct <= 0 || perPoint <= 0) return null;

  const distance = Math.abs(entryPrice - stopPrice);
  if (!(distance > 0)) return null;

  const riskMoney = (balance * riskPct) / 100;
  const perLotRisk = distance * perPoint;
  const lots = riskMoney / perLotRisk;

  return {
    accountSize: Number(balance.toFixed(2)),
    riskPercent: riskPct,
    riskMoney: Number(riskMoney.toFixed(2)),
    stopDistance: Number(distance.toFixed(4)),
    lots: roundLots(lots),
    rawLots: Number(lots.toFixed(4)),
    perLotRisk: Number(perLotRisk.toFixed(2)),
  };
}

module.exports = { sizePosition };
