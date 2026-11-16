/**
 * Pips.
 *
 * Raw price distance is meaningless on FX: "0.0012" says nothing about whether
 * a stop is tight or wide, and "1.7" on gold is a different trade from "1.7" on
 * EURUSD. Traders think in pips, so every signal, result and alert message
 * carries pips next to the price.
 *
 * One pip is the fourth decimal on most FX pairs, the second on yen pairs, and
 * 10 cents on gold. The Nasdaq index is quoted in index points, so its "pip" is
 * one point and messages label it "pts" to avoid pretending otherwise.
 */

const PIP_SIZE = {
  XAUUSD: 0.1,
  NASDAQ: 1,
  US30: 1,
  SPX500: 1,
};

const DEFAULT_PIP = 0.0001;

function key(symbol) {
  return String(symbol == null ? "" : symbol)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/** How much price one pip is worth on this instrument. */
function pipSize(symbol) {
  const k = key(symbol);
  if (PIP_SIZE[k]) return PIP_SIZE[k];
  if (k.endsWith("JPY")) return 0.01;
  if (k.startsWith("NAS") || k.startsWith("US30") || k.startsWith("SPX")) return 1;
  if (k === "GOLD" || k === "XAU") return 0.1;
  return DEFAULT_PIP;
}

/** Points is the honest word for an index; everything else is pips. */
function unitLabel(symbol) {
  return pipSize(symbol) === 1 ? "pts" : "pips";
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

/** A raw price distance, converted to pips. Null when the input is unusable. */
function pipsOf(symbol, distance) {
  const n = Number(distance);
  if (!Number.isFinite(n)) return null;
  return round1(n / pipSize(symbol));
}

/** Signed pips from one price to another. */
function pipsBetween(symbol, from, to) {
  const a = Number(from);
  const b = Number(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return round1((b - a) / pipSize(symbol));
}

/**
 * "+12.4 pips" for a result, "12.4 pips" for a size that has no direction.
 * Pass { signed: false } for risk and reward, where a plus sign would only
 * clutter the message.
 */
function pipsLabel(symbol, pips, opts = {}) {
  const n = Number(pips);
  if (!Number.isFinite(n)) return "—";
  const rounded = round1(n);
  const signed = opts.signed !== false;
  const sign = signed && rounded > 0 ? "+" : "";
  return `${sign}${rounded} ${unitLabel(symbol)}`;
}

module.exports = { pipSize, unitLabel, pipsOf, pipsBetween, pipsLabel };
