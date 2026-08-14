# PRD: Google Gmail + Calendar

> **Built and live** — connector and calendar D67 (2026-08-04), mail read-write D68, review fixes D69, the agent's write surface D70 (2026-08-05). No longer a stub; the deferred-to-phase-2 framing below has been overtaken and is kept only where the reasoning still holds.
> **Mailspring is dead** — it was only ever chosen for OSS/extensibility and was abandoned. This feature is built natively on **Google APIs**.

## Summary
Employees connect their **@syv.ai Gmail and Google Calendar** to Holi — read and triage their mail, read their calendar, block out their own time, and link any of it to tasks and notes. Both the UI and the agent act on it.

**This now needs its own Google OAuth grant.** Sign-in is GitHub ([`auth-identity.md`](auth-identity.md)), so there is no existing Google consent to ride on and no server to hold a refresh token — Google auth becomes a **per-user, per-machine desktop OAuth flow** with the token in the OS keychain, alongside the GitHub one. That is a real addition this stub previously got for free, and it is shared with the **Google Drive integration** [`../vision.md`](../vision.md) names.

## Why this shape
- Syv is a Google-Workspace company; @syv.ai mail and calendar are Google. Using the **Gmail API + Google Calendar API** directly replaces the entire Mailspring plugin/HTTP/SSE bridge with standard API calls.
- **Build the Google connector once** — Drive, Gmail, and Calendar are one auth surface and should share it.
- ~~**This is where an MCP server legitimately returns.**~~ **Declined (D67).** This was the long-standing prediction — mail and calendar are external services, not files in the repo, so they looked like the one category the "no ops, it's all files" rule could not cover. Building it showed the prediction was wrong: what the agent needs is *a documented command that returns JSON*, and `Bash` already runs commands. An MCP server would have added a process lifecycle and a handshake to deliver what a shell script delivers. See [`agent.md`](agent.md) §Tool surface.

## Goals — as built
- One Google OAuth grant, loopback + PKCE, main as sole token authority. Scopes: `gmail.modify`, `calendar.readonly`, `calendar.events`, `contacts.readonly`, `contacts.other.readonly`.
- **Read**: search/list threads, read a thread; list calendars, list events (agenda), with per-calendar visibility the user controls.
- **Act on mail**: mark read/unread, star, archive, trash, draft, send, reply. Trash is Gmail's trash — permanent deletion is impossible by scope and will stay that way.
- **Act on the calendar**: create, move and delete the user's *own* solo blocks (time-blocking). Events carrying attendees are refused, because changing or deleting one emails people.
- **Link**: an email or event attaches to a **task** or **note** as a plain markdown link in the body — never frontmatter, never a `[[wiki-link]]`. `related[]` does not exist ([`tasks.md`](tasks.md)).
- **The agent gets the same surface**, through a `holi-google` command rather than an MCP server, bounded by reversibility and gated on send ([`agent.md`](agent.md)).

## Goals — not yet built
- **Create a task from an event**, seeded with the link in its body. `tasks.create` takes an optional `description` for exactly this, so the plumbing exists and the affordance does not.
- **A task that lights up for a recurring event series** — the reminders/agenda tie-in ([`tasks.md`](tasks.md), [`daily-notes.md`](daily-notes.md)). Untouched by D67–D70.

## Non-goals
- Being a full email client. Holi reads, triages, links and composes; it does not replace Gmail.
- Persisting mail/calendar as vault content. Google stays the source of truth. There **is** a bounded on-disk cache in `userData` (not in a vault — mail is account data and a vault is a shared git repo), reconciled by a `history.list` delta. It is a cache, not a mirror: a wrong entry is a performance problem, and the next sync repairs it.
- Inviting anyone to anything. No attendee ever receives mail because of something Holi did.

## Open questions — resolved (D67, 2026-08-04)

The five forks below are settled in [`../specs/2026-08-04-google-mail-calendar-design.md`](../specs/2026-08-04-google-mail-calendar-design.md) and [`../decisions.md`](../decisions.md) D67. Summaries:

- **Desktop Google OAuth without a server** → **auth-code + PKCE, loopback `127.0.0.1` redirect**, in Electron main, a sibling of `device-flow.ts`. The existing **External** OAuth registration is reused; its `client_id`/desktop `client_secret` ship in the binary (non-confidential — PKCE is the protection).
- **Scope minimization + verification** → ~~read-only both~~ **superseded.** Mail is `gmail.modify` (D68) and calendar gained `calendar.events` (D70); `contacts.readonly` + `contacts.other.readonly` ride the same consent screen for `@`-completion. Verification is unchanged by all of it: `gmail.modify` sits in the same *restricted*/CASA tier `gmail.readonly` did, and the calendar and contacts scopes are *sensitive*, the lighter one. Calendar ships first; Gmail verifies in parallel while built in testing mode (≤100 test users). **The uncomfortable part, recorded rather than glossed:** no lesser scope grants `threads.modify`, so archive cannot be bought without also buying `messages.send`. "Holi cannot send" stopped being a fact about the grant the moment mail became writable and became a fact about the code and the gate.
- **Multi-account** → **single** connected account in v1; the token store is keyed by Google `sub` so more accounts is additive, not a rewrite.
- **Push vs polling** → **on-demand** fetch + short in-memory cache in main; no background poll (push is impossible with no server). Rely on Google's own notifications.
- **Link representation** → a **plain markdown link in the file body** (not frontmatter); the UI renders a chip via render-time URL detection. No `related[]` revival.

Also settled: the agent reaches Google via a **`holi-google` CLI + skill (no MCP)** over a main-held loopback ops channel; main is the **sole token authority**; UI is **workspace tabs**; disconnect revokes at Google and is independent of GitHub. Build order: **Connector → Calendar → Gmail → Agent skill.**

## The standing failure mode of this pillar
**Nothing in this repo has ever talked to Google.** Every response shape in every test is a fake written from documentation, and *a test that asserts what the code assumes, rather than what the external system does, passes while the feature is broken.* That has now happened four times — `missingScopes` seeded with the request form of the scopes, `otherContacts` needing `readMask` rather than `personFields`, the same call needing its own scope, and a permission rule written against a command string nobody compared to the invocation. Treat any new Google call as broken until it has run against a real account once, and write fakes that **refuse the way Google refuses**.

## Dependencies
[`auth-identity.md`](auth-identity.md) (a second OAuth provider alongside GitHub, keychain token storage, and the scope-widening trap), [`agent.md`](agent.md) (the `holi-google` command surface and the send gate — *not* an MCP surface), [`tasks.md`](tasks.md) (linking an email/event to a task; create-from-event).
