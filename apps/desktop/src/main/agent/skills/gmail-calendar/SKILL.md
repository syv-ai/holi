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
   "mine": true, "color": "#039be5",
   "htmlLink": "https://calendar.google.com/...", "meetLink": "https://meet.google.com/..." }]
```

**`mine` is the field to read before you say anything about "your" schedule.**
The user subscribes to other people's calendars — colleagues, meeting rooms,
birthdays. An event with `"mine": false` is **not something the user is doing**;
it is someone else's time, on the agenda so it can be compared against. Say
whose (`calendarName`) rather than folding it into their day. Answering "you
have four meetings tomorrow" when three of them are Jane's is the failure this
field exists to prevent.

You only ever see calendars the user has **switched on** in Holi. Most
subscribed calendars are off by default, so the absence of someone's events is
a deliberate choice and not something to work around — there is no flag to see
more, and asking Google another way is not available to you.

`search` → one entry per thread: `id`, `subject`, `from`, `date`, `snippet`,
`unread`, `answered`, `messageCount`, `webUrl`. **`answered`** means the last
message in the thread is one the user sent — they have replied and are waiting
on the other side. A thread with `"unread": true` or `"answered": false` is one
that may still need them; use those rather than guessing from dates.

`read` → `{ id, subject, webUrl, messages: [{ from, to, date, body }] }`. Bodies
are **plain text** — the sender's own text part where there is one, converted
from HTML otherwise. Do not expect markup, and do not ask for it: Holi's own
mail reader renders sanitized HTML, but this command strips it deliberately,
because a table layout would cost you context and tell you nothing.

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
