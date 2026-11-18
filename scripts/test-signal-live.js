/**
 * End-to-end test of the BUY/SELL Discord delivery path on a running machine.
 *
 * Reproduces exactly what the watcher does at its signal call site: look up the
 * live spread (the expression that used to throw `execMod is not defined`),
 * then hand the signal to discord.sendSignal. The messages are labelled TEST so
 * they cannot be mistaken for a live setup, and nothing is journaled.
 *
 * Run on the Fly machine:  node /tmp/test-signal-live.js
 * It is a diagnostic, not part of the server's startup path.
 */

process.chdir("/app");

const discord = require("/app/server/discord.js");
const executor = require("/app/server/executor.js");
const settings = require("/app/server/settings.js");
const costs = require("/app/server/costs.js");

const LABEL = "TEST · delivery check, not a live setup";

function sample(side, symbol, entry, stop, target) {
  return {
    side,
    symbol,
    entry,
    stop,
    target,
    confidence: LABEL,
    zone: { low: entry, high: entry, type: side === "BUY" ? "support" : "resistance" },
    riskReward: "1:2",
    reasons: [
      "Delivery check: BUY and SELL setups reach this channel, not just approach warnings.",
      "Sent by hand — no trade was taken and nothing was journaled.",
    ],
    at: new Date().toISOString(),
  };
}

(async () => {
  const report = [];
  let spreads;
  try {
    spreads = executor.liveSpreads();
    report.push({ step: "executor.liveSpreads()", ok: true, spreads: Object.keys(spreads || {}).length });
  } catch (err) {
    report.push({ step: "executor.liveSpreads()", ok: false, error: err.message });
  }

  for (const signal of [
    sample("BUY", "EURUSD", 1.085, 1.082, 1.091),
    sample("SELL", "GBPUSD", 1.27, 1.273, 1.264),
  ]) {
    try {
      const spread = costs.spreadInfo(signal.symbol, settings.getExecConfig(), spreads || {});
      report.push({ step: `spreadInfo ${signal.symbol}`, ok: true, spread });
      signal.spread = spread;
      const sent = await discord.sendSignal(signal);
      report.push({ step: `sendSignal ${signal.side} ${signal.symbol}`, ok: Boolean(sent) });
    } catch (err) {
      report.push({ step: `sendSignal ${signal.side} ${signal.symbol}`, ok: false, error: err.message });
    }
  }

  report.push({
    step: "deliveries",
    ok: true,
    latest: discord.getDeliveries().slice(0, 4),
  });

  console.log(JSON.stringify(report, null, 2));
  if (report.some((r) => r.ok === false)) process.exitCode = 1;
})();
