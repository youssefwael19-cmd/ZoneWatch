/**
 * Write a JSON file without ever leaving a half-written one behind.
 *
 * These files are symlinked onto the Fly volume, and the write has to resolve
 * the link first: renaming onto the link itself would replace it with a regular
 * file and quietly stop persisting anything across deploys. Writing beside the
 * target and renaming means a process that dies mid-write leaves either the old
 * file or the new one, never a truncated one.
 */

const fs = require("fs");
const path = require("path");

/** The file the bytes really belong to, following a symlink if there is one. */
function realTarget(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    try {
      return path.resolve(path.dirname(file), fs.readlinkSync(file));
    } catch {
      return file;
    }
  }
}

function writeJson(file, value, indent = 2) {
  const target = realTarget(file);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, indent), "utf-8");
  fs.renameSync(tmp, target);
}

module.exports = { writeJson, realTarget };
