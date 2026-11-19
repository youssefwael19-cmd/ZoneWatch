/*
 * Scratch check, not part of the app: does the opt-in state store actually
 * restore state and write it through?
 *
 * A fake Supabase stands in for the real one — a tiny HTTP server that answers
 * the two REST calls the store makes — so this runs with no account, no network
 * and no credentials. The state files are written to a temp directory, never to
 * the repo's own, so a run cannot clobber a real ledger.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "state-store-"));

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

/* ---------------------------------------------------------------- *
 * Fake Supabase
 * ---------------------------------------------------------------- */

const rows = new Map(); // key -> { key, payload, updated_at }
const seen = [];
let failing = false;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  seen.push(`${req.method} ${url.pathname}`);

  if (url.pathname !== "/rest/v1/zone_watch_state") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "no such table" }));
    return;
  }

  if (req.method === "GET") {
    if (failing) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "boom" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([...rows.values()]));
    return;
  }

  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (failing) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "boom" }));
        return;
      }
      let batch;
      try {
        batch = JSON.parse(body);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "bad json" }));
        return;
      }
      for (const row of batch) {
        rows.set(row.key, { key: row.key, payload: row.payload, updated_at: row.updated_at });
      }
      res.writeHead(201, { "content-type": "application/json" });
      res.end("");
    });
    return;
  }

  res.writeHead(405);
  res.end("");
});

/* ---------------------------------------------------------------- *
 * Run
 * ---------------------------------------------------------------- */

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  // 1. Switched off by default: nothing is read, nothing is pushed.
  const off = execFileSync(process.execPath, [
    "-e",
    `const s = require(${JSON.stringify(path.join(ROOT, "server", "stateStore.js"))});
     s.persist("state.json", { a: 1 });
     s.hydrate().then((r) => {
       const out = { enabled: s.enabled, hydrated: r.enabled, schema: s.isStateFile("journal.json") };
       process.stdout.write(JSON.stringify(out));
     });`,
  ], { cwd: ROOT, env: { PATH: process.env.PATH } });
  check("state store off by default", JSON.parse(String(off)), {
    enabled: false,
    hydrated: false,
    schema: true,
  });

  // 2. Files on disk: one older than the stored copy, one newer.
  const old = Date.now() - 60 * 60 * 1000;
  fs.writeFileSync(path.join(TMP, "executor.json"), JSON.stringify({ balance: 200, open: [], closed: [] }));
  fs.writeFileSync(path.join(TMP, "brain.json"), JSON.stringify({ note: "local is newer" }));
  fs.utimesSync(path.join(TMP, "executor.json"), new Date(old), new Date(old));
  fs.writeFileSync(path.join(TMP, "journal.json"), JSON.stringify({ entries: [] }));

  rows.set("executor.json", {
    key: "executor.json",
    payload: { balance: 512.5, open: [], closed: [{ pnl: 12.5 }] },
    updated_at: new Date().toISOString(),
  });
  rows.set("brain.json", {
    key: "brain.json",
    payload: { note: "stale" },
    updated_at: new Date(old - 60 * 1000).toISOString(),
  });
  rows.set("settings.json", {
    key: "settings.json",
    payload: { trading: { accountSize: 200 } },
    updated_at: new Date().toISOString(),
  });
  // A row that is not a plain state file must be ignored, not written.
  rows.set("../escape.json", {
    key: "../escape.json",
    payload: { evil: true },
    updated_at: new Date().toISOString(),
  });

  process.env.STATE_STORE = "supabase";
  process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_KEY = "test-key";
  process.env.STATE_TABLE = "zone_watch_state";
  process.env.STATE_ROOT = TMP;

  const store = require(path.join(ROOT, "server", "stateStore.js"));
  check("state store enabled", store.enabled, true);

  // 3. Restore.
  const restored = await store.hydrate();
  const ledger = JSON.parse(fs.readFileSync(path.join(TMP, "executor.json"), "utf8"));
  check("newer stored copy replaces the local file", ledger.balance, 512.5);
  check("stored copy is counted once", restored.restored, 2);
  check("newer local file is kept", restored.keptLocal, 1);
  check(
    "kept local file is pushed back",
    rows.get("brain.json").payload.note,
    "local is newer"
  );
  check(
    "newer local file is not overwritten",
    JSON.parse(fs.readFileSync(path.join(TMP, "brain.json"), "utf8")).note,
    "local is newer"
  );
  check(
    "a path-like key cannot be written",
    fs.existsSync(path.join(TMP, "..", "escape.json")) ||
      fs.existsSync(path.join(path.dirname(TMP), "escape.json")),
    false
  );
  check("settings.json is restored owner-only", (fs.statSync(path.join(TMP, "settings.json")).mode & 0o777).toString(8), "600");
  check(
    "the file being replaced is backed up",
    fs.existsSync(path.join(TMP, "state-backup", "executor.json")),
    true
  );

  // 4. Write-through: a normal app save lands in the store.
  const { writeJson } = require(path.join(ROOT, "server", "atomicWrite.js"));
  writeJson(path.join(TMP, "state.json"), { watching: true, at: 1 });
  await store.flush();
  check("a save is pushed", rows.get("state.json").payload.watching, true);

  // 5. Temp files are not state.
  writeJson(path.join(TMP, "_tmp_trades.json"), { scratch: true });
  await store.flush();
  check("temp file is not pushed", rows.has("_tmp_trades.json"), false);

  // 6. A failing push keeps the local file and retries later.
  failing = true;
  writeJson(path.join(TMP, "journal.json"), { entries: [{ id: 1 }] });
  let threw = null;
  try {
    await store.flush();
  } catch (err) {
    threw = err.message;
  }
  check("a failed push does not throw", threw, null);
  check(
    "a failed push leaves the local file intact",
    JSON.parse(fs.readFileSync(path.join(TMP, "journal.json"), "utf8")).entries.length,
    1
  );
  check("a failed push is recorded", store.status().lastError != null, true);
  check("a failed push stays queued", store.status().pending, 1);

  failing = false;
  await store.flush();
  check("the retry reaches the store", rows.get("journal.json").payload.entries.length, 1);
  check("the queue is empty afterwards", store.status().pending, 0);

  const getCount = seen.filter((s) => s.startsWith("GET") && !s.includes("state.json")).length;
  check("hydrate made one read", getCount >= 1, true);

  server.close();
}

main()
  .catch((err) => {
    console.log(`FAIL  harness threw: ${err.message}`);
    failed++;
  })
  .finally(() => {
    server.close();
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {}
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
