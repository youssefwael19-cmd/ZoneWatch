/**
 * An optional external home for the app's state files.
 *
 * Everything this app knows lives in JSON files next to its code: the paper
 * ledger, the journal, the brain, the settings with their credentials. On a
 * host with a real disk that is fine. On a free host whose filesystem is wiped
 * on every restart it is not, and no code change can make that filesystem
 * persist — the platform simply does not provide one.
 *
 * So this module keeps the files where they are and copies them somewhere that
 * does survive:
 *
 *   hydrate()  runs once at boot, before the app serves anything. Every file
 *              whose stored copy is newer than the local one is written back to
 *              disk, so a wiped container starts with its real ledger.
 *   persist()  is called by the atomic writer after every successful local
 *              write, and pushes the new contents out in the background.
 *
 * With STATE_STORE unset nothing in here runs: reads and writes are the plain
 * local files they always were, which is what a machine with a disk wants.
 *
 * Configuration (all server-side, never sent to the browser):
 *   STATE_STORE=supabase        opt in; any other value leaves it off
 *   SUPABASE_URL                https://<project>.supabase.co
 *   SUPABASE_SERVICE_KEY        service role key (also SUPABASE_KEY)
 *   STATE_TABLE                 table name, default zone_watch_state
 *   STATE_ROOT                  where the state files live, default the repo
 *
 * The table is one row per file, created by deploy/supabase-state.sql.
 */

const fs = require("fs");
const path = require("path");

const ROOT = process.env.STATE_ROOT
  ? path.resolve(process.env.STATE_ROOT)
  : path.join(__dirname, "..");

const MODE = String(process.env.STATE_STORE || "").trim().toLowerCase();
const URL_BASE = String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const KEY = String(
  process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_KEY ||
    ""
).trim();
const TABLE = String(process.env.STATE_TABLE || "zone_watch_state").trim() || "zone_watch_state";

// A key is only ever a file name, never a path: a stored row must not be able to
// write outside the directory the app owns.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;
// Files the app never treats as state: the package manifests and the sample
// trades are code, and the app's own template file is not a ledger.
const NOT_STATE = new Set(["package.json", "package-lock.json", "example_trades.json"]);

// A local file is only allowed to beat the stored copy when it is clearly newer.
// Without the margin, ordinary clock skew between the container and the database
// would make a just-pushed file look newer than the push that produced it.
const CLOCK_SLACK_MS = 5000;

const enabled = MODE === "supabase" && Boolean(URL_BASE && KEY);
const misconfigured = MODE === "supabase" && !enabled;

const state = {
  restored: 0,
  keptLocal: 0,
  pushed: 0,
  lastError: null,
};

/** Names that may be mirrored. Temp files (`_tmp_trades.json`, `*.pid.tmp`) are not. */
function isStateFile(name) {
  if (typeof name !== "string") return false;
  if (!NAME_RE.test(name)) return false;
  if (name.startsWith("_") || name.includes(".tmp")) return false;
  return !NOT_STATE.has(name);
}

function headers(extra) {
  return {
    apikey: KEY,
    Authorization: `Bearer ${KEY}`,
    "Content-Type": "application/json",
    ...(extra || {}),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function localPath(name) {
  return path.join(ROOT, name);
}

/**
 * The real file to write. With STATE_DIR the state files are symlinks into the
 * mounted folder, and renaming over the link itself would replace it with a
 * plain file on the disposable disk — so resolve the link first.
 */
function localFile(name) {
  const file = localPath(name);
  try {
    if (fs.lstatSync(file).isSymbolicLink()) {
      return path.resolve(path.dirname(file), fs.readlinkSync(file));
    }
  } catch {}
  return file;
}

/** settings.json holds credentials, so every copy of it is owner-only. */
function writeLocal(name, value) {
  const file = localFile(name);
  const tmp = `${file}.${process.pid}.storetmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
  fs.renameSync(tmp, file);
  if (name === "settings.json") {
    try {
      fs.chmodSync(file, 0o600);
    } catch {}
  }
}

function readLocal(name) {
  try {
    const raw = fs.readFileSync(localPath(name), "utf-8").trim();
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function localMtime(name) {
  try {
    return fs.statSync(localPath(name)).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Keep one copy of whatever a restore is about to overwrite. A restore should
 * only ever replace a wiped file or an older one, but if this is ever switched
 * on for a machine that already had a live ledger, that ledger should still be
 * findable afterwards rather than gone.
 */
function backupOnce(name, value) {
  try {
    const dir = path.join(ROOT, "state-backup");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return;
    fs.writeFileSync(file, JSON.stringify(value, null, 2), { encoding: "utf-8", mode: 0o600 });
  } catch (err) {
    console.error(`State store: could not back up ${name}: ${err.message}`);
  }
}

async function request(url, options) {
  if (typeof fetch !== "function") {
    throw new Error("this Node has no fetch; Node 18 or newer is required");
  }
  return fetch(url, options);
}

async function fetchRows() {
  const url = `${URL_BASE}/rest/v1/${TABLE}?select=key,payload,updated_at&limit=2000`;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await request(url, { headers: headers() });
      if (res.ok) {
        const rows = await res.json();
        return Array.isArray(rows) ? rows : [];
      }
      const text = await res.text().catch(() => "");
      lastErr = new Error(`Supabase answered ${res.status}${text ? ": " + text.slice(0, 200) : ""}`);
      // A bad key or a missing table will answer the same way next time.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
    } catch (err) {
      lastErr = err;
    }
    await sleep(400 * attempt);
  }
  throw lastErr || new Error("Supabase could not be reached");
}

/**
 * Upsert a batch of rows. `key` is the primary key, so a merge-duplicates
 * preference makes this the only write path needed.
 */
async function upsertRows(rows) {
  const url = `${URL_BASE}/rest/v1/${TABLE}?on_conflict=key`;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await request(url, {
        method: "POST",
        headers: headers({ Prefer: "resolution=merge-duplicates,return=minimal" }),
        body: JSON.stringify(rows),
      });
      if (res.ok) return;
      const text = await res.text().catch(() => "");
      lastErr = new Error(`Supabase answered ${res.status}${text ? ": " + text.slice(0, 200) : ""}`);
      if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
    } catch (err) {
      lastErr = err;
    }
    await sleep(400 * attempt);
  }
  throw lastErr || new Error("Supabase could not be reached");
}

/**
 * Restore every stored file that is newer than the local one.
 *
 * Returns a summary rather than throwing on a partial restore: a boot with a
 * stale file is better than a boot that refuses to happen. Callers get the
 * error in `error` and can log it.
 */
async function hydrate() {
  if (!enabled) return { enabled: false, restored: 0, keptLocal: 0, pushed: 0 };

  let rows;
  try {
    rows = await fetchRows();
  } catch (err) {
    state.lastError = err.message;
    return { enabled: true, restored: 0, keptLocal: 0, pushed: 0, error: err.message };
  }

  const toPush = [];
  for (const row of rows) {
    const name = row && row.key;
    if (!isStateFile(name) || !row.payload || typeof row.payload !== "object") continue;

    const remoteMs = Date.parse(row.updated_at) || 0;
    const localMs = localMtime(name);
    const local = localMs ? readLocal(name) : null;

    if (local && localMs > remoteMs + CLOCK_SLACK_MS) {
      // The local file is genuinely newer, which happens when a push failed on
      // the way out. It wins, and gets pushed rather than thrown away.
      state.keptLocal += 1;
      toPush.push({ key: name, payload: local, updated_at: new Date(localMs).toISOString() });
      continue;
    }

    if (local) backupOnce(name, local);
    try {
      writeLocal(name, row.payload);
      state.restored += 1;
    } catch (err) {
      state.lastError = `could not restore ${name}: ${err.message}`;
    }
  }

  if (toPush.length) {
    try {
      await upsertRows(toPush);
      state.pushed += toPush.length;
    } catch (err) {
      state.lastError = err.message;
    }
  }

  return {
    enabled: true,
    restored: state.restored,
    keptLocal: state.keptLocal,
    pushed: state.pushed,
    error: state.lastError || undefined,
  };
}

/* ------------------------------------------------------------------ *
 * Write-through
 *
 * Saves are frequent (the watch cycle runs every ten seconds) and a save must
 * never wait for the network, so the value is queued and pushed behind the
 * scene. Only the latest value per file matters: an intermediate version of a
 * file is not something anything ever reads back.
 * ------------------------------------------------------------------ */

const pending = new Map();
let flushing = null;
let scheduled = null;
let flushedOnce = false;

async function flush() {
  if (flushing) return flushing;
  if (!pending.size) return null;

  flushing = (async () => {
    while (pending.size) {
      const batch = [...pending.entries()].slice(0, 50);
      const rows = batch.map(([key, value]) => ({
        key,
        payload: value,
        updated_at: new Date().toISOString(),
      }));
      try {
        await upsertRows(rows);
      } catch (err) {
        // Put them back: a failed push is a deleted trade otherwise. The next
        // change to the same file, or the next flush, tries again.
        for (const [key, value] of batch) {
          if (!pending.has(key)) pending.set(key, value);
        }
        state.lastError = err.message;
        if (!flushedOnce) {
          flushedOnce = true;
          console.error(`State store: could not save to Supabase (${err.message}). State is still on local disk.`);
        }
        break;
      }
      for (const [key, value] of batch) {
        // Only drop the entry if nothing newer arrived while the push was out.
        if (pending.get(key) === value) pending.delete(key);
      }
      state.pushed += rows.length;
    }
  })().finally(() => {
    flushing = null;
  });

  return flushing;
}

/**
 * Record the latest value of a state file. Called after the local write has
 * already succeeded, so a push failure never costs the app its own copy.
 */
function persist(name, value) {
  if (!enabled || !isStateFile(name)) return;
  if (value === undefined) return;
  pending.set(name, value);
  if (scheduled || flushing) return;
  scheduled = setTimeout(() => {
    scheduled = null;
    flush().catch((err) => console.error(`State store: ${err.message}`));
  }, 50);
}

function status() {
  return {
    enabled,
    misconfigured,
    mode: MODE || "off",
    table: enabled ? TABLE : null,
    restored: state.restored,
    keptLocal: state.keptLocal,
    pushed: state.pushed,
    pending: pending.size,
    lastError: state.lastError,
  };
}

module.exports = {
  enabled,
  misconfigured,
  isStateFile,
  hydrate,
  persist,
  flush,
  status,
  ROOT,
  TABLE,
};
