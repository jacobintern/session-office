# Session Office

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
  into the bridge tab**.
- **page/** — the artifact page itself.
- **install/** — the watchdog that keeps the bridge running, and its LaunchAgent.

## Requirements

macOS, [iTerm2](https://iterm2.com), Claude Code with Artifacts enabled.
Optional: Jira Cloud (an API token), Codex CLI (shows its usage limits).

## Install

1. Install the mod, at the prompt of a terminal session:

   ```
   /plugin install office --marketplace jacobintern/session-office
   ```

2. Publish the page: in a Claude Code session, ask Claude to publish
   `page/session-office.html` as an artifact with the `db` and `user`
   capabilities, together with the files in `page/chars/` (see *Sprites*). Copy the artifact's URL.

3. Run the installer, then put the URL in the config:

   ```sh
   ./install/install.sh          # --no-launchd to skip the LaunchAgent, --uninstall to remove it
   $EDITOR ~/.claude/office/config.json
   ```

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
in this repository. Download the pack, then build the page's sprites from it:

```sh
node install/build-sprites.mjs ~/Downloads/"PIPOYA FREE RPG Character Sprites 32x32.zip"
```

This writes `page/chars/` (you, the Codex secretary, and four character
pools); publish those files together with the page.

## Report format

The mod adds one line of context to every prompt asking the model to end its
answer with a `## 要你決定` (decisions for you) section when it needs your
input; the page shows that section as a highlighted block.

## License

MIT for the code in this repository. The character sprites are Pipoya's and
follow Pipoya's own terms.
