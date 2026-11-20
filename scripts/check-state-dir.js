/*
 * Scratch check, not part of the app: do the state files land on the mounted
 * folder without losing anything, and without needing to write next to the code?
 *
 * Runs entirely in temp directories, so it cannot touch a real ledger, and it
 * never needs a host that has such a folder.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "state-dir-"));
const CODE = path.join(TMP, "code");
const DATA = path.join(TMP, "data");
fs.mkdirSync(CODE, { recursive: true });

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name} = ${JSON.stringify(actual)}${ok ? "" : "  expected " + JSON.stringify(expected)}`
  );
  if (ok) passed++;
  else failed++;
}

const stateDir = require(path.join(ROOT, "server", "stateDir.js"));
const { writeJson } = require(path.join(ROOT, "server", "atomicWrite.js"));

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

try {
  // Off unless asked for, or unless the host mounted a folder at the usual path.
  delete process.env.STATE_DIR;
  check("no folder anywhere does nothing", stateDir.prepare({ root: CODE, candidates: [] }), null);
  check("and touches no files", fs.readdirSync(CODE), []);
  check("and reports local files", stateDir.status().mode, "local");
  check("and keeps state next to the code", stateDir.file("settings.json"), path.join(ROOT, "settings.json"));

  // A ledger already on the disposable disk must survive the switch.
  fs.writeFileSync(path.join(CODE, "executor.json"), JSON.stringify({ balance: 200, closed: [{ pnl: 4 }] }));
  fs.writeFileSync(path.join(CODE, "settings.json"), JSON.stringify({ trading: { accountSize: 200 } }));
  fs.writeFileSync(path.join(CODE, "journal.json"), JSON.stringify({ entries: [] }));

  const dir = stateDir.prepare({ root: CODE, dir: DATA });
  check("the folder is created", fs.existsSync(DATA), true);
  check("it returns the folder", path.resolve(dir), path.resolve(DATA));
  check("state is read from the folder", stateDir.file("executor.json"), path.join(DATA, "executor.json"));
  check("the existing ledger is carried over", readJson(path.join(DATA, "executor.json")).balance, 200);
  check("and the code directory is still readable", fs.existsSync(path.join(CODE, "executor.json")), true);
  check("nothing next to the code was turned into a link", fs.lstatSync(path.join(CODE, "executor.json")).isSymbolicLink(), false);
  check(
    "settings.json is owner-only on the folder",
    (fs.statSync(path.join(DATA, "settings.json")).mode & 0o777).toString(8),
    "600"
  );

  // A normal save lands on the folder, and only there.
  writeJson(stateDir.file("executor.json"), { balance: 512.5, closed: [{ pnl: 12.5 }] });
  check("a save reaches the folder", readJson(path.join(DATA, "executor.json")).balance, 512.5);
  check("the copy next to the code is untouched", readJson(path.join(CODE, "executor.json")).balance, 200);

  // A second boot keeps everything and repeats nothing.
  stateDir.prepare({ root: CODE, dir: DATA });
  check("a second boot keeps the same data", readJson(path.join(DATA, "executor.json")).balance, 512.5);
  check("status reports the folder after a good boot", stateDir.status().mode, "persistent");
  check("status counts the state files it found", stateDir.status().files, 3);
  check("status has nothing to complain about", stateDir.status().error, null);

  // A rebuild of the code directory leaves a fresh default file: the folder's
  // newer copy must win.
  const rebuilt = path.join(TMP, "rebuilt");
  fs.mkdirSync(rebuilt, { recursive: true });
  fs.writeFileSync(path.join(rebuilt, "executor.json"), JSON.stringify({ balance: 0 }));
  writeJson(path.join(DATA, "executor.json"), { balance: 612.5 });
  stateDir.prepare({ root: rebuilt, dir: DATA });
  check("a fresh default in a rebuilt checkout does not win", readJson(path.join(DATA, "executor.json")).balance, 612.5);

  // An install that still has a link into the folder is carried over, not lost.
  const legacy = path.join(TMP, "legacy");
  const legacyData = path.join(TMP, "legacy-data");
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(TMP, "old-ledger.json"), JSON.stringify({ balance: 7 }));
  fs.symlinkSync(path.join(TMP, "old-ledger.json"), path.join(legacy, "executor.json"));
  stateDir.prepare({ root: legacy, dir: legacyData });
  check("a linked install is carried over", readJson(path.join(legacyData, "executor.json")).balance, 7);

  // A host that mounts the folder at the usual path needs no variable at all.
  const mounted = path.join(TMP, "mounted");
  fs.mkdirSync(mounted, { recursive: true });
  const autoDir = stateDir.prepare({ root: rebuilt, candidates: [path.join(TMP, "nope"), mounted] });
  check("a mounted folder is found without STATE_DIR", path.resolve(autoDir), path.resolve(mounted));
  check("and is reported as found, not configured", stateDir.status().auto, true);
  check("and state is read from it", stateDir.file("executor.json"), path.join(mounted, "executor.json"));

  // A folder that exists but cannot be written is no better than no folder.
  const blocked = path.join(TMP, "blocked");
  fs.writeFileSync(blocked, "a file, not a folder");
  const blockedResult = stateDir.prepare({ root: rebuilt, dir: path.join(blocked, "data") });
  check("an unusable folder falls back to local files", blockedResult, null);
  check("and is not reported as persistent", stateDir.status().mode, "local");
  check("and says why", typeof stateDir.status().error, "string");
  check("and state goes back next to the code", stateDir.file("executor.json"), path.join(ROOT, "executor.json"));
} catch (err) {
  console.log(`FAIL  harness threw: ${err.stack}`);
  failed++;
} finally {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
