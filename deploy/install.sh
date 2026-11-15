#!/usr/bin/env bash
# Install Zone Watch as an always-on service.
#
# Run this on the machine that will stay switched on (a small VPS or a
# Raspberry Pi). It expects the app files to already be in this directory.
#
#   sudo bash deploy/install.sh
#
# It installs dependencies, then sets up a systemd service that starts on boot
# and restarts automatically if it ever crashes.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="zone-watch"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run with sudo: sudo bash deploy/install.sh"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install Node 20 or newer first:"
  echo "  https://nodejs.org/en/download/package-manager"
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "${NODE_MAJOR}" -lt 20 ]; then
  echo "Node ${NODE_MAJOR} is too old. Please install Node 20 or newer."
  exit 1
fi

echo "Installing dependencies in ${APP_DIR}..."
cd "${APP_DIR}"
npm install --omit=dev

echo "Writing ${SERVICE_FILE}..."
sed "s|WorkingDirectory=.*|WorkingDirectory=${APP_DIR}|" \
    "${APP_DIR}/deploy/zone-watch.service" \
    | sed "s|ExecStart=.*|ExecStart=$(command -v node) server/index.js|" \
    > "${SERVICE_FILE}"

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

sleep 2
systemctl --no-pager --lines=15 status "${SERVICE_NAME}" || true

echo
echo "Done. The watcher is now running and will start on boot."
echo "  Follow logs:  journalctl -u ${SERVICE_NAME} -f"
echo "  Stop:         sudo systemctl stop ${SERVICE_NAME}"
echo "  Restart:      sudo systemctl restart ${SERVICE_NAME}"
echo
echo "Open http://<this-machine-ip>:3000 to finish setup (API key, Discord webhook)."
