# Changelog

What changed in each release of Session Office. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Changes not yet released are kept
under **Unreleased**.

## [Unreleased]

### Added

- **稍後處理.** On a desk with open questions, the 收到 button becomes 稍後處理.
  The desk goes back to its seat with a 📌 on its nameplate, in the roster and
  in the overview, and its questions stay open. It queues again when it
  reports something new.

### Changed

- A desk with questions you have not answered comes to your desk only once it
  has stopped working. While it handles a member's report, its questions can
  still change, so it waits at its seat.
- A lead's and a member's role rules are sent once, not with every prompt.
  They are sent again after a compaction, a `/clear`, or when the rules
  change, so they no longer pile up in the conversation.
- New lead rules, drawn from what users corrected:
  - Look for a way out that does not need the user at the computer.
  - Do the work yourself before handing the user a message to pass on.
  - Give a fix outside the plan to no one until the user has chosen it.
  - Lead a risk with how bad it is and how likely.
  - Check what a fix does to the other tickets shipping with it.
  - List every MR, including others' under the same parent ticket.
  - Before asking to merge, show that the code review and the verification
    are done.
  - A one-letter answer a member relays is not a decision to change code;
    the lead asks again at its own desk.

## [0.3.0] - 2026-11-27

### Added

- **Project teams.** Open a project from the 新開 form and you get a lead. The lead
  plans first, and after you approve the plan it hires members with the `hire`
  tool (up to a cap). Each project gets a task list (the `task` tool) and an
  overview above the roster that shows how far it is, where it is stuck and what
  you need to decide. A 收尾 button asks the lead to wrap the project up.
- **Teams talk to you through the lead.**
  - A member's question that never reached its lead is forwarded to the lead.
  - The lead can pass your push or MR approval on to the member who does the work.
  - An item the lead marks `→ <member desk>` sends your answer straight into that
    member's session, as your own words.
- **Open questions are kept per item.** Answer by number ("1. a 3. b") and the
  page settles only those items. The rest stay on the lead's desk and in the
  overview, and the session is shown which are still open each turn.
- **〔等你・電腦〕 to-dos.** Things only you can do at the computer get their own
  "at the computer" block in the overview, apart from what you can answer on
  a phone.
- **Board wake-ups.** A new card on a project board, including one you post from
  the page, wakes the project's idle members to read it.
- **Event log and guard.** Each desk's loads, instructions, state and project
  changes are logged to `~/.claude/office/events.log` (kept 7 days). A guard at
  the entrance shows the recent events.
- **Ask Codex from the page.** The bridge answers with `codex exec`, read-only.
- **Usage.** Click yourself to see your 5-hour and weekly limits and when they
  reset. A usage analyst forecasts when they run out.
- **Phone layout.** On a phone the page becomes a to-do list, and the report
  window fills the screen.
- **Attachments.** Any file, or a paste over 2000 characters, goes to the
  session as an attachment. Replies and first tasks take up to 20000 characters.
- **Numbered decisions.** Decisions are numbered so you can answer "1. a 2. b".
  Each question sits on its own line, each option on its own sub-line, and the
  recommendation is marked （建議）.
- **Desks follow the session.** A desk follows the session's directory, and its
  project follows the branch, or a ticket key in the desk name.
- **Office details.**
  - Colleagues walk in from a corridor below the office.
  - A working desk shows typing dots.
  - The roster shows how long each session has been working or idle.
- **Install and reconnect.**
  - The page reconnects after a dropped link.
  - `/office doctor` reports skipped hooks.
  - The installer removes an older LaunchAgent.
  - An offline desk says why it is offline.

### Changed

- A lead and its members report only once their background work has landed.
- A member keeps waiting at your desk while a question you asked it is open.
- A long report keeps its head and its last 4000 characters, so the decisions at
  its end survive.
- The watchdog launches iTerm2 first. It restarts a bridge that stopped
  syncing or never synced.

### Fixed

- **Compaction.**
  - `/compact` sent from the page shows 壓縮對話中 until it finishes.
  - The health bar refills after a compaction, including when `session.compact`
    is bypassed.
- **Pause.** Pause shows as soon as an instruction is sent. Pressed before the
  round starts, it cancels the instruction.
- **Answers to members.** A bare answer ("a") to a single question now reaches
  the member. An answer that cannot reach its member is flagged instead of
  dropped.
- **Projects.** A project set from the page survives a mod reload.
- **Desks.** Desks stay put after the Mac sleeps.
- **Phone.** On a phone, the back control no longer sits on the host's own back
  button, and no window scrolls sideways.

## [0.2.0] - 2026-11-21

The first tagged release.

- **The office.** A pixel office on a claude.ai artifact, with one desk per
  Claude Code session, kept in sync by a mod and a background bridge.
- **Talk to sessions from the page.**
  - Send a session instructions, tracked until they reach the conversation.
  - Answer its questions.
  - Allow or deny its permission dialogs.
  - Pause a running round.
- **Model and effort.**
  - Switch a session's model, which resumes it under the same id.
  - Set effort per session.
  - Hand a session off to Codex.
- **Projects and boards.** Every desk gets a project, and each project has a
  board with one card per member. Teammates sort things out before they ask
  you.
- **Names.**
  - Sessions can rename themselves.
  - Page names match message names, and duplicate names are flagged.
- **Extras.**
  - An English tutor with paragraph-by-paragraph translation.
  - A Jira feed.
  - A kaiju outside the window.

[Unreleased]: https://github.com/jacobintern/session-office/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/jacobintern/session-office/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jacobintern/session-office/releases/tag/v0.2.0
