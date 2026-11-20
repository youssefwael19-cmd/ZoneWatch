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

/**
 * Point each state file at `dir`. Safe to run on every boot: an existing link is
 * left alone, and a plain file from an earlier run is moved into the folder
 * rather than deleted, so switching this on cannot lose a ledger.
 */
function prepare(options = {}) {
  const dirOption = options.dir !== undefined ? options.dir : process.env.STATE_DIR;
  if (!dirOption) return null;

  const dir = path.resolve(dirOption);
  const root = options.root ? path.resolve(options.root) : path.join(__dirname, "..");

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.error(`State folder: could not create ${dir} (${err.message}). Using local files.`);
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
        if (real && path.resolve(real) === target) continue;
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
      console.error(`State folder: could not link ${name} into ${dir} (${err.message}).`);
    }
  }

  if (fs.existsSync(path.join(dir, "settings.json"))) {
    try {
      fs.chmodSync(path.join(dir, "settings.json"), 0o600);
    } catch {}
  }

  console.log(`State folder: ${dir} (${linked} file${linked === 1 ? "" : "s"} linked)`);
  return dir;
}

module.exports = { prepare, FILES };
