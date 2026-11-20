/**
 * Keep the state files on a folder that survives a redeploy.
 *
 * Everything this app remembers is a JSON file next to its code. On a host that
 * rebuilds the code directory on every deploy — ProductEcho, or any buildpack
 * host — those files are part of the disposable build, so the ledger would be
 * wiped each time. Mounting a persistent folder and pointing the files at it is
 * the fix, and it is why this module exists: set STATE_DIR and each state file
 * becomes a symlink into that folder.
 *
 *   STATE_DIR=/data
 *
 * is all a host needs; leave it unset and the files stay exactly where they are
 * today. server/atomicWrite.js already writes through symlinks (it resolves the
 * real target before renaming), so no other module has to know about this.
 *
 * The Dockerfile does the same thing with a RUN of `ln -sf`, for hosts where the
 * image is built ahead of time. This is that, at boot, for hosts that build the
 * code themselves.
 */

const fs = require("fs");
const path = require("path");

// Every file the app treats as state. Adding one here is enough to move it.
const FILES = [
  "settings.json",
  "zones.json",
  "alerts.json",
  "signals.json",
  "recap.json",
  "heartbeat.json",
  "state.json",
  "lab.json",
  "learning.json",
  "health.json",
  "brain.json",
  "journal.json",
  "executor.json",
  "shadow.json",
  "digest.json",
  "dailyrecap.json",
  "paperreview.json",
  "newscalendar.json",
];

/*
 * What the last prepare() managed to do, so a host can be asked the one question
 * that matters after a redeploy: did the ledger actually land on the mounted
 * folder, or is this run writing to the disposable build directory? /api/health
 * reports it; a silent fallback is exactly the failure that looks like "the
 * settings reset themselves".
 */
/*
 * Where a host usually mounts the folder that outlives a release. STATE_DIR
 * always wins; these are only tried when it is unset, so a provider that mounts
 * the folder at the usual path needs no environment variable at all -- and a
 * machine without such a folder is untouched.
 */
const DEFAULT_MOUNTS = ["/data"];

let last = { dir: null, requested: null, auto: false, linked: 0, error: null };

function status() {
  return {
    // Half a set of links is not persistence: the files that lost their link are
    // still on the disposable disk, so report it as local and say why.
    mode: last.dir && last.linked === FILES.length ? "persistent" : "local",
    dir: last.dir,
    requested: last.requested,
    auto: last.auto,
    linked: last.linked,
    error: last.error,
  };
}

/**
 * Point each state file at `dir`. Safe to run on every boot: an existing link is
 * left alone, and a plain file from an earlier run is moved into the folder
 * rather than deleted, so switching this on cannot lose a ledger.
 */
function prepare(options = {}) {
  const dirOption = options.dir !== undefined ? options.dir : process.env.STATE_DIR;
  const root = options.root ? path.resolve(options.root) : path.join(__dirname, "..");

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
      last = { dir: null, requested: null, auto: false, linked: 0, error: null };
      return null;
    }
    dir = path.resolve(mount);
    auto = true;
  }

  last = { dir: null, requested: dir, auto, linked: 0, error: null };

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

  let linked = 0;
  for (const name of FILES) {
    const target = path.join(dir, name);
    const link = path.join(root, name);

    let stat = null;
    try {
      stat = fs.lstatSync(link);
    } catch {}

    try {
      if (stat && stat.isSymbolicLink()) {
        let real = null;
        try {
          real = fs.realpathSync(link);
        } catch {}
        if (real && path.resolve(real) === target) {
          linked += 1;
          continue;
        }
        fs.unlinkSync(link);
      } else if (stat) {
        // A real file from a previous run (or a fresh checkout): keep its
        // contents by moving it in, unless the folder already has a newer copy.
        if (fs.existsSync(target)) fs.unlinkSync(link);
        else fs.renameSync(link, target);
      }
      fs.symlinkSync(target, link);
      linked += 1;
    } catch (err) {
      // The code directory can be read-only once the app runs as the folder's
      // owner, which is worth reporting rather than only logging.
      if (!last.error) last.error = `could not link ${name} (${err.message})`;
      console.error(`State folder: could not link ${name} into ${dir} (${err.message}).`);
    }
  }

  if (fs.existsSync(path.join(dir, "settings.json"))) {
    try {
      fs.chmodSync(path.join(dir, "settings.json"), 0o600);
    } catch {}
  }

  last.dir = dir;
  last.linked = linked;
  console.log(
    `State folder: ${dir}${auto ? " (mounted folder found without STATE_DIR)" : ""} ` +
      `(${linked} file${linked === 1 ? "" : "s"} linked)`
  );
  return dir;
}

module.exports = { prepare, status, FILES };
