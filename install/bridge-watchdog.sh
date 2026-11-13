#!/bin/zsh
# Session Office bridge watchdog. Run by launchd at login and every minute:
# if no bridge session is running, open an iTerm2 tab and start one in
# `bridgeCwd` from ~/.claude/office/config.json.
# The bridge tab skips permission prompts (the artifact-data consent cannot be
# pre-approved any other way), so never type work into that tab.

log() { echo "$(date '+%F %T') $*"; }

# A running bridge is a `claude --dangerously-skip-permissions` process.
# Match the claude process itself, not a shell whose command line merely quotes it.
running=$(ps -axo pid=,command= | awk '$2 == "claude" && $3 == "--dangerously-skip-permissions" { print $1 }' | tr '\n' ' ')
if [ -n "$running" ]; then
  log "bridge running (pid $running)"
  exit 0
fi

dir=$(/usr/bin/plutil -extract bridgeCwd raw -o - "$HOME/.claude/office/config.json" 2>/dev/null)
dir=${dir/#\~/$HOME}
[ -d "$dir" ] || dir=$HOME

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
