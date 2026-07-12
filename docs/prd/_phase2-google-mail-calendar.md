# PRD (Phase 2 stub): Google Gmail + Calendar sync

> Deferred to **Phase 2** (after PDF/docx import conversion). Stub only.
> **Mailspring is dead** — it was only ever chosen for OSS/extensibility and is being abandoned. This feature is rebuilt natively on **Google APIs**.

## Summary
Let employees sync their **@syv.ai Gmail and Google Calendar** into Holi — read their mail/threads and calendar events, and link them to tasks and notes. Because identity is already **Google Workspace SSO** (see [auth-identity](auth-identity.md)), this rides the same OAuth: no separate mail client, no bridge, no handshake.

## Why this shape
- Syv is a Google-Workspace company; @syv.ai mail and calendar are Google. Using the **Gmail API + Google Calendar API** under the existing SSO grant (incremental scopes) is the on-brand, lowest-friction path — and replaces the entire Mailspring plugin/HTTP/SSE bridge with standard API calls.
- Aligns with the existing Google Drive integration thinking (BYO scopes, multi-account) — a shared "Google connector" story.

## Goals
- OAuth incremental consent for Gmail (readonly + send) and Calendar (readonly + events) scopes.
- Read: list/search threads, read a thread; list calendars, list events (agenda).
- Link: attach an email or a calendar event to a **task** or **note** (`related[]`), like the old app's email/event task-seeding — but on Google data.
- Agent MCP ops for mail + calendar — the MCP surface is minimal and native-first, and these are the two ops that are external services rather than plain files (see the [agent PRD](agent.md)).
- Reminders/agenda: create a task from an event; task lights up for a recurring event series.

## Non-goals (phase 2)
- Being a full email client. Holi reads + links + composes lightly (mailto/send), it doesn't replace Gmail.
- Persisting mail/calendar as vault content (keep Google as source of truth; cache transiently, like the old "Holi never persists mail").

## Open questions
- Scope minimization + Google verification/review for the added scopes.
- Per-user (each employee's own mailbox) — confirms tier-2; how the agent's mail/calendar ops scope to the acting user.
- Multi-account (personal + syv.ai)? The old Drive design wanted multi-account — decide if mail/calendar follows.
- Push/watch (Gmail push notifications, Calendar watch) vs polling.

## Dependencies
auth-identity (Google OAuth, incremental scopes), agent (mail/calendar MCP ops), tasks (related[] to email/event; create-from-event), server-data (token storage, transient cache).
