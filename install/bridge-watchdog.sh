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

notify() { /usr/bin/osascript -e "display notification \"$1\" with title \"Session Office\"" >/dev/null 2>&1; }

# A bridge whose login expired stays up but stops syncing, and a new one would need
# the same login: tell the person instead (macOS notification, not through the page,
# which the bridge itself feeds). At most every 10 minutes, and only while it is not syncing.
login_check() {
  local sid tr ok at last now=$(date +%s)
  sid=$(/usr/bin/plutil -extract sessionId raw -o - "$office/bridge.json" 2>/dev/null) || return
  ok=$(/usr/bin/plutil -extract ok raw -o - "$office/bridge.json" 2>/dev/null)
  at=$(/usr/bin/plutil -extract at raw -o - "$office/bridge.json" 2>/dev/null)
  [ "$ok" = "true" ] && [ $(( now - ${at:-0} / 1000 )) -lt 120 ] && return
  tr=$(ls -t "$HOME"/.claude/projects/*/"$sid".jsonl 2>/dev/null | head -1)
  [ -n "$tr" ] && tail -n 30 "$tr" | grep -qE 'Run /login|run /login|Login expired' || return
  last=$(cat "$office/login-notified" 2>/dev/null || echo 0)
  [ $(( now - last )) -ge 600 ] || return
  notify "橋接要重新登入：到橋接的 iTerm 分頁跑 /login"
  log "bridge needs /login; notified"
  echo "$now" > "$office/login-notified"
}
login_check

# Once a day: once today is inside the window the claude.ai login ends in, say so ahead of
# time. The CLI warns only when a session starts, and the bridge runs for days.
# `claude auth status --text` prints "Sign-in ends: between <from> and <to> (...)" (v2.1.318+).
login_ends_check() {
  local today=$(date +%F) cli line from to
  [ "$(cat "$office/login-ends-checked" 2>/dev/null)" = "$today" ] && return
  echo "$today" > "$office/login-ends-checked"
  cli=$(command -v claude || echo /opt/homebrew/bin/claude)
  line=$("$cli" auth status --text 2>/dev/null | grep '^Sign-in ends: between')
  from=$(echo "$line" | awk '{print $4}'); to=$(echo "$line" | awk '{print $6}')
  [[ "$from" == ????-??-?? && "$to" == ????-??-?? ]] || return
  [[ "$today" < "$from" ]] && return
  notify "Claude 登入會在 $from～$to 之間到期，找空檔在任一分頁跑 /login（橋接也要）"
  log "login ends between $from and $to; notified"
}
login_ends_check

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
  upOf() { local started=$(LC_ALL=C ps -o lstart= -p "${1:-0}" 2>/dev/null | sed 's/ *$//'); echo $(( now - $(LC_ALL=C date -j -f '%a %b %d %T %Y' "${started:-}" +%s 2>/dev/null || echo "$now") )); }
  stuck=""
  if [ -n "$pid" ] && [[ " $running " == *" $pid "* ]]; then
    up=$(upOf "$pid")
    [ "$age" -gt "$STUCK_SECS" ] && [ "$up" -gt "$STUCK_SECS" ] && stuck="$pid"
  elif [ -n "$pid" ]; then
    # bridge.json is from an earlier bridge: one running longer than STUCK_SECS
    # has never written it (its mod did not load, or it waits on a dialog).
    # Skipped when there is no bridge.json yet, so a first install has time for its prompts.
    for p in ${=running}; do up=$(upOf "$p"); [ "$up" -gt "$STUCK_SECS" ] && stuck="$stuck $p"; done
  fi
  if [ -n "$stuck" ]; then
    log "bridge pid ${stuck# } has not synced (last bridge.json ${age}s ago, from pid $pid); ending it"
    notify "橋接 ${age} 秒沒同步，已結束它並重開一個"
    kill ${=stuck} 2>/dev/null
    sleep 3
  else
    # a line only when the running bridge changes, not every minute
    [ "$(cat "$office/watchdog-last" 2>/dev/null)" = "$running" ] || { log "bridge running (pid $running)"; echo "$running" > "$office/watchdog-last"; }
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

rm -f "$office/watchdog-last"
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
