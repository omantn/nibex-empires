#!/usr/bin/env bash
# Launches the Nibex starfield across every connected display: one Chromium kiosk per screen,
# each showing its slice of one shared virtual sky. Settings come from stars.conf next to this file.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIRECTION=left   # left | right = side windows, parallax drift; forward | backward = flying, vanishing point between the TVs
SPEED=1          # motion multiplier
MODE=            # legacy, ignored when DIRECTION is set
GAP=0            # pixels of wall between the TVs, so stars cross the gap realistically
ORDER=normal     # reverse if the TVs are swapped relative to the desktop layout
COUNT=           # override star count (blank = automatic)
[ -f "$DIR/stars.conf" ] && . "$DIR/stars.conf"

export DISPLAY="${DISPLAY:-:0}"
for c in chromium chromium-browser google-chrome; do
  if command -v "$c" >/dev/null; then CHROME="$c"; break; fi
done
[ -n "${CHROME:-}" ] || { echo "Chromium not found. Install it with: sudo apt install chromium" >&2; exit 1; }

# Wait for the desktop (up to 2 minutes at boot).
for _ in $(seq 1 60); do xrandr -q >/dev/null 2>&1 && break; sleep 2; done
xrandr -q >/dev/null 2>&1 || { echo "No display server reachable on $DISPLAY" >&2; exit 1; }

# Connected outputs as WxH+X+Y, ordered left to right on the desktop.
mapfile -t SCREENS < <(xrandr -q | awk '/ connected/ { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+x[0-9]+\+[0-9]+\+[0-9]+$/) { print $i; break } }' | sort -t+ -k2,2n)
[ "${#SCREENS[@]}" -gt 0 ] || { echo "No connected displays found" >&2; exit 1; }
[ "$ORDER" = reverse ] && mapfile -t SCREENS < <(printf '%s\n' "${SCREENS[@]}" | tac)

# Virtual sky: all screens side by side with GAP pixels of wall between them.
TW=0; TH=0
for g in "${SCREENS[@]}"; do
  w=${g%%x*}; rest=${g#*x}; h=${rest%%+*}
  TW=$((TW + w)); [ "$h" -gt "$TH" ] && TH=$h
done
TW=$((TW + GAP * (${#SCREENS[@]} - 1)))

# Keep the screens from blanking while the stars are up (X11 only; harmless elsewhere).
xset s off -dpms 2>/dev/null; xset s noblank 2>/dev/null
command -v unclutter >/dev/null && unclutter -idle 0 -root >/dev/null 2>&1 &

trap 'kill $(jobs -p) 2>/dev/null; exit 0' TERM INT EXIT
VX=0; i=0
for g in "${SCREENS[@]}"; do
  w=${g%%x*}; rest=${g#*x}; h=${rest%%+*}; rest=${rest#*+}; px=${rest%%+*}; py=${rest#*+}
  url="file://$DIR/index.html?x=$VX&y=0&w=$w&h=$h&tw=$TW&th=$TH&dir=$DIRECTION&speed=$SPEED${COUNT:+&count=$COUNT}"
  echo "screen $i: $g -> $url"
  "$CHROME" --ozone-platform=x11 --kiosk --window-position="$px,$py" --window-size="$w,$h" \
    --user-data-dir="/tmp/nibex-stars-$i" --no-first-run --noerrdialogs --disable-infobars \
    --disable-session-crashed-bubble --disable-features=TranslateUI --check-for-update-interval=31536000 \
    --app="$url" >/dev/null 2>&1 &
  VX=$((VX + w + GAP)); i=$((i + 1))
  sleep 1
done
wait
