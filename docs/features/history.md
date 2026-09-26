# History

A vault's history is its git history, and the autosave commits give it fine resolution. Holi shows it in two places: a drawer for the open file and a tab for the whole vault. Both present commits as commits, because the users are developers. Restore brings an old version back as a new commit.

## How it works

**The file drawer.** A right-hand drawer, opened by the history button in the active pane's tab strip or by the `v.N` at the end of a note's frontmatter header (not offered on task files). It follows the focused note. Its header shows the file's revision count, uncapped, the same number as `v.N`. The list is a flat `git log --follow` for that file, newest first and capped at 200 rows, each showing message, date, author, lines added and removed, and short sha. Picking a commit shows the diff it made to this file against its parent in a read-only merge view. The sha opens the commit on GitHub.

**Restore.** "Restore this version" asks for confirmation, flushes open buffers, writes that commit's content to the file and commits it through the ordinary autosave, so it lands as `Update <path>` and pushes like any edit. The version you left stays in the log.

**The vault tab.** A singleton tab, opened by clicking the sync state in the footer or from the command palette. The left side lists every commit in the vault (newest first, 200). Picking one shows one collapsible per changed file, expanded, each with that file's diff. Each file fetches its own diff when first opened, so a large commit loads in parallel and reopening a file costs nothing.

## Rules

- History is append-only. Restore is a new commit, never a reset or rewrite.
- The log is flat: autosave commits are shown as they are, not folded into landmarks.
- Git's object store is the only snapshot store. There is no custom version store or retention policy.
- The file log follows renames.

## Rejected

- Folding consecutive autosave commits and showing only landmarks: they are real commits and the reader is a developer.
- A coarser commit debounce to make the log quieter: it trades history noise for lost work. If the log proves too noisy, squashing the journal is the lever, and it leans no.
- A full-screen modal for the vault history: it blocks the window while you compare a commit against the note it changed.
- Hiding the drawer behind an abstract "version" model: nothing is dressed up as anything other than a commit.

## Code

- `apps/desktop/src/renderer/src/features/history/HistoryPanel.tsx`: the file drawer
- `apps/desktop/src/renderer/src/features/history/HistoryView.tsx`: the vault tab
- `apps/desktop/src/renderer/src/state/history.ts`: loading, selection, restore
- `apps/desktop/src/main/router.ts` (`history.*`, `notes.fileHistory`): log, changed files, per-file diff, restore
- `apps/desktop/src/main/vault/file-facts.ts`: revision count, first and last commit
- `apps/desktop/src/main/git.ts` (`log`, `show`, `changedFiles`): the git side
