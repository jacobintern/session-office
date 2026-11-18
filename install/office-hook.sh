#!/bin/zsh
# Settings hooks for Session Office; install.sh adds them to ~/.claude/settings.json.
# A mod's hook on this event can be cut off by another plugin that runs first,
# so it lives here, where every settings hook runs.
#   office-hook.sh permission  PermissionRequest: tells the office the session
#                              waits on a permission dialog, then waits up to
#                              10 minutes for 允許 / 拒絕 from the page while the
#                              terminal dialog stays up; whichever answers first wins
dir="${OFFICE_HOOK_DIR:-$HOME/.claude/office/hook}"   # OFFICE_HOOK_DIR: for tests
# leftovers of sessions that have ended (title-* came from an older version)
find "$dir" \( -name 'title-*' -o -name 'perm-*' -mtime +1 \) -delete 2>/dev/null
input=$(cat)
sid=$(print -r -- "$input" | grep -o '"session_id" *: *"[A-Za-z0-9-]*"' | head -1 | sed 's/.*"\([A-Za-z0-9-]*\)"$/\1/')
[ -n "$sid" ] || exit 0
case "$1" in
  permission)
    mkdir -p "$dir"
    zmodload zsh/datetime
    started=${$(( EPOCHREALTIME * 1000 ))%.*}
    answer="$dir/answer-$sid.json" settled="$dir/settled-$sid"
    rm -f "$answer"
    print -r -- "{\"at\":$started,\"event\":$input}" > "$dir/perm-$sid.json"
    for i in {1..1200}; do
      if [ -f "$answer" ] && grep -Eq "\"for\": *${started}[,} ]" "$answer"; then
        behavior=$(grep -Eo '"behavior": *"[a-z]+"' "$answer" | grep -Eo '(allow|deny)')
        rm -f "$answer"
        case "$behavior" in
          allow) print -r -- '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}' ;;
          deny) print -r -- '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"The user denied this in Session Office."}}}' ;;
        esac
        exit 0
      fi
      # answered in the terminal: the mod marks the call settled
      [ -f "$settled" ] && [ "$(<"$settled")" -ge "$started" ] && exit 0
      sleep 0.5
    done
    ;;
esac
exit 0
