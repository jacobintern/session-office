#!/bin/zsh
# Sets up the local side of Session Office on macOS:
#   ~/.claude/office/            desk cards, inbox, config.json (from the example)
#   bridge-watchdog.sh           keeps one bridge session running in iTerm2
#   a LaunchAgent                runs the watchdog at login and every minute
# Usage: install.sh [--no-launchd] | --uninstall
set -e
here=${0:A:h}
office="$HOME/.claude/office"
label="dev.session-office.bridge"
plist="$HOME/Library/LaunchAgents/$label.plist"

if [ "$1" = "--uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  rm -f "$plist" "$office/bridge-watchdog.sh"
  echo "Removed the LaunchAgent and watchdog. $office (config, desk cards) is left in place."
  exit 0
fi

[ "$(uname)" = "Darwin" ] || { echo "Session Office's bridge needs macOS (iTerm2 + launchd)."; exit 1; }
command -v claude >/dev/null || echo "warning: 'claude' is not on PATH; the bridge tab will fail to start."
[ -d /Applications/iTerm.app ] || echo "warning: iTerm2 not found in /Applications; the watchdog opens the bridge there."

mkdir -p "$office/desks" "$office/inbox"
if [ ! -f "$office/config.json" ]; then
  cp "$here/config.example.json" "$office/config.json"
  chmod 600 "$office/config.json"
  echo "Wrote $office/config.json — set officeUrl once the page is published."
else
  echo "Kept the existing $office/config.json."
fi

cp "$here/bridge-watchdog.sh" "$office/bridge-watchdog.sh"
chmod +x "$office/bridge-watchdog.sh"

[ "$1" = "--no-launchd" ] && { echo "Skipped the LaunchAgent (--no-launchd)."; exit 0; }
mkdir -p "${plist:h}"
cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>$office/bridge-watchdog.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>$office/bridge-watchdog.log</string>
  <key>StandardErrorPath</key><string>$office/bridge-watchdog.log</string>
</dict>
</plist>
PLIST
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "LaunchAgent $label loaded; the watchdog opens a bridge tab within a minute."
