/**
 * Small persistent state for the watcher.
 *
 * Without this, every deploy resets the "already alerted" memory and the same
 * zone alerts fire again. That was showing up as duplicate Discord messages
 * after each restart.
 */

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "state.json");

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
    fs.writeFileSync(FILE, JSON.stringify(state), "utf-8");
  } catch {}
}

module.exports = { load, save, FILE };
