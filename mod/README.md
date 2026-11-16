# office

Shows this Claude Code session as a worker in Session Office, a pixel office on
a claude.ai artifact (its link is `officeUrl` in `~/.claude/office/config.json`).

Every session writes its desk card (repo folder, git branch, the task it was
asked, what it is doing, its last answer) to `~/.claude/office/desks/<id>.json`
and never calls a tool, so it runs in whatever permission mode you use. One
bridge session (`CLAUDE_OFFICE_BRIDGE=1`, or `/office bridge`) copies the desk
cards into the artifact's database through the ArtifactData tool and brings
instructions typed on the page back as `~/.claude/office/inbox/<id>.json`.

`/office doctor` checks the setup from inside a session. Setup and the other
commands: the repository's README.
