#!/usr/bin/env node
/**
 * The signal block for pine/zonewatch-signals.pine.
 *
 * TradingView scripts cannot fetch a URL, so the signals have to be carried in
 * the script itself. This reads the app's journal (the same record the
 * dashboard shows) and prints one line per signal in the format the indicator
 * parses:
 *
 *   epochMillis|SYMBOL|BUY|entry|stop|target|KIND
 *
 * KIND is OPEN, WIN, LOSS, BE, EXPIRED or HELD.
 *
 * Usage:
 *   node scripts/make-pine-data.js                      # live app
 *   node scripts/make-pine-data.js --file journal.json  # a local copy
 *   node scripts/make-pine-data.js --held               # include held-back ones
 *   node scripts/make-pine-data.js --limit 40           # shorter block
 *   node scripts/make-pine-data.js --out pine/signals.txt
 *
 * No dependencies: fetch is built into Node 20+.
 */

const fs = require("fs");

const DEFAULT_URL = "https://zonewatch.productecho.com";
// An input box in TradingView is not unlimited: roughly 80 lines is the sweet
// spot before pasting becomes awkward. Newest signals are kept.
const DEFAULT_LIMIT = 80;

function parseArgs(argv) {
  const args = { url: DEFAULT_URL, file: null, held: false, limit: DEFAULT_LIMIT, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") args.url = argv[++i];
    else if (a === "--file") args.file = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--held") args.held = true;
    else if (a === "--limit") args.limit = Number(argv[++i]) || DEFAULT_LIMIT;
    else if (a === "--help" || a === "-h") {
      console.log(fs.readFileSync(__filename, "utf-8").split("*/")[0].replace(/^.*?\/\*\*/, ""));
      process.exit(0);
    }
  }
  return args;
}

function kindOf(entry) {
  if (entry.status === "held") return "HELD";
  const outcome = entry.outcome;
  if (outcome === "win") return "WIN";
  if (outcome === "loss") return "LOSS";
  if (outcome === "breakeven") return "BE";
  if (outcome === "expired") return "EXPIRED";
  return "OPEN";
}

async function loadEntries(args) {
  if (args.file) {
    const raw = JSON.parse(fs.readFileSync(args.file, "utf-8"));
    if (Array.isArray(raw)) return raw;
    return raw.signals || raw.entries || raw.recent || [];
  }
  // The journal endpoint only returns the last few entries for the dashboard;
  // this one returns every signal, which is what a chart wants.
  const url = args.url.replace(/\/$/, "") + "/api/export/signals.json";
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const body = await res.json();
  return body.signals || body.entries || [];
}

/** Where a signal belongs on a chart, as the flat line the indicator reads. */
function toLine(entry) {
  const ms = new Date(entry.at || 0).getTime();
  const entryPrice = Number(entry.entry);
  if (!Number.isFinite(ms) || !Number.isFinite(entryPrice)) return null;
  const stop = Number(entry.stop);
  const target = Number(entry.target);
  const num = (v) => (Number.isFinite(v) ? String(v) : "");
  return [
    ms,
    String(entry.symbol || "").toUpperCase(),
    String(entry.side || "").toUpperCase(),
    entryPrice,
    num(stop),
    num(target),
    kindOf(entry),
  ].join("|");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const entries = await loadEntries(args);
  const usable = (entries || []).filter((e) => e && Number.isFinite(Number(e.entry)) && e.at);
  const kept = usable.filter((e) => args.held || e.status !== "held");

  if (!kept.length) {
    console.log("No signals to draw yet. The app reports none in this journal.");
    if (usable.length) console.log(`(${usable.length} held-back signal(s) exist — add --held to include them.)`);
    process.exit(0);
  }

  const lines = kept
    .slice()
    .sort((a, b) => new Date(a.at) - new Date(b.at))
    .slice(-args.limit)
    .map(toLine)
    .filter(Boolean);

  const header = [
    `# Zone Watch signals — ${lines.length} of ${kept.length} (generated ${new Date().toISOString()})`,
    "# Paste the lines below into the indicator's \"Signals\" box.",
  ];

  const block = [...header, ...lines].join("\n");
  if (args.out) {
    fs.writeFileSync(args.out, block + "\n");
    console.log(`Wrote ${lines.length} signal line(s) to ${args.out}`);
  }
  console.log(block);
  console.log(
    `\n${lines.length} signal(s): ${lines.filter((l) => l.includes("|BUY|")).length} buy, ` +
      `${lines.filter((l) => l.includes("|SELL|")).length} sell.`
  );
}

main().catch((err) => {
  console.error(`Could not build the signal block: ${err.message}`);
  process.exit(1);
});
