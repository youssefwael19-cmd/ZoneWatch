/**
 * Supply and demand zone logic.
 *
 * A zone is a price area where you expect a reaction. This module turns a
 * zone boundary plus the current price into a plain-language state, and
 * decides when an alert should fire.
 *
 * States:
 *   inside      - price is trading within the zone
 *   approaching - price is within the alert distance of the zone
 *   near        - price is within 3x the alert distance (early heads-up)
 *   far         - nothing interesting yet
 */

const fs = require("fs");
const path = require("path");
const { writeJson: atomicWriteJson } = require("./atomicWrite");
const crypto = require("crypto");

const ZONES_PATH = require("./stateDir").file("zones.json");
const ALERTS_PATH = require("./stateDir").file("alerts.json");

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf-8").trim();
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  atomicWriteJson(file, value, 2);
}

function loadZones() {
  const zones = readJson(ZONES_PATH, []);
  return Array.isArray(zones) ? zones : [];
}

function saveZones(zones) {
  writeJson(ZONES_PATH, zones);
}

function loadAlerts() {
  const alerts = readJson(ALERTS_PATH, []);
  return Array.isArray(alerts) ? alerts.slice(-200) : [];
}

function appendAlert(alert) {
  const alerts = loadAlerts();
  alerts.push(alert);
  writeJson(ALERTS_PATH, alerts.slice(-200));
  return alert;
}

function saveAlerts(alerts) {
  writeJson(ALERTS_PATH, (alerts || []).slice(-200));
}

/**
 * How many pips/points one unit of price represents, for friendly readouts.
 * Gold and the Nasdaq index both quote in single units, so this is 1:1.
 */
function distanceLabel(distance) {
  if (distance == null) return "—";
  return distance.toFixed(distance >= 100 ? 0 : 1);
}

/**
 * Validate and normalise an incoming zone. Accepts low/high in either order
 * and rejects anything that is not a sane price range.
 */
function normaliseZone(input) {
  const errors = [];
  const symbol = String(input.symbol || "").toUpperCase();
  const type = String(input.type || "").toLowerCase();

  if (!symbol) errors.push("symbol is required");
  if (!["supply", "demand"].includes(type)) {
    errors.push('type must be "supply" or "demand"');
  }

  const low = Number(input.low);
  const high = Number(input.high);

  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    errors.push("low and high must be numbers");
  } else if (low === high) {
    errors.push("low and high must differ");
  }

  if (errors.length) {
    const err = new Error(errors.join("; "));
    err.status = 400;
    throw err;
  }

  const lower = Math.min(low, high);
  const upper = Math.max(low, high);

  return {
    id: input.id || crypto.randomUUID(),
    symbol,
    type,
    low: lower,
    high: upper,
    label: String(input.label || "").trim() || defaultLabel(type, lower, upper),
    notes: String(input.notes || "").trim(),
    alertDistance: Number.isFinite(Number(input.alertDistance))
      ? Math.abs(Number(input.alertDistance))
      : null,
    active: input.active !== false,
    createdAt: input.createdAt || new Date().toISOString(),
  };
}

function defaultLabel(type, low, upper) {
  const kind = type === "supply" ? "Supply" : "Demand";
  return `${kind} ${low}–${upper}`;
}

/**
 * Work out where price sits relative to a zone.
 *
 * `alertDistance` is how close price must get before you are warned. If the
 * zone does not set one, we fall back to roughly 0.1% of the price, which is
 * a sensible default for gold and index CFDs.
 */
function evaluateZone(zone, price) {
  if (!zone.active) {
    return { state: "inactive", distance: null, distanceToEdge: null, side: null };
  }
  if (!Number.isFinite(price)) {
    return { state: "unknown", distance: null, distanceToEdge: null, side: null };
  }

  const alertDistance =
    zone.alertDistance && zone.alertDistance > 0 ? zone.alertDistance : price * 0.001;

  let distanceToEdge = 0;
  let side = "inside";

  if (price > zone.high) {
    distanceToEdge = price - zone.high;
    side = "above";
  } else if (price < zone.low) {
    distanceToEdge = zone.low - price;
    side = "below";
  }

  let state;
  if (side === "inside") {
    state = "inside";
  } else if (distanceToEdge <= alertDistance) {
    state = "approaching";
  } else if (distanceToEdge <= alertDistance * 3) {
    state = "near";
  } else {
    state = "far";
  }

  return {
    state,
    side,
    distanceToEdge,
    alertDistance,
    distance: side === "inside" ? 0 : distanceToEdge,
  };
}

/**
 * Decide whether this reading deserves an alert.
 *
 * A zone fires once when price first touches the band, and does not fire
 * again until price has moved away and come back. That stops the log filling
 * with the same warning every few seconds.
 */
function shouldFire(previousState, zone, evaluation) {
  const isHot = ["approaching", "inside"].includes(evaluation.state);
  const wasHot = ["approaching", "inside"].includes(previousState);

  if (isHot && !wasHot) {
    return evaluation.state === "inside"
      ? `${zone.label}: price is inside the ${zone.type} zone`
      : `${zone.label}: price approaching the ${zone.type} zone`;
  }
  return null;
}

module.exports = {
  loadZones,
  saveZones,
  loadAlerts,
  saveAlerts,
  appendAlert,
  normaliseZone,
  evaluateZone,
  shouldFire,
  distanceLabel,
};
