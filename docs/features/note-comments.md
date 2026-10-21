# Note comments

A note can carry comment threads, the way a shared draft gets reviewed: each thread is about a passage of the note and holds comments with an author, a time and replies, open until someone resolves it. The threads live beside the note, never in its text, so its diffs and anything exported from it stay clean. The agent reads and answers them with `holi comments`.

## How it works

**A sidecar per note.** A note's threads are `.holi/comments/<note path>.json`, committed and synced like the note. Threads and comments are objects keyed by a short random id, never arrays, and the file is written with its keys sorted (`formatRecord`), so equal threads are equal bytes. A comment has an author (a GitHub login), an ISO time, a markdown body and, when the agent wrote it, `agent: true`. A thread has the passage it is about (its anchor), its comments and its last resolve or reopen (`status`, with who and when); one with no status is open. Holi checks only the fields it uses: a key it does not know, and a thread or comment it cannot read, are kept in the file and written back as they came, by every write and every merge; the panel and `holi comments` just do not list them. A file that is not a JSON object, or whose `threads` is not one, is refused, never written over.

**Anchored to a quote.** A thread holds the passage it was made on, up to 32 characters of text either side, and the line it started on, the way the W3C's TextQuoteSelector does. It is placed again whenever the note is read (`locateAnchor`), first match wins: the quote exactly, wherever it moved, repeats told apart by their context and then by nearness to the line; else whatever now sits between its prefix and suffix, at a plausible length (the passage was edited in place); else a span from the quote's first third to its last third (edited in the middle). A thread that none of these finds is **detached**: listed in the panel and by `holi comments list` with its quote, never dropped.

**In the editor.** The passages of a note's open threads have a quiet fill in the comment banner's `--comment-background` token, stronger for the thread the panel is on. They are placed when the threads load and then follow edits through CodeMirror's position mapping, so typing in or around a passage carries its mark along; a passage deleted outright is detached until the threads load again, which is the next time anything in the vault changes. A non-empty selection's tooltip offers **Comment** beside Ask agent; **Comment on selection** (⌘⌥M) in the palette does the same for the note editor last focused. Either opens the panel on a composer with the passage quoted. Task files have no threads, since their body is the task's editor, and neither does the agent surface (`AGENTS.md`, `CLAUDE.md`, `.claude/**`, `.holi/memory/**`), which is the agent's instructions rather than a document to review: the panel, the router and `holi comments` all refuse them (`isCommentableNote`). The threads read are the open vault's; switching vaults starts from none.

**The panel** is a drawer beside History, opened from the pane header's comments button or **Toggle comments**. Opening it closes History, and History opening hides it. It lists the focused note's threads under **Open** and **Resolved**, in the note's order, each with its passage, its line or that it is detached, its comments oldest first, and its last resolve or reopen. Picking a thread marks its passage and scrolls the editor to it. **Reply** opens a field (⌘↵ sends, Escape cancels), **Resolve** and **Reopen** flip the thread. What the panel writes is signed with the signed-in login.

**Merging.** Two people commenting at once must not pause sync. A merge driver, `holi-comments`, claims `.holi/comments/**/*.json` the way app records have theirs ([vaults-sync](vaults-sync.md)): threads and comments are unioned by id, a thread or comment deleted on one side and changed on the other is kept, and a resolve against a reopen keeps the later. Keys it does not know merge the same way, one side's change winning, so nothing is dropped. It refuses only text that is not a sidecar, which git then records as an ordinary conflict (`mergeCommentsText`). A sidecar changed on one side and deleted on the other (the note deleted while someone commented on it) never reaches the driver; a pull or a reconcile keeps the changed sidecar and, when nothing else conflicts, finishes the merge, so the comment survives as a detached thread of a note that is gone.

**Moving and deleting.** The commit-time `relink` transform moves a moved note's sidecar to its new path and deletes a deleted note's, at the commit boundary where git has paired a move's delete and add, so a move in the tree, by `git mv` or by the agent are one case. A sidecar already at the new path is left alone. History keeps a deleted note's threads as it keeps the note.

**Mentions.** `@login` in a comment mentions a teammate. With no server, a mention arrives with the commit that carries it: after a pull merges, or a reconcile's merge lands, Holi diffs the sidecars it changed (with rename detection, so a sidecar that moved with its note is compared with itself at its old path), finds the comments new to them that mention the person signed in and were written by someone else, and hands each to the plugins (`PluginCtx.onMention`). The agent plugin adds an inbox entry, "_login_ mentioned you", with the passage and the comment, opening the note ([agent-inbox](agent-inbox.md)); the inbox raises the banner by its own quiet rules. A mention written on this machine raises nothing here, and neither does a merge someone runs by hand in a terminal.

**The agent.** `holi comments list [path]` prints a note's threads with their passage, line or detached, comments, replies and status (`--json` for ids), or, with no path, every note with open threads. `add <path> <quote> <body>` opens a thread on text quoted exactly from the note, refusing a quote that is not there and asking for `--line` when it repeats; `reply <path> <thread> <body>` answers, both reading the body from stdin when it is not given; `resolve` and `reopen` take a thread id. What the agent writes is signed with the signed-in login and marked as that person's agent's, shown as "_login_'s agent". `list` is seeded into `permissions.allow`; the writes ask, since teammates see them. The shipped `note-comments` skill says how to answer threads (change the note, reply, resolve only what is addressed) and how to review a note.

## Rules

- A thread never touches the note's text. Exported PDFs, diffs and other tools see the note alone.
- A thread is never dropped for losing its passage; detached is a state, not a deletion.
- Only the person signed in writes, under their own login. Holi checks no permissions of its own ([auth](auth.md)): anyone who can push can write a sidecar.
- Anchors are not rewritten as a note changes. A thread keeps the passage it was made on, and the line hint only breaks ties, so a sidecar changes only when someone comments.
- The `<!-- -->` banners ([editor](editor.md)) stay as they are: text in the note, unrelated to threads.

## Rejected

- Comments inside the note (HTML comments, footnotes, CriticMarkup): they show in diffs and exports and have to be removed by hand, which is the problem this solves.
- One file of comments for the whole vault: every comment anywhere would touch the same file, and a merge would involve everyone who commented on anything.
- Arrays of threads and comments: two comments added at once are two insertions at one index, a text conflict; keyed by id they are two keys.
- Character offsets or line numbers as the anchor: any edit above a thread moves it.
- Rewriting anchors as the note changes: churn in a shared file on every edit, from every machine that has the note open.
- A notification service: there is no server. A mention reaches a teammate with their next pull.

## Code

- `packages/shared/src/note-comments.ts`: sidecar paths, the file format, `locateAnchor`, `mergeCommentsText`, `newMentions`, the CLI's text.
- `apps/desktop/src/main/vault/note-comments.ts`: reading and changing a sidecar, `followNoteComments` (run by `hooks/relink.ts`), `pulledMentions`.
- `apps/desktop/src/main/vault/comment-capabilities.ts`: `holi comments`; `main/router.ts` `comments.*` for the panel.
- `apps/desktop/src/main/vault/merge-drivers.ts`, `git-routes.ts` (`/merge/comments`): the merge driver.
- `apps/desktop/src/main/index.ts`: a pull's mentions to `plugins.mentioned`; `plugins/agent/main/inbox/mentions.ts`: the inbox entry.
- `apps/desktop/src/renderer/src/editor/comment-threads.ts`, `editor/askAgent.ts` (the selection's Comment), `state/comments.ts`, `features/comments/CommentsPanel.tsx`.
- `apps/desktop/src/plugins/agent/main/claude/vault/shipped/.claude/skills/note-comments/SKILL.md`.
