# Session Office

[中文說明](README.zh-TW.md)

A pixel-art office for your Claude Code sessions. Every running session sits at
a desk; when it finishes a turn it walks over to your desk to report. From the
page you can reply, acknowledge, `/clear`, `/compact`, focus its terminal tab,
end it, or open a new session.

每個 Claude Code session 是辦公室裡的一位同事。做完一輪就走到你桌前匯報；
你可以在頁面上回覆、收到、`/clear`、`/compact`、切到它的分頁、開除，或開新 session。

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
  synced, and turns red when it is down.
- **page/** — the artifact page itself.
- **install/** — the watchdog that keeps the bridge running, and its LaunchAgent.

## Before you start

| | needed | check |
|---|---|---|
| macOS + [iTerm2](https://iterm2.com) | yes | the bridge runs in an iTerm2 tab, kept alive by launchd |
| Claude Code with mods (tested on 2.1.311) | yes | `claude --version` |
| A claude.ai account that can publish Artifacts | yes | you can ask Claude to publish a page |
| Access to this repository | yes | it is private: ask the owner to add you as a collaborator, and make sure `git clone git@github.com:jacobintern/session-office.git` works |
| Pipoya's sprite pack + node | yes, once | see *Sprites* |
| Jira Cloud API token | no | for the Jira column |
| Codex CLI | no | for the Codex secretary's usage limits |

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

   > Publish `page/session-office.html` as a new artifact with the `db` and
   > `user` capabilities, and publish every file in `page/chars/` alongside it
   > at `chars/<file name>`. Give me the artifact's URL.

4. Run the installer, then put the URL in the config:

   ```sh
   ./install/install.sh          # --no-launchd to skip the LaunchAgent, --uninstall to remove it
   $EDITOR ~/.claude/office/config.json
   ```

5. Start the bridge. Within a minute the watchdog opens an iTerm2 tab running
   the bridge. The first time, macOS and Claude Code ask three things; the
   bridge stays down until all three are answered:
   - macOS: allow the watchdog to control iTerm2 (Automation);
   - Claude Code: accept `--dangerously-skip-permissions`;
   - Claude Code: trust the bridge's folder (`bridgeCwd`).

6. Check: `./install/install.sh --check` in a shell, or `/office doctor` in any
   session. Then open a new `claude` session: it shows up at a desk on the page.

## Commands

| | |
|---|---|
| `/office` | the page's link, this session's desk, and whether the setup checks pass |
| `/office doctor` | checks the config, this session's desk card and the bridge |
| `/office name <text>` | the desk's nameplate (empty clears it) |
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
| `city` | `{ "lat", "lng" }` for sunrise and sunset outside the window |
| `newSessionDirs` | folders offered when opening a new session from the page |
| `language` | `"zh-TW"` (default) or `"en"`: the heading sessions use for decisions (`## 要你決定` / `## Decisions for you`). The page itself follows the browser's language, with a 中 / EN switch in the header |

Only `jira.site`, `codex`, `city` and `newSessionDirs` reach the page (as
`meta/config`); the Jira email and token stay on your machine.

## Sprites

Characters come from Pipoya's free pack, **PIPOYA FREE RPG Character Sprites
32x32** (https://pipoya.itch.io/pipoya-free-rpg-character-sprites-32x32). Its
license allows use and editing but not redistribution, so the images are not
in this repository. Download the pack (free, from the link above), then build
the page's sprites from it with `install/build-sprites.mjs` (Install, step 2). This writes `page/chars/` (you, the Codex secretary, and four character
pools); publish those files together with the page.

## Report format

The mod adds one line of context to every prompt asking the model to end its
answer with a `## 要你決定` (decisions for you) section when it needs your
input; the page shows that section as a highlighted block.

## License

MIT for the code in this repository. The character sprites are Pipoya's and
follow Pipoya's own terms.
