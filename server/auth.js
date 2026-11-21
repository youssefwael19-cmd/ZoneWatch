/**
 * One password between the internet and the trading account.
 *
 * The dashboard can turn auto-trading on, switch it to a live broker and fire
 * the kill switch, so it cannot be open to anyone who has the URL. There is one
 * account (yours): a scrypt hash in settings.json, and a signed, httpOnly
 * session cookie so the phone stays signed in. No user database, no email.
 */

const crypto = require("crypto");

const SESSION_COOKIE = "zw_session";
const SESSION_DAYS = 60;
const MIN_PASSWORD = 8;

/* ------------------------------------------------------------------- hashes -- */

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 64).toString("hex") };
}

function createAuth(password) {
  const { salt, hash } = hashPassword(password);
  return {
    salt,
    hash,
    // Signing key for session cookies. Kept so a restart does not sign everyone
    // out; rotating the password leaves it alone for the same reason.
    secret: crypto.randomBytes(32).toString("hex"),
    createdAt: new Date().toISOString(),
  };
}

/**
 * The recovery password, if the server was given one.
 *
 * The hash in settings.json is the real password, but a forgotten one can only
 * be cleared by editing that file on the host. On a hosted deployment the owner
 * often has no shell to do it with, so a lockout there is permanent — and the
 * dashboard is the only way to reach the broker, the risk rules and the kill
 * switch. ZW_DASH_PASSWORD is the way back in: when it is set and at least
 * MIN_PASSWORD long, it becomes the dashboard password on start-up.
 *
 * It is deliberately not a reset form on the public site: anyone who finds the
 * URL could use that to lock the owner out. A server variable can only be set
 * by the person who owns the server.
 */
function envPassword() {
  const value = String(process.env.ZW_DASH_PASSWORD || "").trim();
  return value.length >= MIN_PASSWORD ? value : "";
}

/** Constant-time string comparison, so a wrong guess cannot be timed. */
function sameSecret(a, b) {
  const left = crypto.createHash("sha256").update(String(a)).digest();
  const right = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

/**
 * A fingerprint of the variable's value, so a value the owner has already moved
 * past can be recognised on a later start without keeping the password itself.
 * Costs the same as the stored hash, so it cannot be guessed faster either.
 */
function envFingerprint(record, value) {
  const salt = (record && record.salt) || "zw-env";
  return crypto.scryptSync(String(value), `env:${salt}`, 32).toString("hex");
}

/** Has a password set in the dashboard already replaced this exact value? */
function envSpent(record, value) {
  if (!record || !record.envSpent) return false;
  const known = Buffer.from(record.envSpent, "hex");
  const given = Buffer.from(envFingerprint(record, value), "hex");
  return known.length === given.length && crypto.timingSafeEqual(known, given);
}

/**
 * Is `password` the value of `ZW_DASH_PASSWORD`? The variable is a password in
 * its own right, not only a boot-time copy of one.
 *
 * Adoption rewrites settings.json on start-up, and that write can fail (a
 * read-only disk) or never happen (the app was not restarted after the value
 * was added). Treating the variable as an accepted credential means the way
 * back in works on the first try instead of depending on a file write: whoever
 * can set the server's environment is the owner. A value the owner has already
 * replaced from the dashboard is not accepted, so a host that keeps injecting
 * an old variable cannot keep a retired password alive.
 */
function envAccepted(password, record) {
  const value = envPassword();
  if (!value) return false;
  if (envSpent(record, value)) return false;
  return sameSecret(password, value);
}

/**
 * Adopt `ZW_DASH_PASSWORD` as the dashboard password, keeping the cookie-signing
 * secret so a restart does not sign every device out. Returns true when it wrote
 * a new record. Passed the getters/setters so this stays testable on its own.
 */
function adoptEnvPassword(getAuth, setAuth, out = console) {
  const value = envPassword();
  if (!value) {
    if (String(process.env.ZW_DASH_PASSWORD || "").trim()) {
      out.warn(`[auth] ZW_DASH_PASSWORD is shorter than ${MIN_PASSWORD} characters and was ignored`);
    }
    return false;
  }
  const current = getAuth();
  if (current && verifyPassword(value, current)) return false;
  if (current && envSpent(current, value)) {
    // The owner set their own password after this value was put there, and the
    // host is still handing it to every new process (a delete that never
    // reached the deployment). Overwriting would undo their password on every
    // restart, which is the one thing recovery must never do.
    out.log(
      "[auth] ZW_DASH_PASSWORD was replaced by a password set in the dashboard earlier; leaving it alone (change the variable to a new value to use it again)"
    );
    return false;
  }
  const fresh = createAuth(value);
  if (current && current.secret) fresh.secret = current.secret;
  try {
    setAuth(fresh);
  } catch (err) {
    // Starting beats recovering. A read-only disk, a full disk or a missing
    // state folder must not stop the process from booting: the app comes up
    // exactly as locked as it already was, and the reason is in the log rather
    // than in a crash loop nobody can reach to read.
    out.warn(
      `[auth] could not save ZW_DASH_PASSWORD (${(err && err.message) || err}); starting locked with the password already on file`
    );
    return false;
  }
  out.log(
    "[auth] dashboard password adopted from ZW_DASH_PASSWORD — change it in Settings (and unset the variable) when you are back in"
  );
  return true;
}

function verifyPassword(password, record) {
  if (!record || !record.salt || !record.hash) return false;
  const known = Buffer.from(record.hash, "hex");
  const candidate = crypto.scryptSync(String(password), record.salt, 64);
  return known.length === candidate.length && crypto.timingSafeEqual(known, candidate);
}

/* ------------------------------------------------------------------ cookies -- */

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    out[name] = part.slice(index + 1).trim();
  }
  return out;
}

function sign(record, expires) {
  return crypto.createHmac("sha256", record.secret).update(`v1:${expires}`).digest("hex");
}

function isSecure(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  return Boolean(req.secure) || proto === "https";
}

function isSignedIn(req, record) {
  if (!record || !record.secret) return false;
  const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!raw) return false;
  const [expiresText, signature] = raw.split(".");
  const expires = Number(expiresText);
  if (!Number.isFinite(expires) || expires < Date.now() || !signature) return false;
  const expected = Buffer.from(sign(record, expires), "hex");
  const given = Buffer.from(signature, "hex");
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/** When the cookie on this request stops being valid, or null. */
function sessionExpiry(req, record) {
  if (!record || !record.secret) return null;
  const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!raw) return null;
  const expires = Number(String(raw).split(".")[0]);
  if (!Number.isFinite(expires) || expires < Date.now()) return null;
  return expires;
}

function sessionCookie(req, record) {
  const expires = Date.now() + SESSION_DAYS * 86400000;
  const parts = [
    `${SESSION_COOKIE}=${expires}.${sign(record, expires)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_DAYS * 86400}`,
  ];
  if (isSecure(req)) parts.push("Secure");
  return parts.join("; ");
}

function clearCookie(req) {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (isSecure(req)) parts.push("Secure");
  return parts.join("; ");
}

/* ---------------------------------------------------------------- attempts -- */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 8;
const failures = new Map();

function clientKey(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.ip || "unknown";
}

/** Refuse to guess. Returns false once this address has used up its tries. */
function allowAttempt(req) {
  const key = clientKey(req);
  const now = Date.now();
  const entry = failures.get(key);
  if (!entry || now - entry.first > WINDOW_MS) {
    failures.set(key, { count: 0, first: now });
    return true;
  }
  return entry.count < MAX_FAILURES;
}

function noteFailure(req) {
  const key = clientKey(req);
  const now = Date.now();
  const entry = failures.get(key);
  if (!entry || now - entry.first > WINDOW_MS) failures.set(key, { count: 1, first: now });
  else entry.count += 1;
}

function noteSuccess(req) {
  failures.delete(clientKey(req));
}

/* ------------------------------------------------------------------- pages -- */

const STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: radial-gradient(circle at 20% 0%, #16233a 0%, #0a1120 55%, #070c15 100%);
    color: #e6eef7; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    padding: 24px;
  }
  .card {
    width: 100%; max-width: 380px; background: #111a2b; border: 1px solid #1f2c42;
    border-radius: 14px; padding: 26px 24px; box-shadow: 0 20px 60px rgba(0,0,0,.45);
  }
  h1 { font-size: 19px; margin: 0 0 4px; letter-spacing: -.01em; }
  p.sub { margin: 0 0 20px; color: #9fb3c8; font-size: 13px; }
  label { display: block; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #9fb3c8; margin-bottom: 6px; }
  input {
    width: 100%; padding: 12px 13px; margin-bottom: 14px; border-radius: 9px;
    border: 1px solid #26374f; background: #0b1420; color: #e6eef7; font-size: 16px;
  }
  input:focus { outline: 2px solid #7ff0cf55; border-color: #7ff0cf; }
  button {
    width: 100%; padding: 12px 14px; border: 0; border-radius: 9px; cursor: pointer;
    background: #7ff0cf; color: #062018; font-size: 15px; font-weight: 650;
  }
  button:disabled { opacity: .6; cursor: progress; }
  .msg { min-height: 20px; margin-top: 12px; font-size: 13px; color: #ff9a9a; }
  .hint { margin-top: 16px; font-size: 12px; color: #7d90a6; }
`;

function page({ mode, envManaged = false }) {
  const setup = mode === "setup";
  const title = setup ? "Protect the dashboard" : "Zone Watch";
  const sub = setup
    ? "Choose a password. It is the only thing standing between the internet and your trading account."
    : "Sign in to reach the dashboard.";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#0a1120" />
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<main class="card">
  <h1>${title}</h1>
  <p class="sub">${sub}</p>
  <form id="form">
    <label for="password">Password</label>
    <input id="password" type="password" autocomplete="${setup ? "new-password" : "current-password"}" required minlength="8" />
    ${setup ? `<label for="confirm">Password again</label>
    <input id="confirm" type="password" autocomplete="new-password" required minlength="8" />` : ""}
    <button id="go" type="submit">${setup ? "Set password" : "Unlock"}</button>
  </form>
  <div class="msg" id="msg"></div>
  <div class="hint">${
    setup
      ? "At least 8 characters. Nothing is stored in the phone; the password is checked on the server."
      : envManaged
        ? "This password comes from <code>ZW_DASH_PASSWORD</code> on the server, so it survives restarts. Type the <em>value</em> you gave that variable — its name is not the password."
        : "Forgot it? Set <code>ZW_DASH_PASSWORD</code> on the server, or remove the <code>auth</code> block from settings.json, and restart."
  }</div>
</main>
<script>
  const form = document.getElementById("form");
  const msg = document.getElementById("msg");
  const go = document.getElementById("go");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const password = document.getElementById("password").value;
    const confirm = document.getElementById("confirm");
    if (confirm && confirm.value !== password) {
      msg.textContent = "the two passwords do not match";
      return;
    }
    go.disabled = true;
    msg.textContent = "";
    try {
      const res = await fetch("${setup ? "/api/auth/setup" : "/api/auth/login"}", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        window.location.href = "/";
        return;
      }
      msg.textContent = data.error || "could not sign in";
    } catch (err) {
      msg.textContent = "the server did not answer";
    }
    go.disabled = false;
  });
</script>
</body>
</html>`;
}

module.exports = {
  MIN_PASSWORD,
  createAuth,
  envPassword,
  envAccepted,
  envFingerprint,
  envSpent,
  adoptEnvPassword,
  hashPassword,
  verifyPassword,
  isSignedIn,
  sessionExpiry,
  sessionCookie,
  clearCookie,
  allowAttempt,
  noteFailure,
  noteSuccess,
  page,
  parseCookies,
  SESSION_COOKIE,
};
