/**
 * Keep the state files on a folder that survives a redeploy.
 *
 * Everything this app remembers is a JSON file next to its code. On a host that
 * rebuilds the code directory on every deploy — ProductEcho, or any buildpack
 * host — those files are part of the disposable build, so the ledger would be
 * wiped each time. A mounted folder is the fix, and this module is what every
 * state file asks for its path:
 *
 *   STATE_DIR=/data       name the folder
 *   (nothing)             a mounted /data is found on its own
 *   (no folder anywhere)  the files stay exactly where they are today
 *
 * The first version of this module linked each state file to the folder. That
 * cannot work on a host where a volume makes the app run as the folder's owner:
 * the code directory is read-only by then, so every link fails with EACCES while
 * the folder itself is perfectly fine. Resolving the path instead needs no write
 * to the code directory at all.
 *
 * stateStore.js (the optional Supabase mirror) asks file() for the same paths,
 * so both mechanisms can be on at once without disagreeing about where the
 * ledger lives.
 */

const fs = require("fs");
const path = require("path");

// Every file the app treats as state. Adding one here is enough to move it.
const FILES = [
  "settings.json",
  "zones.json",
  "alerts.json",
  "signals.json",
  "market-budget.json",
  "recap.json",
  "heartbeat.json",
  "state.json",
  "lab.json",
  "learning.json",
  "health.json",
  "brain.json",
  "promotions.json",
  "journal.json",
  "botjournal.json",
  "executor.json",
  "shadow.json",
  "digest.json",
  "dailyrecap.json",
  "paperreview.json",
  "newscalendar.json",
];

/*
 * Where a host usually mounts the folder that outlives a release. STATE_DIR
 * always wins; these are only tried when it is unset, so a provider that mounts
 * the folder at the usual path needs no environment variable at all — and a
 * machine without such a folder is untouched.
 */
const DEFAULT_MOUNTS = ["/data"];

/*
 * What the last prepare() managed to do, so a host can be asked the one question
 * that matters after a redeploy: did the ledger actually land on the mounted
 * folder, or is this run writing to the disposable build directory? /api/health
 * reports it; a silent fallback is exactly the failure that looks like "the
 * settings reset themselves".
 */
let last = { dir: null, requested: null, auto: false, files: 0, error: null };

function codeRoot() {
  return path.join(__dirname, "..");
}

/**
 * The path to read and write one state file. Ask at call time: prepare() runs
 * before the app serves anything, and this is what makes the answer matter.
 */
function file(name) {
  return path.join(last.dir || codeRoot(), name);
}

function status() {
  return {
    mode: last.dir ? "persistent" : "local",
    dir: last.dir,
    requested: last.requested,
    auto: last.auto,
    files: last.files,
    error: last.error,
  };
}

/**
 * Point the state files at `dir` and carry over anything already on the
 * disposable disk, so switching this on cannot lose a ledger. Safe to run on
 * every boot: a file the folder already has is left exactly as it is.
 */
function prepare(options = {}) {
  const dirOption = options.dir !== undefined ? options.dir : process.env.STATE_DIR;
  const root = options.root ? path.resolve(options.root) : codeRoot();

  let dir = dirOption ? path.resolve(dirOption) : null;
  let auto = false;
  if (!dir) {
    const candidates = options.candidates || DEFAULT_MOUNTS;
    const mount = candidates.find((candidate) => {
      try {
        return fs.statSync(candidate).isDirectory();
      } catch {
        return false;
      }
    });
    if (!mount) {
      last = { dir: null, requested: null, auto: false, files: 0, error: null };
      return null;
    }
    dir = path.resolve(mount);
    auto = true;
  }

  last = { dir: null, requested: dir, auto, files: 0, error: null };

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    last.error = err.message;
    console.error(`State folder: could not create ${dir} (${err.message}). Using local files.`);
    return null;
  }

  // A folder that exists but cannot be written is no better than no folder, and
  // mkdir succeeding does not prove the mount is there and ours.
  try {
    const probe = path.join(dir, ".write-probe");
    fs.writeFileSync(probe, String(Date.now()));
    fs.unlinkSync(probe);
  } catch (err) {
    last.error = `not writable (${err.message})`;
    console.error(`State folder: ${dir} is not writable (${err.message}). Using local files.`);
    return null;
  }

  let present = 0;
  for (const name of FILES) {
    const target = path.join(dir, name);
    if (fs.existsSync(target)) {
      present += 1;
      continue;
    }
    // Nothing in the folder yet: bring over a file from an earlier run, or from
    // an install that still has links. Reading the code directory is allowed
    // even when writing to it is not.
    try {
      const local = path.join(root, name);
      const stat = fs.lstatSync(local);
      if (stat.isSymbolicLink()) fs.copyFileSync(fs.realpathSync(local), target);
      else if (stat.isFile()) fs.copyFileSync(local, target);
      else continue;
      present += 1;
    } catch (err) {
      if (err && err.code !== "ENOENT") {
        if (!last.error) last.error = `could not copy ${name} (${err.message})`;
        console.error(`State folder: could not copy ${name} into ${dir} (${err.message}).`);
      }
    }
  }

  if (fs.existsSync(path.join(dir, "settings.json"))) {
    try {
      fs.chmodSync(path.join(dir, "settings.json"), 0o600);
    } catch {}
  }

  last.dir = dir;
  last.files = present;
  console.log(
    `State folder: ${dir}${auto ? " (mounted folder found without STATE_DIR)" : ""} ` +
      `(${present} of ${FILES.length} state files there)`
  );
  return dir;
}

module.exports = { prepare, status, file, FILES };
