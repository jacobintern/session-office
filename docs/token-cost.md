# Token cost

**Session Office is not a token-heavy tool: it costs under US$1 a month.**
Measured over 30 days on one heavy user's machine (2026-11-18), that was about
0.04% of the same period's Opus use (about US$1,500).

Almost everything it does runs in the mod and never reaches the model.

## Where the cost comes from

| part | how it works | token cost |
|---|---|---|
| the bridge (desk cards, Jira, Codex, instructions ↔ the artifact database) | every 5 s (`TICK_MS`) the mod calls ArtifactData with `$.tool.call`, without a model turn | **0** — a bridge session that had run 905 syncs had made no model request |
| desk cards, heartbeats and inbox in work sessions | the mod reads and writes files under `~/.claude/office/` | **0** — local file I/O |
| the report-format note (`REPORT_FORMAT` in `mod/hooks/register.tsx`) | added to each prompt you send: ~600 characters, ~130 tokens, which then stay in the conversation | **~US$0.6 a month** |

So the cost grows with the number of prompts you send, not with how often the
bridge syncs. ArtifactData calls cost nothing in tokens; they only use the
claude.ai server.

## The report-format note in numbers

- About 170 notes over 47 sessions in the 30 days measured.
- Each note is read again from the prompt cache by every later request in that
  session: about 2.23 M extra cache-read tokens in all, × US$0.20 per M tokens
  (Opus 5.5) ≈ US$0.45.
- Writing each note to the cache once: ~170 × 130 ≈ 22 k tokens × US$8 per M
  tokens (1-hour cache) ≈ US$0.17.
- Total ≈ US$0.62. Prices as of 2026-11.
- Notes add up within a session: after N prompts each request carries
  N × 130 extra tokens. The busiest session measured had 24 (≈ 3 k tokens)
  next to an average context of about 250 k tokens per request.

The note repeats a rule some users already keep in their own `CLAUDE.md`.
Adding it only when that rule is missing would save a few cents a month, not
worth the extra code.

## How it was measured

Scan the session logs under `~/.claude/projects` changed in the last 30 days:

- count the notes: attachments containing `Report format (Session Office)`;
- for each model request in a session, count the notes added since the
  previous request as a cache write (× 130 tokens), and the older ones as
  extra cache reads (× 130 tokens);
- price each by the request's model (Opus 5.5: US$0.20 per M cache-read
  tokens, US$8 per M tokens written with a 1-hour TTL, as of 2026-11);
- count each request once, keyed by `message.id` + `requestId`.

Not separated: the tokens spent developing Session Office itself, which are
mixed into sessions in other folders.
