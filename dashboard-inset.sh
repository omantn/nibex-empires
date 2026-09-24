#!/usr/bin/env bash
# Set the TV dashboard's safe-area inset on an installed Pi without re-running setup-pi.sh,
# and make sure the colour emoji font is present (map icons and ticker glyphs need it).
#   ./dashboard-inset.sh 60             one margin for all sides, in pixels
#   ./dashboard-inset.sh 50,80,50,80    top,right,bottom,left
#   ./dashboard-inset.sh 0              back to edge-to-edge
# Tip: try values live first with http://<pi>:3000/dashboard?inset=60 before making one permanent.
set -euo pipefail
UNIT=/etc/systemd/system/nibex.service
inset="${1:-}"
[[ "$inset" =~ ^[0-9]{1,4}(,[0-9]{1,4}){0,3}$ ]] || { echo "Usage: $0 <px> | <top,right,bottom,left>" >&2; exit 1; }
[ -f "$UNIT" ] || { echo "$UNIT not found. Run ./setup-pi.sh first." >&2; exit 1; }

if ! fc-list 2>/dev/null | grep -qi 'NotoColorEmoji'; then
  echo "Installing the colour emoji font..."
  sudo apt-get install -y fonts-noto-color-emoji >/dev/null 2>&1 || echo "Could not install fonts-noto-color-emoji." >&2
fi

if sudo grep -q '^Environment=DASHBOARD_INSET=' "$UNIT"; then
  sudo sed -i "s/^Environment=DASHBOARD_INSET=.*/Environment=DASHBOARD_INSET=$inset/" "$UNIT"
else
  sudo sed -i "/^Environment=PORT=/a Environment=DASHBOARD_INSET=$inset" "$UNIT"
fi
sudo systemctl daemon-reload
sudo systemctl restart nibex
echo "Dashboard inset set to $inset. Reload the dashboard on the TV (or restart its kiosk) to see it."
