# Session Office

[中文說明](README.zh-TW.md)

A pixel-art office for your Claude Code sessions. Every running session sits at
a desk; when it finishes a turn it walks over to your desk to report. From the
page you can reply, acknowledge, `/clear`, `/compact`, rename it,
end it, or open a new session.

## How it works

```
session ─(office mod)→ ~/.claude/office/desks/<id>.json
                                   │
              bridge session (one, in its own iTerm2 tab)
                                   │ ArtifactData
                                   ▼
                    Session Office page (a claude.ai artifact)
```

- **mod/** — a Claude Code mod. Every session writes its desk card to a local
  file; work sessions never call a tool, so they stay in whatever permission
  mode you use.
- **The bridge** — one session started with `CLAUDE_OFFICE_BRIDGE=1` copies the
  desk cards into the page's database and brings instructions from the page
  back as files. It runs with `--dangerously-skip-permissions` (the
  artifact-data consent cannot be pre-approved otherwise), so **never type work
  into the bridge tab**. The light in the page's header shows when it last
  synced, and turns red when it is down; when it is your own network that is
  down, it says so instead, and the page reconnects by itself.
- **page/** — the artifact page itself.
- **install/** — the watchdog that keeps the bridge running, its LaunchAgent, and
  `office-hook.sh`: two hooks the installer adds to `~/.claude/settings.json`
  (a backup is kept next to it) that tell the page when a session waits on a
  permission dialog, and what background work is still running when a turn
  ends; a mod's own hook on those events can be cut off by other plugins.

## User manual

A picture-led manual in Traditional Chinese: <https://jacobintern.github.io/session-office/manual/>
(GitHub Pages; the source is [docs/manual/](docs/manual/), and a push to main
updates it within minutes).

## Token cost

Under US$1 a month: syncing and desk cards run in the mod without any model
turn; only the short report-format note added to each prompt (~130 tokens)
costs tokens.
See [docs/token-cost.md](docs/token-cost.md).

## Before you start

| | needed | paid? | check |
|---|---|---|---|
| macOS + [iTerm2](https://iterm2.com) | yes | free | the bridge runs in an iTerm2 tab, kept alive by launchd |
| A claude.ai plan with Claude Code: Pro, Max, Ultra, Team or Enterprise | yes | **paid** — the Free plan has no Claude Code, no artifact database (`db`), and cannot publish from Claude Code | `claude --version` (tested on 2.1.311) |
| Pipoya's sprite pack + node | yes, once | free (the pack may not be redistributed) | see *Sprites* |
| Jira Cloud API token | no | your own Jira account | for the Jira column |
| Codex CLI | no | your own ChatGPT plan with Codex | for the Codex secretary |

Running it costs under US$1 a month on your plan (see *Token cost*); the
English tutor runs on the usage of whoever opens the page, never yours.

`install/install.sh --check` checks all of this (and the bridge) and prints the
fix for anything that fails.

## Install

1. Get the repository and install the mod:

   ```sh
   git clone git@github.com:jacobintern/session-office.git && cd session-office
   claude plugin marketplace add jacobintern/session-office
   claude plugin install office@session-office
   ```

2. Build the sprites (see *Sprites*):

   ```sh
   node install/build-sprites.mjs ~/Downloads/"PIPOYA FREE RPG Character Sprites 32x32.zip"
   ```

3. Publish your own copy of the page. Everyone needs their own: the page's
   database holds your sessions. In a Claude Code session started in this
   folder, paste:

   > Publish `page/session-office.html` as a new artifact with the `db`,
   > `user` and `sample` capabilities, and publish every file in `page/chars/` alongside it
   > at `chars/<file name>`. Give me the artifact's URL.

4. Run the installer, then put the URL in the config:

   ```sh
   ./install/install.sh          # --no-launchd to skip the LaunchAgent, --uninstall to remove it
   $EDITOR ~/.claude/office/config.json
   ```

5. Wait for the bridge (nothing to start by hand). Within a minute the watchdog opens an iTerm2 tab running
   the bridge. The first time, macOS and Claude Code ask three things; the
   bridge stays down until all three are answered:
   - macOS: allow the watchdog to control iTerm2 (Automation);
   - Claude Code: accept `--dangerously-skip-permissions`;
   - Claude Code: trust the bridge's folder (`bridgeCwd`).

6. Check: `./install/install.sh --check` in a shell, or `/office doctor` in any
   session. Then open a new `claude` session: it shows up at a desk on the page.

## Updating

After `git pull`, each part updates on its own:

| what changed | how to update |
|---|---|
| `mod/` (the office mod) | `claude plugin update office@session-office`, then restart your sessions and the bridge tab (close it; the watchdog reopens one within a minute). If `CLAUDE_CODE_PLUGIN_DIRS` points at this repository's `mod/`, restarting the sessions is enough |
| `page/` (the page) | in a session started in this folder, ask it to publish `page/session-office.html` to your existing URL (`officeUrl`); the database and the sprites stay |
| `install/` (watchdog, hook) | run `./install/install.sh` again; an existing `config.json` is kept |

## Commands

| | |
|---|---|
| `/office` | the page's link, this session's desk, and whether the setup checks pass |
| `/office doctor` | checks the config, this session's desk card, the bridge, and whether this mod's hooks ran (a plugin of a higher tier can skip them) |
| `/office name <text>` | the desk's nameplate (empty clears it); the session title follows (it runs `/rename`, and `/rename` in turn sets the nameplate). You can also type it in the page's reply box, or ask the session to rename itself |
| `/office project <text>` | the project / topic this desk belongs to (empty goes back to the branch ticket or the repo); sessions of one project share a board. The page's ✎ next to "Project" does the same |
| `/office status` | the bridge's last round |
| `/office bridge` / `/office bridge off` | make this session the bridge, or stop |

Every session runs the same checks 15 seconds after it starts and shows a
one-line notice only when one fails.

## Configuration — `~/.claude/office/config.json`

| key | meaning |
|---|---|
| `officeUrl` | your published page |
| `bridgeCwd` | the folder the bridge session runs in |
| `jira` | `null`, or `{ "site", "email", "jql"?, "tokenFile"? }` — the token is read from `tokenFile` (default `~/.jira_api_token`) and passed to curl on stdin, never on argv; without `jira` the column is hidden |
| `codex` | `false` hides the Codex secretary |
| `tutor` | `false` hides the English tutor |
| `city` | `{ "lat", "lng" }` for sunrise and sunset outside the window |
| `newSessionDirs` | folders offered when opening a new session from the page |
| `language` | `"zh-TW"` (default) or `"en"`: the heading sessions use for decisions (`## 要你決定` / `## Decisions for you`). The page itself follows the browser's language, with a 中 / EN switch in the header |

Only `jira.site`, `codex`, `tutor`, `city` and `newSessionDirs` reach the page (as
`meta/config`); the Jira email and token stay on your machine.

## Sprites

Characters come from Pipoya's free pack, **PIPOYA FREE RPG Character Sprites
32x32** (https://pipoya.itch.io/pipoya-free-rpg-character-sprites-32x32). Its
license allows use and editing but not redistribution, so the images are not
in this repository. Download the pack (free, from the link above), then build
the page's sprites from it with `install/build-sprites.mjs` (Install, step 2). This writes `page/chars/` (you, the Codex secretary, and four character
pools); publish those files together with the page.

## English tutor

The teacher at her own desk below your office translates what you paste,
paragraph by paragraph, original beside translation: Chinese into English, and
anything else into Traditional Chinese. Ask her about a translation, or how to
say something, with “Ask”. She asks Claude from the page itself (the `sample`
capability, on your own claude.ai usage), so she works without the bridge; the
first time, claude.ai asks you to allow it.

## Report format

The mod adds one line of context to every prompt asking the model to end its
answer with a `## 要你決定` (decisions for you) section when it needs your
input; the page shows that section as a highlighted block.

## License

MIT for the code in this repository. The character sprites are Pipoya's and
follow Pipoya's own terms.
