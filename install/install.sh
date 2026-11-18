#!/bin/zsh
# Sets up the local side of Session Office on macOS:
#   ~/.claude/office/            desk cards, inbox, config.json (from the example)
#   bridge-watchdog.sh           keeps one bridge session running in iTerm2
#   a LaunchAgent                runs the watchdog at login and every minute
#   office-hook.sh               two settings hooks in ~/.claude/settings.json (session
#                                title from the nameplate, permission dialogs)
# Usage: install.sh [--no-launchd] | --uninstall | --check
set -e
here=${0:A:h}
office="$HOME/.claude/office"
label="dev.session-office.bridge"
plist="$HOME/Library/LaunchAgents/$label.plist"
settings="$HOME/.claude/settings.json"

# adds (add) or removes (remove) office-hook.sh in settings.json, keeping every other hook
settings_hooks() {
  command -v node >/dev/null || { echo "warning: node not found; add the office-hook.sh hooks to $settings by hand (README)."; return 0; }
  node - "$1" "$settings" "$office/office-hook.sh" <<'JS'
const fs = require('fs')
const [mode, file, script] = process.argv.slice(2)
let s = {}
try { s = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { if (fs.existsSync(file)) { console.error(`${file} is not valid JSON; left it alone.`); process.exit(0) } }
s.hooks = s.hooks || {}
const ours = h => typeof h.command === 'string' && h.command.includes('office-hook.sh')
for (const ev of ['UserPromptSubmit', 'PermissionRequest']) {
  s.hooks[ev] = (s.hooks[ev] || []).map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !ours(h)) })).filter(g => g.hooks.length)
  if (mode === 'add') s.hooks[ev].push({ hooks: [{ type: 'command', command: `/bin/zsh "${script}" ${ev === 'UserPromptSubmit' ? 'prompt' : 'permission'}`, timeout: 5 }] })
  if (!s.hooks[ev].length) delete s.hooks[ev]
}
if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak-session-office')
fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n')
console.log(mode === 'add' ? `Added the Session Office hooks to ${file} (backup: ${file}.bak-session-office).` : `Removed the Session Office hooks from ${file}.`)
JS
}

[ "$1" = "--check" ] && exec /bin/zsh "$here/check.sh"

if [ "$1" = "--uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  rm -f "$plist" "$office/bridge-watchdog.sh"
  settings_hooks remove
  rm -f "$office/office-hook.sh"
  echo "Removed the LaunchAgent and watchdog. $office (config, desk cards) is left in place."
  exit 0
fi

[ "$(uname)" = "Darwin" ] || { echo "Session Office's bridge needs macOS (iTerm2 + launchd)."; exit 1; }
command -v claude >/dev/null || echo "warning: 'claude' is not on PATH; the bridge tab will fail to start."
[ -d /Applications/iTerm.app ] || echo "warning: iTerm2 not found in /Applications; the watchdog opens the bridge there."

mkdir -p "$office/desks" "$office/inbox" "$office/hook"
if [ ! -f "$office/config.json" ]; then
  cp "$here/config.example.json" "$office/config.json"
  chmod 600 "$office/config.json"
  echo "Wrote $office/config.json — set officeUrl once the page is published."
else
  echo "Kept the existing $office/config.json."
fi

cp "$here/bridge-watchdog.sh" "$office/bridge-watchdog.sh"
chmod +x "$office/bridge-watchdog.sh"
cp "$here/office-hook.sh" "$office/office-hook.sh"
chmod +x "$office/office-hook.sh"
settings_hooks add

check() { echo; echo "Checking the setup (run install.sh --check again any time):"; /bin/zsh "$here/check.sh" || true; }
[ "$1" = "--no-launchd" ] && { echo "Skipped the LaunchAgent (--no-launchd)."; check; exit 0; }
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
check
