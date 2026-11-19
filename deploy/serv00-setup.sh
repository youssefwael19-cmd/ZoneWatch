#!/bin/sh
# Put Zone Watch on a free Serv00 account, in one command.
#
#   sh -c "$(curl -fsSL https://raw.githubusercontent.com/youssefwael19-cmd/ZoneWatch/main/deploy/serv00-setup.sh)"
#
# What it does, in order: checks Node, finds (or reserves) a port, downloads the
# code into ~/zone-watch, installs the three libraries it needs, starts it under
# PM2 so it survives a disconnect and restarts after a crash, waits until it
# answers on the port, then points your *.serv00.net address at it and asks
# Let's Encrypt for a certificate.
#
# It is safe to run again: an existing checkout is updated rather than replaced,
# and an already-running watcher is restarted rather than duplicated. Two copies
# would double-post to Discord and keep separate ledgers.
#
# Before this: register at https://www.serv00.com/register-account (no card),
# verify the email, and in the panel set
#   Additional services -> Run your own applications -> Enabled
# or nothing in your home directory is allowed to run.

set -u

APP_DIR="$HOME/zone-watch"
REPO="https://github.com/youssefwael19-cmd/ZoneWatch.git"

say() { printf '\n==> %s\n' "$*"; }
warn() { printf '\n!!  %s\n' "$*" >&2; }
ok() { printf '    %s\n' "$*"; }

# ---------------------------------------------------------------- Node

say "Checking Node.js"
if ! command -v node >/dev/null 2>&1; then
  warn "node is not on your PATH, so nothing can run yet."
  cat <<'EOF'
    In the Serv00 panel open Additional services -> Node.js (or the Node.js
    section of the docs page https://docs.serv00.com/Node.js), pick a current
    LTS release, then log out and back in over SSH and run this again.
EOF
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR:-0}" -lt 18 ]; then
  warn "Node ${NODE_MAJOR} is too old — this app needs 18 or newer (20+ recommended)."
  echo "    Pick a current LTS in the panel's Node.js section and reconnect."
  exit 1
fi
ok "node $(node -v)"

# ---------------------------------------------------------------- port
#
# Serv00 only lets a process listen on a port you have reserved. Prefer PORT
# from the environment, then the first port already reserved, then ask for one.

find_port() {
  devil port list 2>/dev/null \
    | grep -Eo '(^|[^0-9])[1-9][0-9]{3,4}([^0-9]|$)' \
    | grep -Eo '[1-9][0-9]{3,4}' \
    | sort -n | head -1
}

PORT="${PORT:-}"
[ -z "$PORT" ] && PORT="$(find_port || true)"
if [ -z "$PORT" ]; then
  say "No reserved port yet, asking Serv00 for one"
  devil port add tcp random >/dev/null 2>&1 || devil port add random tcp >/dev/null 2>&1 || true
  PORT="$(find_port || true)"
fi
if [ -z "$PORT" ]; then
  warn "I could not reserve a port myself."
  cat <<'EOF'
    In the panel open Port reservation -> + Add port, choose any TCP port
    between 1024 and 64000, then run this command again. It will find it.
EOF
  exit 1
fi
ok "port $PORT"

# ---------------------------------------------------------------- code

if [ -d "$APP_DIR/.git" ]; then
  say "Updating the code in $APP_DIR"
  ( cd "$APP_DIR" && git pull --ff-only ) || warn "Could not fast-forward; keeping the code already there."
else
  say "Downloading the code into $APP_DIR"
  if ! git clone --depth 1 "$REPO" "$APP_DIR"; then
    warn "The download failed."
    cat <<'EOF'
    If ~/zone-watch already holds a copy you made by hand, this command leaves
    it alone on purpose — it will not overwrite a ledger. Remove or rename that
    directory, or pull it yourself, then run this again.
EOF
    exit 1
  fi
fi

cd "$APP_DIR" || exit 1

say "Installing dependencies"
npm install --omit=dev --no-audit --no-fund || { warn "npm install failed. See the error above."; exit 1; }

# ---------------------------------------------------------------- pm2

if ! command -v pm2 >/dev/null 2>&1; then
  say "Installing PM2 (the thing that keeps the watcher running)"
  npm config set prefix "$HOME/.npm-global" >/dev/null 2>&1 || true
  npm install -g pm2 --no-audit --no-fund || { warn "Could not install PM2."; exit 1; }
  export PATH="$HOME/.npm-global/bin:$PATH"
  for rc in "$HOME/.profile" "$HOME/.bashrc"; do
    if [ -f "$rc" ] && ! grep -q '.npm-global/bin' "$rc" 2>/dev/null; then
      echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> "$rc"
    fi
  done
fi
if ! command -v pm2 >/dev/null 2>&1; then
  warn "PM2 installed but is not on PATH in this shell."
  echo "    Run: . ~/.profile    then run this command again."
  exit 1
fi

say "Starting Zone Watch on port $PORT"
if pm2 describe zone-watch >/dev/null 2>&1; then
  PORT="$PORT" NODE_ENV=production pm2 restart zone-watch --update-env >/dev/null || true
  ok "restarted the watcher that was already running"
else
  PORT="$PORT" NODE_ENV=production pm2 start server/index.js --name zone-watch >/dev/null || {
    warn "PM2 could not start the app. Its log is the next thing to read:"
    echo "    pm2 logs zone-watch --lines 40"
    exit 1
  }
  ok "started"
fi
pm2 save >/dev/null 2>&1 || true

# ---------------------------------------------------------------- is it alive

say "Waiting for the app to answer"
tries=0
alive=0
while [ "$tries" -lt 40 ]; do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    alive=1
    break
  fi
  tries=$((tries + 1))
  sleep 1
done
if [ "$alive" = 1 ]; then
  ok "http://127.0.0.1:$PORT/api/health answers"
else
  warn "It has not answered yet — read what it printed:"
  echo "    pm2 logs zone-watch --lines 40"
fi

# ---------------------------------------------------------------- address

DOMAIN="${SITE_DOMAIN:-zone-watch.$(whoami).serv00.net}"

if command -v devil >/dev/null 2>&1; then
  say "Pointing $DOMAIN at port $PORT"
  if devil www list 2>/dev/null | grep -q "$DOMAIN"; then
    ok "$DOMAIN is already set up"
  elif devil www add "$DOMAIN" proxy localhost "$PORT" >/dev/null 2>&1; then
    ok "added the website $DOMAIN (proxy to localhost:$PORT)"
  else
    warn "Could not add the website from here."
    cat <<EOF
    In the panel: WWW websites -> Add new website -> domain $DOMAIN,
    advanced settings, type Proxy, target localhost, port $PORT.
EOF
  fi

  say "Asking Let's Encrypt for a certificate"
  if devil ssl www list 2>/dev/null | grep -q "$DOMAIN"; then
    ok "a certificate for $DOMAIN is already in place"
  elif [ -n "${SITE_IP:-}" ] && devil ssl www add "$SITE_IP" le le "$DOMAIN" >/dev/null 2>&1; then
    ok "certificate issued"
  else
    cat <<EOF
    In the panel: WWW websites -> Manage SSL certificates -> Manage ->
    + Add certificate -> Generate Let's Encrypt certificate -> $DOMAIN.
    Do this before you type the dashboard password anywhere: without it that
    password crosses the internet in clear text.
EOF
  fi
fi

cat <<EOF

==> Done.

    Open https://$DOMAIN
    It will ask for a dashboard password — that is the normal first-run page.
    Then in Settings: paper balance 200, leverage 2000, stop-out 100%,
    risk 0.5%, max positions 2, plus your Twelve Data key and Discord webhook.

    Logs:     pm2 logs zone-watch
    Restart:  pm2 restart zone-watch
    Update:   cd ~/zone-watch && git pull && npm install --omit=dev && pm2 restart zone-watch

    Two things nothing in the app can do for you:
      - After a reboot of the shared server the process needs one
        \`pm2 resurrect\` over SSH.
      - Serv00 deletes a free account after 90 days without a login to the
        panel or over SSH. Put a reminder in your calendar.
EOF
