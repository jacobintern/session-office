#!/bin/zsh
# Session Office bridge watchdog. Run by launchd at login and every minute:
# if no bridge session is running, or the one running has not synced for a
# while (stuck on a dialog), open an iTerm2 tab and start one in `bridgeCwd`
# from ~/.claude/office/config.json.
# The bridge tab skips permission prompts (the artifact-data consent cannot be
# pre-approved any other way), so never type work into that tab.

log() { echo "$(date '+%F %T') $*"; }

office="$HOME/.claude/office"
STUCK_SECS=180

# A running bridge is a `claude --dangerously-skip-permissions` process.
# Match the claude process itself, not a shell whose command line merely quotes it.
running=$(ps -axo pid=,command= | awk '$2 == "claude" && $3 == "--dangerously-skip-permissions" { print $1 }' | tr '\n' ' ')
if [ -n "$running" ]; then
  # The bridge writes bridge.json every tick (~10 s). A process older than
  # STUCK_SECS whose last tick is older than that is waiting on something
  # (a permission or trust dialog, a hung tool): end it and open a fresh one.
  pid=$(/usr/bin/plutil -extract pid raw -o - "$office/bridge.json" 2>/dev/null)
  at=$(/usr/bin/plutil -extract at raw -o - "$office/bridge.json" 2>/dev/null)
  now=$(date +%s)
  age=$(( now - ${at:-0} / 1000 ))
  started=$(LC_ALL=C ps -o lstart= -p "${pid:-0}" 2>/dev/null | sed 's/ *$//')
  up=$(( now - $(LC_ALL=C date -j -f '%a %b %d %T %Y' "${started:-}" +%s 2>/dev/null || echo "$now") ))
  if [ -n "$pid" ] && [[ " $running " == *" $pid "* ]] && [ "$age" -gt "$STUCK_SECS" ] && [ "$up" -gt "$STUCK_SECS" ]; then
    log "bridge pid $pid has not synced for ${age}s (up ${up}s); ending it"
    kill "$pid" 2>/dev/null
    sleep 3
  else
    log "bridge running (pid $running)"
    exit 0
  fi
fi

dir=$(/usr/bin/plutil -extract bridgeCwd raw -o - "$office/config.json" 2>/dev/null)
dir=${dir/#\~/$HOME}
[ -d "$dir" ] || dir=$HOME

# osascript compiles the script against iTerm2's dictionary, which it cannot
# read while iTerm2 is not running (after a reboot, before anyone opened it):
# launch it first and wait until it answers.
if ! /usr/bin/osascript -e 'application "iTerm2" is running' 2>/dev/null | grep -q true; then
  log "iTerm2 is not running; launching it"
  /usr/bin/open -ga iTerm
  for _ in {1..20}; do
    sleep 1
    /usr/bin/osascript -e 'application "iTerm2" is running' 2>/dev/null | grep -q true && break
  done
fi

log "no bridge found; opening one in $dir"
/usr/bin/osascript - "$dir" <<'APPLESCRIPT'
on run argv
  tell application "iTerm2"
    if (count of windows) = 0 then
      set w to (create window with default profile)
    else
      set w to current window
      tell w to create tab with default profile
    end if
    tell current session of w to write text "cd " & quoted form of (item 1 of argv) & " && CLAUDE_OFFICE_BRIDGE=1 claude --dangerously-skip-permissions"
  end tell
end run
APPLESCRIPT
