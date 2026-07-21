# PRD (Phase 2 stub): Google Gmail + Calendar sync

> Deferred to **Phase 2** (after PDF/docx import conversion). Stub only.
> **Mailspring is dead** — it was only ever chosen for OSS/extensibility and is being abandoned. This feature is rebuilt natively on **Google APIs**.

## Summary
Let employees sync their **@syv.ai Gmail and Google Calendar** into Holi — read their mail/threads and calendar events, and link them to tasks and notes.

**This now needs its own Google OAuth grant.** Sign-in is GitHub ([`auth-identity.md`](auth-identity.md)), so there is no existing Google consent to ride on and no server to hold a refresh token — Google auth becomes a **per-user, per-machine desktop OAuth flow** with the token in the OS keychain, alongside the GitHub one. That is a real addition this stub previously got for free, and it is shared with the **Google Drive integration** [`../vision.md`](../vision.md) names.

## Why this shape
- Syv is a Google-Workspace company; @syv.ai mail and calendar are Google. Using the **Gmail API + Google Calendar API** directly replaces the entire Mailspring plugin/HTTP/SSE bridge with standard API calls.
- **Build the Google connector once** — Drive, Gmail, and Calendar are one auth surface and should share it.
- **This is where an MCP server legitimately returns.** Mail and calendar are external services, not files in the repo, so they are the one category the "no ops, it's all files" rule does not cover ([`agent.md`](agent.md)).

## Goals
- OAuth incremental consent for Gmail (readonly + send) and Calendar (readonly + events) scopes.
- Read: list/search threads, read a thread; list calendars, list events (agenda).
- Link: attach an email or a calendar event to a **task** or **note**. How — a frontmatter field, or a URL in the body — is open; `related[]` no longer exists ([`tasks.md`](tasks.md)).
- Agent MCP ops for mail + calendar (see above).
- Reminders/agenda: create a task from an event; task lights up for a recurring event series.

## Non-goals (phase 2)
- Being a full email client. Holi reads + links + composes lightly (mailto/send), it doesn't replace Gmail.
- Persisting mail/calendar as vault content (keep Google as source of truth; cache transiently, like the old "Holi never persists mail").

## Open questions
- **Desktop Google OAuth without a server.** A confidential client secret can't ship. Loopback + PKCE is the native-app pattern and works, but confirm Google's rules for the required scopes.
- Scope minimization + Google verification/review for the added scopes.
- Multi-account (personal + syv.ai)?
- Push/watch (Gmail push notifications, Calendar watch) vs polling — polling is the likely answer with no server to receive a webhook.
- How an email/event link is represented in a task file now that `related[]` is gone.

## Dependencies
[`auth-identity.md`](auth-identity.md) (a second OAuth provider alongside GitHub, keychain token storage), [`agent.md`](agent.md) (the returning MCP surface), [`tasks.md`](tasks.md) (linking an email/event to a task; create-from-event).
