---
name: notify
description: Tell the user something that needs their attention while they are not watching, with `holi agent notify`, and when not to. Use when working in the background (a scheduled run, a long task the user left you with) and you finish something they must review, hit a decision only they can make, or are blocked; and before notifying at all, to check it is worth it.
---

# Notifying the user

**Quiet by default.** A notification interrupts a person. Most of what you do
needs none: the result is in the vault, where they will find it.

```sh
holi agent notify "<title>" "<one line>" [--path <vault path>] [--session <id>]
```

It puts an entry in Holi's inbox (a nav item with an unread count), raises a
desktop notification if Holi is not the focused window, and adds a line to
today's work log, `.holi/state/log/<YYYY-MM-DD>.local.md`. Clicking the entry or
the notification opens `--path` (a note, task or file you wrote) or `--session`
(a conversation, by its job id). It prints `notified`, `added to the inbox`, or
`already in the inbox, not repeated`. It only works while Holi has this vault
open.

## When

Notify for:

- **A finished deliverable to review**: a draft reply, an offer, a report. Point
  `--path` at it.
- **A decision only the user can make**, that you cannot reasonably default.
- **A blocker** you cannot work around: a missing permission, a broken
  credential, a source that is down.

Do not notify for:

- Progress, or a routine run that found nothing new. Say so in your summary.
- Something you are about to ask in this conversation while the user is in it.
- A permission prompt or a question you are waiting on: Holi already tells the
  user when a session needs them.
- The same thing twice. One notification per finished piece of work, at the
  end, not one per step. Holi drops an exact repeat within five minutes, but
  do not rely on it.

## Writing it

- **Title**: what happened, in a few words: `Offer for Mads & Co drafted`.
- **Line**: what you need from them, in one sentence: `Check the prices before
  it goes out.`
- Plain text, no markdown. Nothing private beyond what the user would want on
  their lock screen.

To have it open this conversation from a background session, pass
`--session "${CLAUDE_JOB_DIR##*/}"` when `CLAUDE_JOB_DIR` is set. A file is
usually the better target: it is what they need to look at.

## Logging the rest

Everything worth remembering but not worth an interruption goes in your final
summary, and in a note or task where it belongs. The work log is personal to
this machine and never synced.
