---
name: note-comments
description: Read, answer and resolve the comment threads on a note in this vault, or review a note by commenting on it. Use when someone asks what reviewers said about a note, asks you to address or answer comments, asks you to review a draft, or mentions open comments.
---

# Note comments

A note's comment threads are kept beside it, not in its text: in
`.holi/comments/<note path>.json`, committed and synced like the note. Each
thread is about a passage of the note and holds comments with an author, a time
and replies; it is open until someone resolves it. Use `holi comments`, never
edit the JSON by hand.

```sh
holi comments list                      # every note with open threads
holi comments list <path>               # a note's threads: passage, line, comments, status
holi comments list <path> --json        # the same as data, with ids
holi comments add <path> "<passage>" "<comment>"   # open a thread on a passage
holi comments reply <path> <thread> "<reply>"
holi comments resolve <path> <thread>
holi comments reopen <path> <thread>
```

- `<passage>` is text quoted exactly from the note, as short as makes clear
  what you mean (a sentence, a phrase). If it appears more than once, add
  `--line <n>` with the line it is on.
- A comment or reply can come from stdin instead of the last argument, for
  anything longer than a line.
- What you write is signed with the person's GitHub login and marked as their
  agent's. Teammates see it after the next sync.
- A thread marked detached is about a passage that is no longer in the note.

## Answering comments

Read the threads first. For each one you act on, change the note, then reply
saying what you changed, and resolve the thread when the comment is fully
addressed. Leave a thread open, with a reply, when it needs the person to
decide. Do not resolve a thread you only answered with a question.

## Reviewing a note

Comment on the passages that need a change, one thread per point, and say what
should change and why. Put general remarks in a reply to the first thread, or
tell the person in the session, rather than quoting the whole note.

`@login` in a comment mentions a teammate: they hear about it when their Holi
next pulls. Mention someone only when they must act.
