# History

A vault's history is its git history, and the autosave commits give it fine resolution. Holi shows it in two places: a drawer for the open file and a tab for the whole vault. Both present commits as commits, because the users are developers. Restore brings an old version back as a new commit.

**What the fresh renderer has.** The file's history is a dialog (`features/history/history-dialog.tsx`), opened from the history button in a document's or code file's header (`file-history-button.tsx`), with commits grouped by day and each commit's changes (`commit-view.tsx`). **Not built:** the right-hand file drawer and the vault history tab described below, and Restore from either ([not-built](../not-built.md)). `state/history.ts` still holds the loading, selection and restore actions they would use.

## How it works

**The file drawer.** A right-hand drawer, opened by the history button in the active pane's tab strip or by the `v.N` at the end of a markdown file's frontmatter header, task files included. It follows the focused file. Its header shows the file's revision count, uncapped, the same number as `v.N` and read from the same lookup. While it is open, a commit that takes the file refreshes the count and the list together, keeping the selection. The log is a flat `git log --follow` for that file, newest first and capped at 200 rows, each showing message, date, author, and lines added and removed. It is a drill-down, like the [nav menu](nav-menu.md)'s groups: the log fills the drawer, and picking a commit slides it away for that commit's own view, with Back to log at its top, then its message, date, author and short sha, the diff it made to this file against its parent in a read-only merge view, and Restore. The sha opens the commit on GitHub. Both views stay mounted, so going back finds the log where it was. Rows are 13px with an 11px meta line, the scale of the file tree's rows.

**Restore.** "Restore this version" asks for confirmation in a dialog, flushes open buffers, writes that commit's content to the file and commits it through the ordinary autosave, so it lands as `Update <path>` and pushes like any edit. The version you left stays in the log, and the drawer returns to it.

**The vault tab.** A singleton tab, opened from the sync item's panel in the nav menu or from the command palette. The left side is the app's one tree (`components/reui/tree.tsx`): days are its top level (Today, Yesterday, then dates), every day open to start, each holding its commits (newest first, 200) with their times. Picking a commit is expansion: it opens to its changed files, the row the right side shows wears the current-row fill, and the right side shows the commit's message, author, date, churn and short sha (which opens it on GitHub), then one collapsible per changed file, expanded, each with that file's diff. Picking one of its files narrows the right side to that diff; the commit's row widens it again. Each file fetches its own diff when first opened, so a large commit loads in parallel and reopening a file costs nothing. A search field in its header searches messages and authors, opening every day that matches.

## Rules

- History is append-only. Restore is a new commit, never a reset or rewrite.
- The log is flat: autosave commits are shown as they are, not folded into landmarks.
- Git's object store is the only snapshot store. There is no custom version store or retention policy.
- The file log follows renames, never copies. Git's `--follow` also walks a copy, and small files that share their frontmatter (every new task) look like copies of each other, so the log stops at a copy: that commit is the file's birth.

## Rejected

- Folding consecutive autosave commits and showing only landmarks: they are real commits and the reader is a developer.
- A coarser commit debounce to make the log quieter: it trades history noise for lost work. If the log proves too noisy, squashing the journal is the lever, and it leans no.
- A full-screen modal for the vault history: it blocks the window while you compare a commit against the note it changed.
- Hiding the drawer behind an abstract "version" model: nothing is dressed up as anything other than a commit.

## Code

- `apps/desktop/src/renderer/src/features/history/`: `history-dialog.tsx`, `commit-view.tsx`, `commit-groups.ts`, `line-diff.ts`, `code-language.ts`, `file-history-button.tsx`, `use-file-history.ts`, `commit-format.ts`
- `apps/desktop/src/renderer/src/state/history.ts`: loading, selection, restore
- `apps/desktop/src/renderer/src/features/history/use-file-history.ts`: `useFileHistory(path)`, the per-file lookup the history button and dialog share
- `apps/desktop/src/main/router.ts` (`history.*`, `notes.fileHistory`): log, changed files, per-file diff, restore
- `apps/desktop/src/main/vault/file-facts.ts`: revision count, first and last commit
- `apps/desktop/src/main/git.ts` (`log`, `show`, `changedFiles`): the git side
