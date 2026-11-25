# Session Office — code map for agents

A map, not a log: where things live and how data flows. Keep it under 60 lines;
lessons and history go to commit messages or `docs/`. Locate code by the
function names below (grep them), never by line number. Overview: `README.md`.

## Data flow

```
session (mod) → ~/.claude/office/desks/<id>.json → bridge (ArtifactData) → page
page → `desks` / `requests` docs → bridge → ~/.claude/office/inbox/<id>.json → session
```

The bridge publishes `meta/*` docs the page subscribes to (the `onSnapshot`
block at the end of the page script; the board one is in `watchBoard`):

| Doc | Written by (register.tsx) | Rendered by (page) |
|---|---|---|
| `meta/jira` | `fetchJira` / `syncJira` | `renderJira` (right column `#feed`) |
| `meta/config` | `loadConfig` | `applyConfig` (hides the Jira column when no site) |
| `meta/codex` | `syncCodex` | `codexCard`, `drawCodex` |
| `meta/usage` | `recordUsage` | `forecastLine`, `analystText` (usage analyst) |
| `meta/bridge` | `heartbeat`, `writeBridgeStatus` | `judgeBridge` (header light) |
| `desks` | `bridgeTick` (from desk files) | `renderRoster`, `draw`, `fillModal` |
| `requests` | `openRequestedSessions` | `openSpawn` form |
| `codexAsks` | `serveCodexAsks`, `pruneCodexAsks` | `openCodex`, `renderCodex` (the page writes the question) |
| `boards/*` | `syncBoards`, `writeBoard` | `watchBoard`, `renderBoard`, `saveBoard` |

## mod/hooks/register.tsx (one file; `// ----` marks worker, bridge, hooks)

- **worker** — the desk card: `saveDesk`, `patch`, `refreshUsage`, `setProject`,
  `sessionTitle`, `checkPermission`, `checkBackground`; page instructions:
  `takeInstruction`, `deliver`, `checkDelivery`, `pause`, `switchModel`, `leaveOffice`.
- **bridge** — files ↔ artifact database: `bridgeTick` is the loop; `putMeta`
  writes `meta/*`; `saveImages`, `assignSeats`, `restoreEffortDefaults`.
- **hooks** — `register`: `prompt.submit` injects `REPORT_FORMAT` and the board.
- **checks** (end of the bridge section) — `runChecks`, `doctor` (`/office doctor`).

## page/session-office.html (one file: HTML, CSS, then one script)

- **Strings** — `I18N` has a `zh` and an `en` table; add every key to both.
  `tt(key, vars)` looks them up; `applyStatic` sets the fixed labels.
- **Canvas** — `layout`, `fitOffice`, `tick`, `frame` (animation loop), `draw`,
  `drawFloor`, `drawDesk`, `drawActor`, `nameTag`, `bubble`; sky and city:
  `sunAt`, `skyClock`, `skyline`, `kaiju`.
- **Desk modal** — `openModal`, `fillModal`, `renderReport`, `splitDecide`
  (the `## 要你決定` block), `renderHistory`, `renderAsk`/`answer`, `send`,
  `instruct`, `fillProject`, `fillModelPick`, `fillEffortPick`, `fillHandoff`.
- **Side panels** — roster `renderRoster`, Jira `renderJira`, new session
  `openSpawn`, English tutor `openTutor`/`tutorRun`, usage analyst `openAnalyst`, Codex Q&A `openCodex`; your own limits `bossCard`, pairs `renderPairs`.

## Shipping a change

How each part goes live: README → Updating. Saving `register.tsx` reloads the
mod in every running session, so the load path must be safe to run again.
Before saving, parse it: `npx --yes esbuild@0.24.0 mod/hooks/register.tsx
--loader:.tsx=tsx --format=esm >/dev/null`. A file that does not parse keeps
the old mod in the running sessions and leaves every new session (the bridge
too) with none; the error shows only in a new session's terminal, not in your
transcript (e47cd64 shipped one that way). `tsc` is not the engine's check
either (`$` may only be passed to a top-level function), so after a save also
confirm the bridge took it: its tick count in `~/.claude/office/bridge.json`
starts again from 1.
Several sessions work here at once: `git add` only after `git diff` shows
nothing but your own hunks, and ask before touching a file another is editing.
