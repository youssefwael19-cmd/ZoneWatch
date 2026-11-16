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

function page({ mode }) {
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
      : "Forgot it? Remove the <code>auth</code> block from settings.json on the server to start over."
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
  hashPassword,
  verifyPassword,
  isSignedIn,
  sessionCookie,
  clearCookie,
  allowAttempt,
  noteFailure,
  noteSuccess,
  page,
  parseCookies,
  SESSION_COOKIE,
};
