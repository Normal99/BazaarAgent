#!/usr/bin/env bash
# Install BazaarAgent as systemd *user* units.
#
# User units rather than system units on purpose: the credentials live in
# ~/.bazaaragent, the agent is a personal tool, and nothing here needs root.
# The trade-off is that user units stop at logout unless lingering is enabled —
# which the script offers, since a deal watcher that only runs while you are
# logged in is not much of a watcher.
set -euo pipefail

REPO="$(cd "$(dirname "$(readlink -f "$0")")/../../.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SRC="$REPO/packages/agent/systemd"

if [ ! -x "$REPO/bazaar" ]; then
  echo "Expected an executable at $REPO/bazaar — run this from a checkout." >&2
  exit 1
fi

# The units reference %h/BazaarAgent. If the checkout lives elsewhere, rewrite
# that rather than silently installing units that point at nothing.
mkdir -p "$UNIT_DIR"
for unit in bazaar-sweep.service bazaar-sweep.timer bazaar-web.service; do
  sed "s|%h/BazaarAgent|$REPO|g" "$SRC/$unit" > "$UNIT_DIR/$unit"
  echo "installed $UNIT_DIR/$unit"
done

systemctl --user daemon-reload
systemctl --user enable --now bazaar-sweep.timer
systemctl --user enable --now bazaar-web.service

echo
systemctl --user list-timers bazaar-sweep.timer --no-pager || true
echo
echo "Web UI:  http://localhost:3100"
echo "Phone:   http://$(cat /proc/sys/kernel/hostname):3100  (over Tailscale)"
echo
echo "Logs:    journalctl --user -u bazaar-sweep -f"
echo "Stop:    systemctl --user disable --now bazaar-sweep.timer bazaar-web.service"

if ! loginctl show-user "$USER" 2>/dev/null | grep -q "Linger=yes"; then
  echo
  echo "Note: user units stop when you log out. To keep sweeping regardless:"
  echo "  sudo loginctl enable-linger $USER"
fi
