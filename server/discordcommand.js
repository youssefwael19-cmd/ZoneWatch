/**
 * Discord slash command: /ask.
 *
 * Discord calls the app's HTTPS endpoint for every interaction and signs the
 * request with Ed25519, so the endpoint needs no bot connection and no gateway:
 * verify the signature, acknowledge, then post the assistant's answer as a
 * follow-up webhook message.
 *
 * Only the owner's Discord user id may ask. Every answer spends the owner's
 * model credits, and the endpoint is public by necessity (Discord cannot send
 * a cookie), so the user id is the whole access control.
 *
 * Discord wants an answer to the initial request within 3 seconds; the
 * assistant takes longer, hence the deferred acknowledgement and follow-up.
 */

const crypto = require("crypto");

const API = "https://discord.com/api/v10";
const MAX_CHARS = 1900;

/** Discord's public key is a raw 32-byte Ed25519 key; Node wants SPKI DER. */
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const COMMAND = {
  name: "ask",
  description: "Ask the Zone Watch assistant a question",
  type: 1, // CHAT_INPUT
  options: [
    {
      type: 3, // STRING
      name: "question",
      description: "What you want to know about zones, signals, news or the app",
      required: true,
    },
  ],
};

function keyFrom(publicKeyHex) {
  const clean = String(publicKeyHex || "").trim();
  if (!/^[0-9a-f]{64}$/i.test(clean)) return null;
  try {
    return crypto.createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(clean, "hex")]),
      format: "der",
      type: "spki",
    });
  } catch {
    return null;
  }
}

/**
 * True when the request really came from Discord: the signature covers the
 * timestamp followed by the exact raw body.
 */
function verify(publicKeyHex, rawBody, signature, timestamp) {
  const key = keyFrom(publicKeyHex);
  if (!key || !signature || !timestamp) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ""), "utf8");
  const message = Buffer.concat([Buffer.from(String(timestamp), "utf8"), body]);
  try {
    return crypto.verify(null, message, key, Buffer.from(String(signature), "hex"));
  } catch {
    return false;
  }
}

/** Discord caps a message at 2000 characters; split long answers on lines. */
function pieces(text) {
  const clean = String(text || "").trim() || "(empty answer)";
  if (clean.length <= MAX_CHARS) return [clean];
  const out = [];
  let current = "";
  for (const line of clean.split("\n")) {
    const candidate = current ? current + "\n" + line : line;
    if (candidate.length <= MAX_CHARS) {
      current = candidate;
      continue;
    }
    if (current) out.push(current);
    let rest = line;
    while (rest.length > MAX_CHARS) {
      out.push(rest.slice(0, MAX_CHARS));
      rest = rest.slice(MAX_CHARS);
    }
    current = rest;
  }
  if (current) out.push(current);
  return out;
}

/**
 * Replace the "thinking" placeholder with the answer. The interaction token is
 * valid for 15 minutes and needs no bot token, only the application id.
 */
async function followUp({ applicationId, token, content }) {
  if (!applicationId || !token) throw new Error("missing interaction token");
  for (const piece of pieces(content)) {
    const res = await fetch(`${API}/webhooks/${applicationId}/${token}?wait=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: piece }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Discord follow-up failed (HTTP ${res.status})${body ? ": " + body.slice(0, 120) : ""}`);
    }
  }
}

/** Register /ask globally so it shows up in every server the app is installed in. */
async function register({ appId, botToken }) {
  const id = String(appId || "").trim();
  const token = String(botToken || "").trim();
  if (!/^\d{5,25}$/.test(id)) throw new Error("Application ID looks wrong — it is all digits");
  if (!token) throw new Error("A bot token is needed to register the command");

  const res = await fetch(`${API}/applications/${id}/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bot ${token}` },
    body: JSON.stringify(COMMAND),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`Discord rejected the command (HTTP ${res.status})${body ? ": " + body.slice(0, 140) : ""}`);
  }
  return { name: COMMAND.name, installed: true };
}

module.exports = { verify, followUp, register, pieces, COMMAND, MAX_CHARS };
