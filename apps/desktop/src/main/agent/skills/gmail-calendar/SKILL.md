---
name: gmail-calendar
description: Read and act on the user's Google Calendar and Gmail — their agenda, mail search/read, triage, drafting, sending, and time-blocking — and link an event or thread into a task or note. Use whenever the user asks about their schedule, a meeting, or an email.
---

# Gmail & Calendar

The user's Google account is connected to Holi. One command, `holi-google`,
reads and acts on both.

**The rule that sorts everything you can do here: you may do anything the user
can undo, and Holi asks them first for the two things they cannot.**

| | What | Why |
| --- | --- | --- |
| Just do it | `mark-read`, `star`, `archive`, `trash`, `draft`, `schedule`, `reschedule`, `unschedule` | each has a one-click undo in Gmail or Google Calendar |
| Holi asks the user, every time | `send`, `reply` | mail that has reached someone cannot be recalled |
| Not possible at all | deleting mail permanently; touching an event that has **attendees** | the first is not granted; the second would email people, so Holi refuses it |

You do not need to ask permission before the first group — that is what the
group is. For `send` and `reply`, a prompt appears for the user **every single
time**, even if they allowed it before. That is expected. It is not an error and
not something to work around.

## The command

`holi-google` is on your `PATH`. (`$HOLI_GOOGLE_BIN` is its absolute path and
also works.) Everything returns JSON on stdout.

```sh
holi-google agenda                      # the next 7 days
holi-google agenda 2026-08-04T00:00:00Z 2026-08-05T00:00:00Z
holi-google search 'from:jane is:unread'
holi-google search ''                   # the inbox
holi-google read <threadId>
```

If the command says Holi is not running or Google is not connected, tell the
user to connect Google in Holi's vault settings. Do not try to reach Google
another way — there is no other way, and the tokens are deliberately
unreachable from here.

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

## Acting on mail

```sh
holi-google mark-read <threadId> [--unread]
holi-google star <threadId> [--off]
holi-google archive <threadId>          # out of the inbox, still in All Mail
holi-google trash <threadId>            # Gmail's trash, recoverable for 30 days
```

**Writing mail — the body always comes from stdin**, so a multi-line message
survives intact:

```sh
holi-google draft --to ada@syv.ai --subject 'Q2 budget' <<'EOF'
Hi Ada,

Here are the numbers.
EOF

holi-google draft --thread <threadId> --to ada@syv.ai --subject 'Re: Q2 budget' <<'EOF'
Sounds good.
EOF

holi-google reply <threadId> <<'EOF'     # recipients and subject come from the thread
Yes, Tuesday works.
EOF

holi-google send --to ada@syv.ai --subject 'Q2 budget' [--cc bo@syv.ai] <<'EOF'
Hi Ada,
EOF
```

**Prefer `draft` unless the user asked you to send.** A draft reaches nobody,
needs no confirmation, and leaves them one click from sending — so "write Ada a
reply about the budget" means `draft`, and only "send it" means `send`. When you
draft, say so plainly and say where it is, rather than implying it went out.

For `reply`, do not pass recipients or a subject: they are derived from the
thread, including the headers that keep the message *in* that thread. Composing
a `send` by hand instead would start a new one.

## Acting on the calendar

```sh
holi-google schedule --title 'Deep work' --start 2026-08-06T09:00:00Z --end 2026-08-06T11:00:00Z
holi-google schedule --title 'Off' --start 2026-08-06 --end 2026-08-07 --all-day
holi-google reschedule <eventId> [--start <iso>] [--end <iso>] [--title <t>]
holi-google unschedule <eventId>
```

This is for **the user's own time** — blocking out work, moving their own
blocks. Events with attendees are refused by Holi, because changing or deleting
one emails everybody on it. If the user wants that, say you cannot do it from
here and offer to let them do it in Google Calendar.

`unschedule` deletes a real event off a real calendar. Confirm with the user in
chat before using it on anything you did not just create.

Read the agenda before scheduling. An agent that blocks out an hour the user
already has a meeting in has made their day worse, not better.

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

- **Draft before you send.** Sending is the one thing here nobody can take
  back, so it is the one thing to be asked for rather than inferred.
- **One thread at a time when it is destructive.** Archiving twenty threads
  because the user said "clean up my inbox" is twenty things for them to undo.
  Say what you propose to archive, then do it.
- **`trash` is not `delete`.** It is recoverable for 30 days. Permanent deletion
  is not something Holi can do at all, so never promise it.
- **Do not cache.** Ask the command again rather than reusing an old answer;
  the user's calendar changes while you work.
- **Do not copy mail bodies into the vault** unless the user asks. Link instead
  — Google stays the source of truth, and a vault is shared with teammates who
  may not be on the thread.
