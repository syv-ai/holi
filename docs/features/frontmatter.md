# Frontmatter

A markdown file's YAML frontmatter is drawn as one block at the top of the editor: a summary bar that opens into typed rows (or the raw YAML), so metadata is editable without typing YAML and without a markdown editor touching it.

## How it works

**One widget, a few faces** (`editor/frontmatter.ts`). The frontmatter region is always replaced by an atomic block decoration. Collapsed, it is the **header**: a chevron and "1.8K chars · Last updated DD/MM/YY, name · v.14". Open, the same header (chevron down) sits over the fields. The chevron dispatches `toggleFrontmatter`. The char count is the body's (`bodyStart`), shown in K/M rounded down. The name is the last commit's git author, linked to `github.com/<name>`. `v.N` is how many commits touched the file (`notes.fileHistory`) and opens the history sidebar, focusing its own editor first; on a task file it is plain text. The line truncates rather than wraps. It keeps its space but stays invisible until the last-commit lookup has answered, then fades in whole; drawn earlier it would show the count alone and grow the rest. A failed lookup counts as an answer.

**What starts open.** Notes start collapsed. Files under `.claude/` and task files start revealed, because there the frontmatter is the point (a skill's `name` and `description`, a task's status and due). A task's block has no collapsed state and no chevron.

**No frontmatter still gets the bar.** A markdown file with no block gets the header as a `Decoration.widget` above line one (`side: -1`, so a caret at 0 is in the body), with no chevron and no way to add a block. Non-markdown files open in the plain stack and never get it.

**Typed rows.** `frontmatterSchema(path)` in `packages/shared` says what each key is per file kind: `enum`, `stamp`, `date`, `list`, `recurrence` or `text`. A task has status, priority, due, reminder, recurrence, tags (and a hidden `order`); a note has `tags`. Every schema key is drawn whether the file has it or not, and nothing is written until a value is given. Unknown keys are drawn as text and written back verbatim. A row with a value set shows an × under the pointer that removes it: a schema key is unset and its row stays, any other key is deleted with its row. A press anywhere on a row focuses its control. The last row is "add field": a name and a free-text value; schema keys, hidden keys, YAML-syntax names and empty values are refused. The rows are the widget's own DOM with value areas filled through a portal by the app's single React root (`frontmatter-portals.ts`, `FrontmatterFieldsHost`), so they use the real `Select` and `DateTimePicker`. Writes go through `editYamlMapping`, which keeps comments, key order and nested structure.

**A facts line over the rows**, read-only and never written to the file: "In <folder> · created DD/MM/YY, <author> · N links". The folder is derived (for a task it is its lane; changing it is a move, which belongs to the file tree), absent at the vault root. _Created_ is the file's first commit and its author, following renames; _links_ counts both directions, split in its tooltip. Fetched when the block opens, the line holds its height invisibly and fades in whole once main answers.

**Raw YAML fallback.** No schema (the agent surface, hidden paths) or frontmatter that is not a mapping gets a nested `EditorView` with the YAML grammar and highlighting, and none of the markdown stack. Its edits are written back over the region under a marker annotation, with the `---` fences rebuilt every time. Broken YAML turns the chevron red and holds the autosave (`frontmatterValid`).

**Scaffold on arrival.** A note gets `tags: []` however it arrived. The file tree's `+` writes it at creation; the `scaffold-md` pre-commit transform prepends it to any other markdown in the commit's added set (an agent's `Write`, a drop-in import, another editor). `wantsScaffold` excludes the agent surface (`CLAUDE.md`, `AGENTS.md`, `MEMORY.md`, `USER.local.md`, `.claude/`, `memory/`), task files, hidden paths and non-markdown. Transforms: [vaults-sync.md](vaults-sync.md).

**Look and motion.** The block takes one width open or closed (`min(24rem, …)`), is centred in the column, and keeps `2.5rem` beneath it. Opening animates from the old height to `auto`. Rows carry no edges and tint under the pointer.

## Rules

- Frontmatter never goes through the markdown stack. An errant ⌘B or slash command in YAML writes a file the task and daily parsers reject.
- The widget owns the region. Live preview skips it; GFM would otherwise read the `---` lines as rules.
- The widget's live state (nested editor, portal) is keyed by its DOM, not the widget instance. `updateDOM` hands the kept DOM to a new instance; state on the old one is stranded.
- A header-only change repaints the header in place, keeping the fields' caret.
- A nested write-back maps rather than rebuilds, so the validity cue is repainted directly from the nested editor.
- Nothing derivable is stored: no `created`, no `title`. Git's first commit is creation and the path is identity; a copy would drift.
- The scaffold runs on added files only, so a pulled or long-lived note is never rewritten. `decideReload` is deliberately not taught about it.
- The agent surface is never scaffolded and never drawn as rows. It is read verbatim as instructions, and a skill's frontmatter is Claude Code's contract, not ours.

## Rejected

- Plain-text values only: the status enum becomes a word you can misspell and dates are typed by hand.
- Hand-built controls inside the widget: a second date picker, in a layer that may not own form controls.
- A React block above the editor: frontmatter stops being part of the document.
- Un-hiding the region in the markdown editor instead of a nested editor: the markdown layers are wrong inside YAML.
- A button to add frontmatter on a file without it: the scaffold does that on commit.
- Scaffolding inside `normalize-md`: that transform only makes changes you would not notice, and this one is visible.

## Code

- `apps/desktop/src/renderer/src/editor/frontmatter.ts`, `frontmatter-region.ts`, `frontmatter-portals.ts`
- `apps/desktop/src/renderer/src/composites/FrontmatterFields.tsx`, `FrontmatterFieldsHost.tsx`, `FileFactsLine.tsx`, `FieldRow.tsx`
- `packages/shared/src/frontmatter-schema.ts`, `yaml-document.ts`, `scaffold-md.ts`
- `apps/desktop/src/main/vault/hooks/scaffold-md.ts`
