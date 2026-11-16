# Session Office for Codex — design notes

Not built. A sketch of a Session Office for people who use the Codex CLI and
have no Claude account, written after a look at Codex's own session logs
(2026-11-16, Codex CLI rollout format of that date).

## What ties the current version to Claude

| part | today | for Codex |
|---|---|---|
| sessions report their state | the `office` mod (Claude Code hooks) writes desk cards | Codex has no equivalent hooks |
| page and its data | a claude.ai artifact and its database, written by a Claude bridge session | needs a Claude account; nothing else can write it |
| instructions from the page | each session reads its inbox file | Codex reads no inbox |

## Shape

- **One daemon** (node, started by launchd) that
  - follows `~/.codex/sessions/**/rollout-*.jsonl` and derives each session's desk card;
  - serves the page and pushes desk updates to it (server-sent events or a WebSocket) on `localhost`.
- **The page** keeps today's office; only its data source changes (local connection instead of ArtifactData).
- **Instructions** are typed into the session's iTerm2 tab with AppleScript, as 開除 and "focus its tab" already do.

No mod, no bridge tab, no `--dangerously-skip-permissions`. The phone needs a
tunnel (Tailscale or similar) to reach the page; today claude.ai relays it.

## Desk card from a rollout file

| desk field | rollout source | |
|---|---|---|
| folder, git branch | `session_meta` → `cwd`, `git` | ✅ |
| task | `response_item/message` with `role: user` | ✅ |
| working / done | `event_msg/task_started` / `task_complete` | ✅ |
| current activity | `response_item/custom_tool_call` → `name`, `input` | ✅ |
| report | `task_complete` → `last_agent_message` | ✅ |
| context fill, rate limits | `event_msg/token_count`, `token_usage_record` | ✅ |
| alive, which tab | not in the file: `lsof` finds the `codex` process holding the file, giving pid and tty | ⚠️ |
| waiting on an approval | no such event in the file looked at; to check | ❓ |

## Open questions

1. Does the rollout file record a pending approval (and the question asked), so the page can show it?
2. Is typing into the tab reliable enough for replies, and for answering an approval? It collides with whatever the person is typing there.
3. Rollout files are Codex's internal format and may change between versions; the daemon should pin the fields it reads and fail loudly.

## Steps, if built

1. **Read-only**: daemon + local page showing Codex sessions at their desks, with reports. Proves the state can be derived reliably.
2. **Instructions**: reply / acknowledge / approve by typing into the tab, then decide whether it is good enough to ship.
