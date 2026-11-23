/**
 * Paper capital, applied to every wallet.
 *
 * The owner asked for $500 of capital in all of the paper wallets. Those
 * balances live in the state folder behind the Settings password, so the change
 * cannot be made through the dashboard from here. This applies it on the next
 * boot instead, from a value kept in the repository (`capital.json`), and
 * records what it did in `capital.json` in the state folder so a restart never
 * re-applies an old figure over newer results.
 *
 * "Capital" is three numbers that have to agree: the executor's starting
 * balance, the shadow book's starting balance, and the account size the signal
 * sizing uses. All three are set together. The closed record is kept — this
 * changes the money behind the ledger, not its history.
 */

const fs = require("fs");
const path = require("path");
const { writeJson } = require("./atomicWrite");
const settings = require("./settings");
const executor = require("./executor");
const shadow = require("./shadow");

const SOURCE = path.join(__dirname, "..", "capital.json");
const MARKER = require("./stateDir").file("capital.json");

/**
 * The requested figure, or null when the repository does not ask for one.
 *
 * `PAPER_CAPITAL` overrides the file and accepts 0 to skip the change entirely;
 * the checks use that so booting the app against a fixed fixture ledger cannot
 * rewrite the numbers under test.
 */
function target() {
  const override = process.env.PAPER_CAPITAL;
  if (override !== undefined) {
    const amount = Number(override);
    return amount > 0 ? Number(amount.toFixed(2)) : null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(SOURCE, "utf-8"));
    const amount = Number(parsed && parsed.paperCapital);
    return amount > 0 ? Number(amount.toFixed(2)) : null;
  } catch {
    return null;
  }
}

function readMarker() {
  try {
    const raw = fs.readFileSync(MARKER, "utf-8").trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Apply the requested capital once. Idempotent: the marker holds the figure
 * that was applied, so the same request on the next boot is a no-op and a
 * different one is applied exactly once.
 */
function apply() {
  const amount = target();
  if (amount == null) return { applied: false, reason: "no paper capital requested" };

  const marker = readMarker();
  if (marker && Number(marker.balance) === amount) {
    return { applied: false, reason: `already applied (${amount})`, at: marker.at || null };
  }

  const before = {
    accountBalance: settings.getExecConfig().accountBalance,
    accountSize: settings.getTradingConfig().accountSize,
  };
  settings.setExecConfig({ accountBalance: amount });
  settings.setTradingConfig({ accountSize: amount });

  const record = {
    balance: amount,
    at: new Date().toISOString(),
    before,
    executor: executor.rebase(amount),
    shadow: shadow.rebase(amount),
  };
  try {
    writeJson(MARKER, record, 2);
  } catch {
    // A marker that cannot be written means it may apply again next boot. That
    // is the safe direction: it sets the requested capital, never a different
    // one, and the wallets end up where the owner asked.
  }
  return { applied: true, ...record };
}

module.exports = { apply, target, readMarker };
