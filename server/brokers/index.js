/**
 * Broker registry for direct-API execution.
 *
 * The executor asks this for "the broker the user configured" and gets back an
 * object with a fixed shape: account, pricing, place, closeInstrument, test.
 * Nothing else in the app knows which broker is behind it, so a second broker
 * is a new file next to oanda.js plus one line here.
 *
 * MT5 is deliberately not in this list: it is the `bridge` mode, and it stays
 * there because it needs a machine of yours to run on.
 */

const oanda = require("./oanda");
const ctrader = require("./ctrader");

const PROVIDERS = { oanda, ctrader };

const DESCRIPTIONS = {
  oanda: {
    key: "oanda",
    name: oanda.name,
    environments: ["practice", "live"],
    needs: ["accountId", "token"],
    note: "REST + token. Practice and live are separate hosts; a practice token cannot trade live.",
  },
  ctrader: {
    key: "ctrader",
    name: ctrader.name,
    environments: ["practice", "live"],
    needs: ["clientId", "clientSecret"],
    note: "OAuth application + account ID. Access token lasts about 30 days; a refresh token keeps it alive unattended.",
  },
};

function get(config) {
  const direct = (config && config.direct) || {};
  const provider = PROVIDERS[direct.provider];
  return provider || null;
}

function configured(config) {
  const direct = (config && config.direct) || {};
  const provider = PROVIDERS[direct.provider];
  if (!provider) return false;
  // A provider knows its own credential rules: cTrader wants an app plus a
  // token or refresh token, OANDA wants an account id plus a token.
  if (typeof provider.configured === "function") return provider.configured(config);
  const info = DESCRIPTIONS[direct.provider];
  return info.needs.every((field) => Boolean(String(direct[field] || "").trim()));
}

/**
 * Units in one lot for the configured provider. The executor asks this when it
 * has to check a size against the broker's minimum, before sending anything.
 */
function unitsPerLot(symbol, config) {
  const provider = get(config) || PROVIDERS.oanda;
  return provider.unitsPerLot(symbol);
}

function list() {
  return Object.values(DESCRIPTIONS);
}

module.exports = { get, configured, list, unitsPerLot, PROVIDERS, DESCRIPTIONS };
