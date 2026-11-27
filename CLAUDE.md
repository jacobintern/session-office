# Session Office — code map for agents

A map, not a log: where things live and how data flows. Keep it under 60 lines;
lessons and history go to commit messages or `docs/`. Locate code by the
function names below (grep them), never by line number. Overview: `README.md`.

## Data flow

```
session (mod) → ~/.claude/office/desks/<id>.json → bridge (ArtifactData) → page
page → `desks` / `requests` docs → bridge → ~/.claude/office/inbox/<id>.json → session
```

| Doc (page reads it in the `onSnapshot` block) | Written by (register.tsx) | Rendered by (page) |
|---|---|---|
| `meta/jira`, `meta/config` | `syncJira`, `loadConfig` | `renderJira`, `applyConfig` |
| `meta/codex`, `codexAsks` | `syncCodex`, `serveCodexAsks` | `drawCodex`, `openCodex`, `renderCodex` |
| `meta/usage`, `meta/bridge` | `recordUsage`, `heartbeat` | `analystText`, `judgeBridge` (header light) |
| `meta/events` | `syncEvents` (last 100 lines of `events.log`) | `drawGuard`, `renderEvents` |
| `desks` | `bridgeTick` (from desk files) | `renderRoster`, `draw`, `fillModal` |
| `requests` (kind `lead` opens a project lead) | `openRequestedSessions`, `openHires` | `openSpawn`, `applySpawnMode` |
| `tasks`, `boards/*` | `syncTasks`, `syncBoards` | `projectOverview`, `watchBoard` |

When a desk behaved oddly (a project that changed back, an instruction that
never ran, a state that flipped), read `~/.claude/office/events.log` first:
one JSON line per mod load, instruction, state or project change, failed
delivery, forward and context warning (`logEvent`), UTC, 7 days, this Mac only.

## mod/hooks/register.tsx (one file; `// ----` marks worker, bridge, hooks)

- **worker** — the desk card: `saveDesk`, `patch`, `setProject`, `checkPermission`,
  `checkBackground`; page instructions: `takeInstruction`, `deliver`, `pause`, `switchModel`.
- **bridge** — `bridgeTick` is the loop; `putMeta`, `assignSeats`, `runChecks`, `doctor`;
  teams: `forwardQuestions`, `warnMemberContext`, `openHires`.
- **hooks** — `prompt.submit` adds `REPORT_FORMAT`, the board, `LEAD_CONTEXT` /
  `MEMBER_CONTEXT` (once, as `roleShown` tracks), `OPEN_QUESTIONS_CONTEXT`
  (`questionsLeft`); `turn.complete` sets the report, `asked` and `history`.

## page/session-office.html (one file: HTML, CSS, then one script)

- **Strings** — `I18N` has a `zh` and an `en` table; add every key to both (`tt`).
- **Canvas** — `layout`, `tick`, `draw`, `drawDesk`, `drawActor`, `nameTag`, `syncActors` (queue).
- **Desk modal** — `fillModal`, `splitDecide` / `openDecide` (the `## 要你決定` block),
  `renderUnread` / `markRead` (reads), `routeAnswers` (`→ desk`), `send`, `instruct`.
- **Side panels** — `renderRoster`, `projectOverview`, `openSpawn`, `openTutor`, `openAnalyst`, `bossCard`.

## Shipping a change

How each part goes live: README → Updating. Saving `register.tsx` reloads the mod
in every running session, so the load path must be safe to run again, and a value
read from the process environment must not override what the desk saved since.
Parse it before saving: `npx --yes esbuild@0.24.0 mod/hooks/register.tsx
--loader:.tsx=tsx --format=esm >/dev/null` (a file that does not parse leaves new
sessions, the bridge too, with no mod; `tsc` is not the engine's check). Then
confirm the bridge took it: its tick count in `~/.claude/office/bridge.json`
starts again from 1, within a minute. Check the page by screenshots: it runs in a
cross-origin frame. Several sessions work here: `git add` only your own hunks.
A change a user would notice adds a line under `## [Unreleased]` in `CHANGELOG.md`
in the same commit; a release renames it to the version, tags `vX.Y.Z`, and
`gh release create` takes that section as its notes.
