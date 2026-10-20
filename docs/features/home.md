# Home

What a vault opens on, unless its `home` setting names something else
([settings](settings.md)): the vault's library, after Notion's. One centred column: the vault's
name as the page's title, a row of tabs with search and New note at its end, and one plain table.

## How it works

- **Tabs.** Recent (every file, newest change first), Notes (markdown that is not a task), Tasks
  (task files) and Activity. A tab shows at most 50 rows: the library is a glance; the tree and
  the palette are the index.
- **One left edge.** The title (`text-2xl`, the size every page title takes), the first tab's icon,
  the table's header and every row's icon line up; the tabs and the rows hang their fills out past
  that edge. The title sits close over the tabs (`gap-3`), the table further below (`gap-6`).
- **The table** has three columns: the name with its icon, when it last changed, and who changed
  it. Rows are 44px with hairline dividers; a click opens the file, and a right-click offers Open,
  Open in new pane, Pin to sidebar and Copy path. Columns give way on a narrow
  pane (By goes first).
- **Git is the record of who and when** (`notes.fileCards`, `main/vault/file-cards.ts`): the last
  commit that touched each shown file, never the mtime, which a clone or a pull resets. A file
  with no commit yet falls back to its mtime and reads "Not committed".
- **Activity** is the newest commits, one line each (who, what, when, after Linear's issue
  activity), with the files each touched under it, any of which opens. Every save is a commit (a
  teammate's pulled in, the agent's), so this one list shows what the agent wrote or a teammate
  moved without either reporting it (`history.activity`, read when the vault's files change).
- **Search** is a field that opens from the magnifier, matching names; Escape closes it.
- **New note** makes `Untitled.md` (or `Untitled 2.md`…) at the root and opens it.
- Each region says what it is doing: a shimmer while who-and-when loads, an inline error with
  Retry, and an empty tab offers New note (or Clear search when a search found nothing). A failed
  who-and-when lookup costs only the By column: the names and times are already known, so the
  table stays and the error with Retry sits above it. Activity never clamps a commit's subject.
- With Home set to the recents, an empty list says "Nothing opened yet" and offers New note.

There is no folder view: a folder is expanded in the tree, and a folder that is a document (an
app) opens as itself.
