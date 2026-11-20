/*
 * Scratch check, not part of the app: does STATE_DIR put the state files on the
 * mounted folder without losing anything?
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

try {
  // Off unless asked for.
  delete process.env.STATE_DIR;
  check("no STATE_DIR does nothing", stateDir.prepare({ root: CODE }), null);
  check("and touches no files", fs.readdirSync(CODE), []);

  // A ledger already on the disposable disk must survive the switch.
  fs.writeFileSync(path.join(CODE, "executor.json"), JSON.stringify({ balance: 200, closed: [{ pnl: 4 }] }));
  fs.writeFileSync(path.join(CODE, "settings.json"), JSON.stringify({ trading: { accountSize: 200 } }));
  fs.writeFileSync(path.join(CODE, "journal.json"), JSON.stringify({ entries: [] }));

  const dir = stateDir.prepare({ root: CODE, dir: DATA });
  check("the folder is created", fs.existsSync(DATA), true);
  check("it returns the folder", path.resolve(dir), path.resolve(DATA));
  check(
    "state files become links into it",
    fs.lstatSync(path.join(CODE, "executor.json")).isSymbolicLink(),
    true
  );
  check(
    "the existing ledger is moved, not dropped",
    JSON.parse(fs.readFileSync(path.join(DATA, "executor.json"), "utf8")).balance,
    200
  );
  check("the code directory no longer holds the data", fs.lstatSync(path.join(CODE, "executor.json")).isSymbolicLink(), true);
  check(
    "settings.json is owner-only on the folder",
    (fs.statSync(path.join(DATA, "settings.json")).mode & 0o777).toString(8),
    "600"
  );

  // A normal save lands on the folder, through the link.
  writeJson(path.join(CODE, "executor.json"), { balance: 512.5, closed: [{ pnl: 12.5 }] });
  check(
    "a save through the link reaches the folder",
    JSON.parse(fs.readFileSync(path.join(DATA, "executor.json"), "utf8")).balance,
    512.5
  );
  check(
    "the link is still a link",
    fs.lstatSync(path.join(CODE, "executor.json")).isSymbolicLink(),
    true
  );

  // Running again must be a no-op, and must not undo the move.
  stateDir.prepare({ root: CODE, dir: DATA });
  check(
    "a second boot keeps the same data",
    JSON.parse(fs.readFileSync(path.join(DATA, "executor.json"), "utf8")).balance,
    512.5
  );
  check(
    "a second boot leaves one link, not a chain",
    fs.readlinkSync(path.join(CODE, "executor.json")),
    path.join(DATA, "executor.json")
  );

  // A rebuild of the code directory leaves a fresh file next to the folder's
  // newer copy: the folder must win.
  const rebuilt = path.join(TMP, "rebuilt");
  fs.mkdirSync(rebuilt, { recursive: true });
  fs.writeFileSync(path.join(rebuilt, "executor.json"), JSON.stringify({ balance: 0 }));
  writeJson(path.join(DATA, "executor.json"), { balance: 612.5 });
  stateDir.prepare({ root: rebuilt, dir: DATA });
  check(
    "a stale file in a rebuilt checkout does not win",
    JSON.parse(fs.readFileSync(path.join(rebuilt, "executor.json"), "utf8")).balance,
    612.5
  );
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
