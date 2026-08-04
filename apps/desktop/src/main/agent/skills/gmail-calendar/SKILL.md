---
name: gmail-calendar
description: Read the user's Google Calendar and Gmail — their agenda, and mail search/read — and link an event or thread into a task or note. Use whenever the user asks about their schedule, a meeting, or an email.
---

# Gmail & Calendar

The user's Google account is connected to Holi. You can **read** their calendar
and mail through one command; you cannot send mail or change their calendar
(the granted scopes are read-only, so those are not merely discouraged — they
are impossible).

## The command

`$HOLI_GOOGLE_BIN` is the absolute path to the `holi-google` command. Everything
returns JSON on stdout.

```sh
"$HOLI_GOOGLE_BIN" agenda                      # the next 7 days
"$HOLI_GOOGLE_BIN" agenda 2026-08-04T00:00:00Z 2026-08-05T00:00:00Z
"$HOLI_GOOGLE_BIN" search 'from:jane is:unread'
"$HOLI_GOOGLE_BIN" search ''                   # the inbox
"$HOLI_GOOGLE_BIN" read <threadId>
```

If `$HOLI_GOOGLE_BIN` is empty, or the command says Holi is not running or
Google is not connected, tell the user to connect Google in Holi's vault
settings. Do not try to reach Google another way — there is no other way, and
the tokens are deliberately unreachable from here.

`search` takes **Gmail's own query grammar** verbatim: `from:`, `to:`,
`subject:`, `is:unread`, `has:attachment`, `newer_than:7d`, and so on. Quote the
whole query so the shell keeps it in one piece.

## What comes back

`agenda` → an array of events, already sorted, already expanded (a weekly
meeting appears once per occurrence, not once as a rule), with declined and
cancelled events removed:

```json
[{ "id": "...", "title": "Q2 review", "start": "2026-08-04T09:00:00Z",
   "end": "...", "allDay": false, "location": "...", "calendarName": "Me",
   "htmlLink": "https://calendar.google.com/...", "meetLink": "https://meet.google.com/..." }]
```

`search` → one entry per thread: `id`, `subject`, `from`, `date`, `snippet`,
`unread`, `messageCount`, `webUrl`.

`read` → `{ id, subject, webUrl, messages: [{ from, to, date, body }] }`. Bodies
are **plain text** — HTML mail has been converted. Do not expect markup.

## Linking an email or event into the vault

This is the part that matters. A link to mail or calendar is **an ordinary
markdown link in the file's body** — never a frontmatter field, and never a
`[[wiki-link]]` (those resolve to vault files; these targets are URLs):

```markdown
[Q2 review](https://calendar.google.com/...)
```

Use the `htmlLink` (events) or `webUrl` (threads) **exactly as returned**. They
are built to survive: a mail `webUrl` is a search by RFC-822 message id —

```
https://mail.google.com/mail/u/0/#search/rfc822msgid:<the message id>
```

— which opens the right message even when several Google accounts are signed
in. A hand-assembled `#inbox/<id>` link does not: the `/u/0/` segment is a
*login slot*, not an account, so it silently opens the wrong mailbox. **Never
construct a Gmail URL yourself; copy `webUrl`.**

To answer "what is linked to this meeting?", `grep` the vault for the URL. There
is no index and nothing to keep in sync — that is the point.

## Making a task from an event or thread

Write an ordinary task file (`task.<slug>.md`, per `AGENTS.md`) and put the link
in the body:

```markdown
---
title: Prepare the Q2 review
status: todo
due: 2026-08-04
---

[Q2 review](https://calendar.google.com/...)
```

## Rules

- **Read-only.** If asked to send mail, reply, or create/move an event, say
  plainly that Holi's Google connection is read-only, and offer the alternative:
  you can draft the text, and the user sends it from Gmail.
- **Do not cache.** Ask the command again rather than reusing an old answer;
  the user's calendar changes while you work.
- **Do not copy mail bodies into the vault** unless the user asks. Link instead
  — Google stays the source of truth, and a vault is shared with teammates who
  may not be on the thread.
