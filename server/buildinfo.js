/**
 * Which build is answering, and when did it boot.
 *
 * The problem this solves: after a deploy the only way to tell "the new code is
 * live" from "the old code is still serving" was to infer it from behaviour.
 * That is guesswork, and it made every post-deploy check a maybe. Here the
 * process reports the commit it was built from, the boot it belongs to, and a
 * marker that changes only when the build changes — which is also what the brain
 * uses to decide that a deploy is a reason to re-measure every market.
 *
 * Commit resolution is best-effort on purpose. A host may publish the commit as
 * a variable, may ship a .git directory, or may do neither; when it does
 * neither the answer is honestly "unknown" instead of a guess. The feature list
 * is the fallback marker: a build that has this module at all is a build whose
 * marker says so.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const BOOTED_AT = Date.now();
const BOOT_ID = `${BOOTED_AT.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// Capabilities this build has. Bump by adding, never by editing: the marker for
// a host that reports no commit is the list itself.
const FEATURES = ["bot-journal", "lab-families", "audit-1", "boot-remeasure"];

const COMMIT_ENV = [
  "GIT_COMMIT",
  "SOURCE_VERSION",
  "COMMIT_SHA",
  "RENDER_GIT_COMMIT",
  "VERCEL_GIT_COMMIT_SHA",
  "CF_PAGES_COMMIT_SHA",
  "HEROKU_SLUG_COMMIT",
];

const SHA = /^[0-9a-f]{7,40}$/i;

function read(file) {
  try {
    return fs.readFileSync(file, "utf-8").trim();
  } catch {
    return null;
  }
}

function fromEnv() {
  for (const key of COMMIT_ENV) {
    const value = String(process.env[key] || "").trim();
    if (SHA.test(value)) return { commit: value, source: `env:${key}` };
  }
  return null;
}

function fromGitDir() {
  const root = path.join(__dirname, "..");
  let gitDir = path.join(root, ".git");

  // A worktree, a submodule and some build containers replace the directory
  // with a one-line pointer file: "gitdir: /path/to/real/git/dir".
  const gitFile = read(gitDir);
  if (gitFile && /^gitdir:/i.test(gitFile)) {
    const pointed = gitFile.replace(/^gitdir:\s*/i, "").trim();
    gitDir = path.isAbsolute(pointed) ? pointed : path.resolve(root, pointed);
  }

  const head = read(path.join(gitDir, "HEAD"));
  if (!head) return null;

  // Detached HEAD: the file is the hash.
  if (SHA.test(head)) return { commit: head, source: "git:HEAD" };

  const ref = /^ref:\s*(.+)$/.exec(head);
  if (!ref) return null;
  const name = ref[1].trim();

  // A worktree keeps its own HEAD but borrows the main repository's refs, and
  // says where they are in a one-word file.
  const common = read(path.join(gitDir, "commondir"));
  const refRoots = [gitDir];
  if (common) {
    const resolved = path.isAbsolute(common) ? common : path.resolve(gitDir, common);
    if (!refRoots.includes(resolved)) refRoots.push(resolved);
  }

  for (const root of refRoots) {
    const loose = read(path.join(root, name));
    if (loose && SHA.test(loose)) return { commit: loose, source: `git:${name}` };
  }

  // Packed refs: "sha refname" per line, newest on top.
  for (const root of refRoots) {
    const packed = read(path.join(root, "packed-refs"));
    if (!packed) continue;
    const line = packed.split("\n").find((l) => l.endsWith(` ${name}`));
    if (!line) continue;
    const sha = line.split(" ")[0].trim();
    if (SHA.test(sha)) return { commit: sha, source: `git:packed-refs ${name}` };
  }

  return null;
}

/**
 * Last resort: ask git. Costs one process at boot and is cached with the rest,
 * so a host that ships the repository but no readable refs still reports a
 * commit instead of "unknown".
 */
function fromGitCommand() {
  try {
    const { execFileSync } = require("child_process");
    const out = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: path.join(__dirname, ".."),
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    }).trim();
    return SHA.test(out) ? { commit: out, source: "git:rev-parse" } : null;
  } catch {
    return null;
  }
}

let cached = null;

function resolve() {
  if (cached) return cached;
  const found = fromEnv() || fromGitDir() || fromGitCommand();
  cached = found || { commit: null, source: "unknown" };
  return cached;
}

/**
 * A fingerprint of the code that decides trading: every server module plus the
 * dependency list. Independent of git, so a host that ships neither .git nor a
 * commit variable can still say exactly which build is answering — and two
 * machines with the same tree compute the same value.
 *
 * Only server/*.js and package.json are hashed on purpose. A dashboard-only
 * change does not alter a single number the brain produced, so it must not
 * invalidate eleven markets of measurement.
 */
let fingerprintCache = null;

function codeFingerprint() {
  if (fingerprintCache) return fingerprintCache;
  try {
    const hash = crypto.createHash("sha256");
    const dir = __dirname;
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".js"))
      .sort();
    for (const name of files) {
      hash.update(`${name}:`);
      hash.update(fs.readFileSync(path.join(dir, name)));
      hash.update("\n");
    }
    try {
      hash.update("package.json:");
      hash.update(fs.readFileSync(path.join(dir, "..", "package.json")));
    } catch {}
    fingerprintCache = hash.digest("hex").slice(0, 16);
  } catch (err) {
    fingerprintCache = `unreadable-${BOOT_ID}`;
  }
  return fingerprintCache;
}

/**
 * Changes when the build changes, and only then. Plain restarts of the same
 * build keep the same marker, which is what stops a crash loop from putting the
 * brain through an eleven-market re-measure on every boot.
 *
 * The commit is preferred because it is the thing a person can look up. When the
 * host publishes neither a commit nor a repository, the code fingerprint takes
 * over: it changes on exactly the edits that could change a measurement.
 */
function marker() {
  const found = resolve();
  return found.commit ? `commit:${found.commit}` : `code:${codeFingerprint()}`;
}

function get() {
  const found = resolve();
  return {
    commit: found.commit,
    commitSource: found.source,
    short: found.commit ? found.commit.slice(0, 7) : "unknown",
    marker: marker(),
    codeFingerprint: codeFingerprint(),
    bootId: BOOT_ID,
    bootedAt: new Date(BOOTED_AT).toISOString(),
    uptimeSeconds: Math.round((Date.now() - BOOTED_AT) / 1000),
    node: process.version,
    features: FEATURES.slice(),
  };
}

module.exports = { get, marker, FEATURES };
