#!/bin/zsh
# Checks everything Session Office needs, one line per item, with the fix for
# each one that fails. Run it before the first start and whenever the page
# shows no bridge. Exit status: the number of failed required checks.
# Usage: check.sh   (also run by install.sh --check and at the end of install.sh)
here=${0:A:h}
office="$HOME/.claude/office"
fails=0

pass() { echo "✅ $1"; }
fail() { echo "❌ $1"; echo "   → $2"; fails=$((fails + 1)); }
warn() { echo "⚠️  $1"; [ -n "$2" ] && echo "   → $2"; }
get() { plutil -extract "$1" raw -o - "$office/config.json" 2>/dev/null; }

echo "== Machine"
[ "$(uname)" = "Darwin" ] && pass "macOS" || fail "macOS" "the bridge needs macOS (iTerm2 + launchd)"
[ -d /Applications/iTerm.app ] && pass "iTerm2" || fail "iTerm2 not in /Applications" "install it from https://iterm2.com"
if command -v claude >/dev/null; then
  pass "Claude Code $(claude --version 2>/dev/null | awk '{print $1}')"
else
  fail "'claude' is not on PATH" "install Claude Code, then open a new terminal"
fi
command -v node >/dev/null && pass "node $(node -v) (to build the sprites)" || warn "node not found" "only needed once, for install/build-sprites.mjs"

echo "== Mod"
plugin_dirs_have_office() {
  local d
  for d in ${(s.:.)CLAUDE_CODE_PLUGIN_DIRS}; do
    grep -q '"name": *"office"' "$d/.claude-plugin/plugin.json" 2>/dev/null && return 0
  done
  return 1
}
if claude plugin list 2>/dev/null | grep -q 'office@session-office'; then
  pass "office mod installed (office@session-office)"
elif plugin_dirs_have_office; then
  pass "office mod loaded from CLAUDE_CODE_PLUGIN_DIRS"
else
  fail "office mod not installed" "claude plugin marketplace add jacobintern/session-office && claude plugin install office@session-office"
fi

if grep -q 'office-hook.sh' "$HOME/.claude/settings.json" 2>/dev/null && [ -x "$office/office-hook.sh" ]; then
  pass "settings hooks (permission dialogs, background work)"
else
  warn "settings hook not installed" "run install/install.sh again; without it permission dialogs do not show on the page"
fi

echo "== Config"
if [ ! -f "$office/config.json" ]; then
  fail "$office/config.json missing" "run install/install.sh"
elif ! plutil -lint -s "$office/config.json" >/dev/null 2>&1 && ! python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$office/config.json" 2>/dev/null; then
  fail "config.json is not valid JSON" "fix $office/config.json"
else
  url=$(get officeUrl)
  if [[ "$url" =~ '^https://claude\.ai/(code/)?artifact/[A-Za-z0-9_-]+$' ]]; then
    pass "officeUrl set"
  else
    fail "officeUrl not set" "publish the page (README, Install step 3) and put its URL in $office/config.json"
  fi
  [ "$(stat -f %Lp "$office/config.json")" = "600" ] && pass "config.json is private (600)" || warn "config.json is readable by others" "chmod 600 $office/config.json"
  if [ "$(get jira)" != "" ] && [ "$(plutil -type jira -o - "$office/config.json" 2>/dev/null)" = "dictionary" ]; then
    tf=$(get jira.tokenFile); tf=${tf:-~/.jira_api_token}; tf=${tf/#\~/$HOME}
    if [ -f "$tf" ]; then
      [ "$(stat -f %Lp "$tf")" = "600" ] && pass "Jira token file (600)" || warn "Jira token file is readable by others" "chmod 600 $tf"
    else
      fail "Jira token file $tf missing" "save a Jira API token there, or set \"jira\": null"
    fi
  else
    pass "Jira off (jira: null)"
  fi
fi
[ -d "$office/desks" ] && [ -d "$office/inbox" ] && pass "desks/ and inbox/ exist" || fail "$office/desks or inbox missing" "run install/install.sh"
if [ -d "$here/../page" ]; then
  sprites=("$here/../page/chars/"*.png(N))
  [ ${#sprites} -gt 0 ] \
    && pass "sprites built (page/chars/)" \
    || warn "page/chars/ is empty" "node install/build-sprites.mjs <Pipoya zip>, then publish them with the page"
fi

echo "== Bridge"
# install.sh's label, or any LaunchAgent that runs the watchdog (an older setup)
agents=(${(f)"$(grep -l bridge-watchdog "$HOME/Library/LaunchAgents/"*.plist(N) 2>/dev/null)"})
agent=${agents[(r)*/dev.session-office.bridge.plist]:-${agents[1]}}
agent_label=${${agent:t}%.plist}
[ ${#agents} -gt 1 ] && warn "${#agents} LaunchAgents run the watchdog (${(j:, :)${(@)agents:t}})" "each opens its own bridge: run install/install.sh again, it removes the older one"
if [ -n "$agent_label" ] && launchctl print "gui/$(id -u)/$agent_label" >/dev/null 2>&1; then
  pass "LaunchAgent $agent_label loaded"
else
  warn "LaunchAgent not loaded" "install/install.sh loads it; without it, start the bridge yourself"
fi
running=$(ps -axo pid=,command= | awk '$2 == "claude" && $3 == "--dangerously-skip-permissions" { print $1 }' | tr '\n' ' ')
if [ -n "$running" ]; then
  pass "bridge session running (pid ${running% })"
else
  fail "no bridge session" "a new iTerm tab: cd <bridgeCwd> && CLAUDE_OFFICE_BRIDGE=1 claude --dangerously-skip-permissions — the first time, accept the bypass and folder-trust prompts; see $office/bridge-watchdog.log"
fi
if [ -f "$office/bridge.json" ]; then
  at=$(plutil -extract at raw -o - "$office/bridge.json" 2>/dev/null)
  note=$(plutil -extract note raw -o - "$office/bridge.json" 2>/dev/null)
  bok=$(plutil -extract ok raw -o - "$office/bridge.json" 2>/dev/null)
  age=$(( $(date +%s) - ${at:-0} / 1000 ))
  if [ "$age" -lt 60 ]; then pass "bridge ran ${age}s ago"; else fail "bridge last ran ${age}s ago" "the bridge tab is stuck or closed: look at it in iTerm, or close it and let the watchdog reopen one"; fi
  [ "$bok" = "true" ] && pass "bridge: $note" || fail "bridge: $note" "fix what the note says; /office status in the bridge tab shows the same"
else
  fail "the bridge has never finished a round" "start it (above); its first round writes $office/bridge.json"
fi
n=$(find "$office/desks" -name '*.json' -mmin -30 2>/dev/null | wc -l | tr -d ' ')
[ "$n" -gt 0 ] && pass "$n session(s) reported in the last 30 min" || warn "no session has reported in 30 min" "open a new claude session: the office mod writes its desk card at start"

echo
[ "$fails" -eq 0 ] && echo "All required checks passed." || echo "$fails required check(s) failed."
exit $fails
