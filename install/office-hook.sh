#!/bin/zsh
# Settings hooks for Session Office; install.sh adds them to ~/.claude/settings.json.
# A mod's hooks on these two events can be cut off by another plugin that runs
# first, so they live here, where every settings hook runs.
#   office-hook.sh prompt      UserPromptSubmit: sets the session title to the
#                              nameplate the session was renamed to
#   office-hook.sh permission  PermissionRequest: tells the office the session
#                              waits on a permission dialog (it never answers it)
dir="$HOME/.claude/office/hook"
# leftovers of sessions that ended before their next prompt
find "$dir" -name 'title-*' -mtime +7 -delete 2>/dev/null
find "$dir" -name 'perm-*' -mtime +1 -delete 2>/dev/null
input=$(cat)
sid=$(print -r -- "$input" | grep -o '"session_id" *: *"[A-Za-z0-9-]*"' | head -1 | sed 's/.*"\([A-Za-z0-9-]*\)"$/\1/')
[ -n "$sid" ] || exit 0
case "$1" in
  prompt)
    f="$dir/title-$sid"
    [ -f "$f" ] || exit 0
    title=$(<"$f")   # the mod writes it as a JSON string
    rm -f "$f"
    print -r -- "{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"sessionTitle\":$title}}"
    ;;
  permission)
    mkdir -p "$dir"
    zmodload zsh/datetime
    print -r -- "{\"at\":${$(( EPOCHREALTIME * 1000 ))%.*},\"event\":$input}" > "$dir/perm-$sid.json"
    ;;
esac
exit 0
