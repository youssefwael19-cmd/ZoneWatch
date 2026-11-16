#!/usr/bin/env node
/**
 * Turn a cTrader application into a working connection, in one command.
 *
 * cTrader's OAuth flow is: open a consent URL, approve, get a one-time code back
 * on your redirect URL, exchange that code for an access token (30 days) plus a
 * refresh token (the adapter renews from it, so the app runs unattended). This
 * script does the URL, the exchange, finds your ctidTraderAccountId over the
 * trading socket, saves everything the app needs, and then proves the
 * connection by reading the account.
 *
 *   node scripts/ctrader-auth.js --client-id ID --client-secret SECRET \
 *     --redirect-uri https://example.com/callback
 *
 * Useful flags:
 *   --code <code|full redirect URL>   skip the prompt
 *   --account <ctidTraderAccountId>   skip discovery / choose between accounts
 *   --environment practice|live       skip environment detection
 *   --print-only                      do not write settings.json
 *   --token-url <url>                 for tests; defaults to ctrader.com
 *
 * Nothing is sent anywhere except ctrader.com. Nothing secret is printed.
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");

// `| head` and friends close the pipe early; that is not an error worth a stack.
process.stdout.on("error", (err) => {
  if (err && err.code === "EPIPE") process.exit(0);
});

const CONSENT_URL = "https://id.ctrader.com/my/settings/openapi/grantingaccess/";
const TOKEN_URL = "https://openapi.ctrader.com/apps/token";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function consentUrl({ clientId, redirectUri }) {
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "accounts",
    product: "web",
  });
  return `${CONSENT_URL}?${query.toString()}`;
}

async function exchange({ clientId, clientSecret, redirectUri, code, tokenUrl = TOKEN_URL }) {
  const query = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(`${tokenUrl}?${query.toString()}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.accessToken) {
    const reason = data.error_description || data.error || `HTTP ${res.status}`;
    throw new Error(`the token endpoint refused the code: ${reason}`);
  }
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresIn: data.expiresIn,
  };
}

/** The redirect URL carries the code as ?code=…; accept a pasted URL too. */
function codeFrom(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.includes("code=")) {
    try {
      return new URL(text).searchParams.get("code") || "";
    } catch {
      const match = text.match(/[?&]code=([^&]+)/);
      return match ? decodeURIComponent(match[1]) : "";
    }
  }
  return text;
}

/**
 * A piped line is just as good as a typed one, so `echo CODE | node …` works.
 * Readline is only used when there is a real terminal to prompt in; when the
 * input is a pipe it is read straight from descriptor 0, which cannot race the
 * prompt for the line.
 */
function ask(question) {
  if (!process.stdin.isTTY) {
    try {
      return Promise.resolve(String(fs.readFileSync(0, "utf-8")).split(/\r?\n/)[0].trim());
    } catch {
      return Promise.resolve("");
    }
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function mask(token) {
  const text = String(token || "");
  if (text.length <= 8) return "••••";
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

function credentials({ clientId, clientSecret, tokens, environment, accountId, baseUrl }) {
  return {
    direct: {
      provider: "ctrader",
      clientId,
      clientSecret,
      token: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      environment,
      accountId,
      ...(baseUrl ? { baseUrl } : {}),
    },
  };
}

/**
 * Ask the broker which accounts this token can trade. The token belongs to one
 * platform (demo or live), so both hosts are tried unless one is named.
 */
async function discoverAccount({ clientId, clientSecret, tokens, environment, baseUrl }) {
  const ctrader = require(path.join(__dirname, "..", "server", "brokers", "ctrader"));
  const hosts = environment ? [environment] : ["practice", "live"];
  const failures = [];
  for (const host of hosts) {
    const config = credentials({ clientId, clientSecret, tokens, environment: host, baseUrl });
    const res = await ctrader.listAccounts(config);
    if (res.ok && res.accounts.length) {
      return { ok: true, environment: host, accounts: res.accounts };
    }
    failures.push(`${host}: ${res.ok ? "no accounts on this token" : res.error}`);
  }
  return { ok: false, error: failures.join("; ") };
}

/** Read the account back, the same call the app's Read account button makes. */
async function verify({ clientId, clientSecret, tokens, environment, accountId, baseUrl }) {
  const ctrader = require(path.join(__dirname, "..", "server", "brokers", "ctrader"));
  const config = credentials({ clientId, clientSecret, tokens, environment, accountId, baseUrl });
  return ctrader.account(config);
}

function save({ clientId, clientSecret, tokens, environment, accountId, baseUrl }) {
  const settings = require(path.join(__dirname, "..", "server", "settings"));
  settings.setExecConfig(
    credentials({ clientId, clientSecret, tokens, environment, accountId, baseUrl })
  );
  return path.join(__dirname, "..", "settings.json");
}

function money(amount, currency) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return String(amount);
  return `${currency ? `${currency} ` : ""}${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const clientId = String(args["client-id"] || process.env.CTRADER_CLIENT_ID || "").trim();
  const clientSecret = String(args["client-secret"] || process.env.CTRADER_CLIENT_SECRET || "").trim();
  const redirectUri = String(args["redirect-uri"] || process.env.CTRADER_REDIRECT_URI || "").trim();
  const tokenUrl = String(args["token-url"] || TOKEN_URL);
  const baseUrl = args["base-url"] ? String(args["base-url"]) : "";
  const wantedAccount = String(args.account || "").trim();
  const wantedEnvironment = ["practice", "live"].includes(args.environment)
    ? String(args.environment)
    : "";
  const printOnly = Boolean(args["print-only"]);

  if (!clientId || !clientSecret || !redirectUri) {
    console.error(
      [
        "Missing credentials.",
        "",
        "  node scripts/ctrader-auth.js \\",
        "    --client-id <from openapi.ctrader.com> \\",
        "    --client-secret <from openapi.ctrader.com> \\",
        "    --redirect-uri <the exact redirect URL on the application>",
        "",
        "Optional: --code <code> to skip the prompt, --account <id> if you already",
        "know your ctidTraderAccountId, --print-only to leave settings.json alone.",
      ].join("\n")
    );
    process.exitCode = 1;
    return;
  }

  const url = consentUrl({ clientId, redirectUri });

  let rawCode = args.code ? codeFrom(args.code) : "";
  if (!rawCode) {
    console.log("1. Open this URL, sign in with the cTrader account you want to trade, and approve:\n");
    console.log(`   ${url}\n`);
    console.log("2. The browser lands on your redirect URL. Copy the whole address (or just the code).\n");
    rawCode = codeFrom(await ask("Paste the redirect URL or code: "));
  }
  if (!rawCode) {
    console.error("No code was given, so there is nothing to exchange.");
    process.exitCode = 1;
    return;
  }

  let tokens;
  try {
    tokens = await exchange({ clientId, clientSecret, redirectUri, code: rawCode, tokenUrl });
  } catch (err) {
    console.error(`\n${err.message}`);
    console.error(
      "Codes are single-use and short-lived: open the consent URL again and use the fresh one."
    );
    process.exitCode = 1;
    return;
  }

  console.log("\nCredentials received:");
  console.log(`  access token   ${mask(tokens.accessToken)}  (about 30 days)`);
  console.log(`  refresh token  ${mask(tokens.refreshToken)}  (keeps the app running unattended)`);

  // Find the account id, which is the one thing the token endpoint does not tell
  // you: it only comes back over the trading socket.
  let environment = wantedEnvironment || "practice";
  let accountId = wantedAccount;
  let discovered = null;

  if (!accountId || !wantedEnvironment) {
    console.log("\nLooking for the accounts this token can trade…");
    discovered = await discoverAccount({
      clientId,
      clientSecret,
      tokens,
      environment: wantedEnvironment,
      baseUrl,
    });
    if (discovered.ok) {
      environment = discovered.environment;
      const chosen =
        (accountId && discovered.accounts.find((each) => each.accountId === accountId)) ||
        discovered.accounts[0];
      if (!accountId && discovered.accounts.length > 1) {
        console.log("  more than one account is available:");
        for (const each of discovered.accounts) {
          console.log(`    ${each.accountId}  ${each.broker} · login ${each.login || "?"} · ${each.live ? "live" : "demo"}`);
        }
        const answer = await ask(`Which account id? [${chosen.accountId}] `);
        accountId = codeFrom(answer) || chosen.accountId;
      } else {
        accountId = chosen.accountId;
      }
      console.log(
        `  found ${accountId} — ${chosen.broker} · login ${chosen.login || "?"} · ${
          chosen.live ? "live" : "demo"
        }`
      );
    } else {
      console.log(`  could not list accounts (${discovered.error})`);
    }
  }

  if (printOnly) {
    console.log("\n--print-only: nothing was written. Paste these into the Direct broker panel:");
    console.log(`  client ID      ${clientId}`);
    console.log(`  client secret  (the one you passed in)`);
    console.log(`  refresh token  ${mask(tokens.refreshToken)}`);
    console.log(`  account ID     ${accountId || "(discovery did not find one)"}`);
    return;
  }

  const file = save({
    clientId,
    clientSecret,
    tokens,
    environment,
    accountId: accountId || undefined,
    baseUrl,
  });
  console.log(`\nSaved to ${path.basename(file)}:`);
  console.log(`  provider       ctrader`);
  console.log(`  environment    ${environment}${environment === "practice" ? " (demo)" : ""}`);
  console.log(`  account ID     ${accountId || "(not set — enter it in the panel)"}`);
  console.log(`  client ID      ${clientId}`);

  if (!accountId) {
    console.log("\nEnter the ctidTraderAccountId in the Direct broker panel, or re-run with");
    console.log("--account <id>. The tokens are saved either way.");
    return;
  }

  console.log("\nChecking the connection…");
  const check = await verify({
    clientId,
    clientSecret,
    tokens,
    environment,
    accountId,
    baseUrl,
  });
  if (!check.ok) {
    console.log(`  not verified: ${check.error}`);
    console.log("\nThe credentials are saved. Press Test broker API in the app once the");
    console.log("network is reachable from wherever it runs.");
    return;
  }

  const info = check.account || {};
  console.log(`  connected: ${info.server}`);
  console.log(
    `  login ${info.login} · balance ${money(info.balance, info.currency)} · equity ${money(
      info.equity,
      info.currency
    )} · ${(info.positions || []).length} open`
  );
  console.log("\nNext: open the app, choose Mode → Direct broker API, provider cTrader,");
  console.log("and Save. Read account will show these same numbers.");
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.message ? err.message : err);
    process.exitCode = 1;
  });
}

module.exports = { consentUrl, exchange, codeFrom, discoverAccount, verify, save, credentials };
