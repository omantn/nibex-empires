#!/usr/bin/env bash
# One-shot setup for running Nibex Empires on a Raspberry Pi (or any Debian/Ubuntu box).
# Installs Node if missing, installs dependencies, asks for the admin password,
# and registers a systemd service that starts on boot and restarts on crash.
# Safe to re-run: it updates the service in place.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_USER="${SUDO_USER:-$USER}"
SERVICE=nibex
UNIT=/etc/systemd/system/${SERVICE}.service

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ -f "$APP_DIR/server.js" ] || die "server.js not found next to this script. Run it from the cloned repo."
command -v sudo >/dev/null || die "sudo is required."
command -v systemctl >/dev/null || die "systemd is required (systemctl not found)."

# ---------- Node ----------
NODE_MIN=18
need_node=1
if command -v node >/dev/null; then
  ver="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if [ "$ver" -ge "$NODE_MIN" ]; then need_node=0; else warn "Node $(node -v) is too old (need $NODE_MIN+)."; fi
fi
if [ "$need_node" = 1 ]; then
  say "Node.js $NODE_MIN+ is required."
  read -r -p "Install Node.js 22 from NodeSource now? [Y/n] " ans
  case "${ans:-Y}" in
    [Yy]*) curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
           sudo apt-get install -y nodejs ;;
    *) die "Install Node.js $NODE_MIN+ and re-run." ;;
  esac
fi
NODE_BIN="$(command -v node)"
say "Using Node $(node -v) at $NODE_BIN"

# ---------- Build tools (needed if better-sqlite3 has no prebuilt binary, e.g. 32-bit Pi OS) ----------
if ! dpkg -s build-essential >/dev/null 2>&1 || ! command -v python3 >/dev/null; then
  say "Installing build tools (in case the SQLite module needs compiling)"
  sudo apt-get update -qq
  sudo apt-get install -y build-essential python3
fi

# ---------- Dependencies ----------
say "Installing npm dependencies"
cd "$APP_DIR"
npm install --no-fund --no-audit

say "Running the test suite"
if npm test; then echo "Tests passed."; else warn "Tests failed. Continuing anyway; check the output above."; fi

# ---------- Settings ----------
say "Configuration"
existing_pw=""
existing_port=""
if [ -f "$UNIT" ]; then
  existing_pw="$(sudo grep -oP '^Environment=ADMIN_PASSWORD=\K.*' "$UNIT" || true)"
  existing_port="$(sudo grep -oP '^Environment=PORT=\K.*' "$UNIT" || true)"
fi

while :; do
  if [ -n "$existing_pw" ]; then
    read -r -s -p "Admin password [press Enter to keep the current one]: " pw; echo
    pw="${pw:-$existing_pw}"
  else
    read -r -s -p "Choose the admin password: " pw; echo
  fi
  [ -n "$pw" ] || { warn "Password cannot be empty."; continue; }
  if [ "$pw" != "$existing_pw" ]; then
    read -r -s -p "Confirm password: " pw2; echo
    [ "$pw" = "$pw2" ] || { warn "Passwords do not match."; continue; }
  fi
  break
done

read -r -p "Port [${existing_port:-3000}]: " port
port="${port:-${existing_port:-3000}}"
[[ "$port" =~ ^[0-9]+$ ]] || die "Port must be a number."

# ---------- systemd unit ----------
say "Writing $UNIT"
sudo tee "$UNIT" >/dev/null <<UNITEOF
[Unit]
Description=Nibex Empires game server
After=network-online.target
Wants=network-online.target

[Service]
User=${RUN_USER}
WorkingDirectory=${APP_DIR}
Environment=ADMIN_PASSWORD=${pw}
Environment=PORT=${port}
ExecStart=${NODE_BIN} server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNITEOF
sudo chmod 600 "$UNIT"

say "Enabling and starting the service"
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE" >/dev/null
sudo systemctl restart "$SERVICE"
sleep 2

if systemctl is-active --quiet "$SERVICE"; then
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  say "Nibex is running."
  echo "  Dashboard: http://${ip:-<pi-ip>}:${port}/dashboard"
  echo "  Admin:     http://${ip:-<pi-ip>}:${port}/admin"
  echo "  Join:      http://${ip:-<pi-ip>}:${port}/join"
  echo
  echo "Useful commands:"
  echo "  sudo systemctl status nibex"
  echo "  journalctl -u nibex -f"
  echo "  sudo systemctl restart nibex     (after git pull)"
  echo "  ./setup-pi.sh                    (re-run to change the password or port)"
else
  warn "Service failed to start. Recent log:"
  sudo journalctl -u "$SERVICE" -n 30 --no-pager
  exit 1
fi
