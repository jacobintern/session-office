#!/bin/zsh
# Settings hooks for Session Office; install.sh adds them to ~/.claude/settings.json.
# A mod's hook on this event can be cut off by another plugin that runs first,
# so it lives here, where every settings hook runs.
#   office-hook.sh permission  PermissionRequest: tells the office the session
#                              waits on a permission dialog (it never answers it)
dir="$HOME/.claude/office/hook"
# leftovers of sessions that have ended (title-* came from an older version)
find "$dir" \( -name 'title-*' -o -name 'perm-*' -mtime +1 \) -delete 2>/dev/null
input=$(cat)
sid=$(print -r -- "$input" | grep -o '"session_id" *: *"[A-Za-z0-9-]*"' | head -1 | sed 's/.*"\([A-Za-z0-9-]*\)"$/\1/')
[ -n "$sid" ] || exit 0
case "$1" in
  permission)
    mkdir -p "$dir"
    zmodload zsh/datetime
    print -r -- "{\"at\":${$(( EPOCHREALTIME * 1000 ))%.*},\"event\":$input}" > "$dir/perm-$sid.json"
    ;;
esac
exit 0
