/**
 * Small persistent state for the watcher.
 *
 * Without this, every deploy resets the "already alerted" memory and the same
 * zone alerts fire again. That was showing up as duplicate Discord messages
 * after each restart.
 */

const fs = require("fs");
const path = require("path");
const { writeJson } = require("./atomicWrite");

const FILE = require("./stateDir").file("state.json");

function load() {
  try {
    const raw = fs.readFileSync(FILE, "utf-8").trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function save(state) {
  try {
    writeJson(FILE, state, 0);
  } catch {}
}

module.exports = { load, save, FILE };
