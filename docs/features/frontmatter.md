# Frontmatter

A markdown file's YAML frontmatter is drawn as one block at the top of the editor: a summary bar that opens into typed rows (or the raw YAML), so metadata is editable without typing YAML and without a markdown editor touching it.

## How it works

**One widget, a few faces** (`editor/frontmatter.ts`). The frontmatter region is always replaced by an atomic block decoration. Collapsed, it is the **header**: a chevron and "1.8K chars · Last updated DD/MM/YY, name · v.14". Open, the same header (chevron down) sits over the fields. The chevron dispatches `toggleFrontmatter`. The char count is the body's (`bodyStart`), shown in K/M rounded down. The name is the last commit's git author, linked to `github.com/<name>`. `v.N` is how many commits touched the file (`notes.fileHistory`) and opens the history sidebar, focusing its own editor first. The line truncates rather than wraps. It keeps its space but stays invisible until the last-commit lookup has answered, then fades in whole; drawn earlier it would show the count alone and grow the rest. A failed lookup counts as an answer. The lookup runs again whenever a commit takes the file (main's `vault:committed` push names the paths; a merged pull names none, meaning any), so a file opened before its first autosave commit fills in its date, name and version when that lands. The lookup is `fileHistoryAtom(path)` (`state/file-history.ts`), shared with the history drawer, so both ask once and agree.

**What starts open.** Notes start collapsed. Files under `.claude/` and task files start revealed, because there the frontmatter is the point (a skill's `name` and `description`, a task's status and due). A task's block has no collapsed state and no chevron.

**No frontmatter still gets the bar.** A markdown file with no block gets the header as a `Decoration.widget` above line one (`side: -1`, so a caret at 0 is in the body). A file with a schema (a note) gets the chevron too and opens to its rows, empty; the first value written inserts the block above line one, and opening alone writes nothing. A file with no schema gets the bar without a chevron. Non-markdown files open in the plain stack and never get it.

**Typed rows.** `frontmatterSchema(path)` in `packages/shared` says what each key is per file kind: `enum`, `stamp`, `date`, `list`, `recurrence` or `text`. A task has status, priority, due, reminder, recurrence, tags (and a hidden `order`); a note has `tags`. Every schema key is drawn whether the file has it or not, and nothing is written until a value is given. Unknown keys are drawn as text and written back verbatim. A row with a value set shows an × under the pointer that removes it: a schema key is unset and its row stays, any other key is deleted with its row. An optional select also offers an empty choice, listed as `—` and shown in the field as nothing, like a field never set. A task's `status` is never empty (absent reads as `todo`), so it has neither the empty choice nor an ×. The × floats just past the row's end, so it takes no column. A row is shadcn's horizontal `Field`, and its title is a real `<label>` for its control: a text or tags field takes the caret, a picker or select opens. Tags are a combobox of chips (shadcn's, on Base UI) that suggests the vault's task tags; Enter, a comma or leaving the field makes the typed text a tag. Below the rows, a `+` adds a field: a name and a free-text value; schema keys, hidden keys, YAML-syntax names and empty values are refused. The rows are the widget's own DOM with value areas filled through a portal by the app's single React root (`frontmatter-portals.ts`, `FrontmatterFieldsHost`), so they use the real `Select`, `Combobox` and `DateTimePicker`, in their `field` look. Writes go through `editYamlMapping`, which keeps comments, key order and nested structure.

**Raw YAML fallback.** No schema (the agent surface, hidden paths) or frontmatter that is not a mapping gets a nested `EditorView` with the YAML grammar and highlighting, and none of the markdown stack. Its edits are written back over the region under a marker annotation, with the `---` fences rebuilt every time. Broken YAML turns the chevron red and holds the autosave (`frontmatterValid`).

**A new note is empty.** The file tree's `+` creates it with no frontmatter, and nothing adds a block on commit: a note gets one when a value is first given, however it arrived. An empty block (`---` then `---`) reads as an empty mapping and draws as rows.

**Look and motion.** The block takes one width open or closed (`min(24rem, …)`), is centred in the column, and keeps `2.5rem` beneath it. Opening animates from the old height to `auto`. Values carry no edge and no fill, in either theme and under the pointer (the primitives' `field` variant); the row tints under the pointer instead.

## Rules

- Frontmatter never goes through the markdown stack. An errant ⌘B or slash command in YAML writes a file the task and daily parsers reject.
- The widget owns the region. Live preview skips it; GFM would otherwise read the `---` lines as rules.
- The widget's live state (nested editor, portal) is keyed by its DOM, not the widget instance. `updateDOM` hands the kept DOM to a new instance; state on the old one is stranded.
- A header-only change repaints the header in place, keeping the fields' caret.
- A nested write-back maps rather than rebuilds, so the validity cue is repainted directly from the nested editor.
- Nothing derivable is stored: no `created`, no `title`. Git's first commit is creation and the path is identity; a copy would drift.
- Nothing writes frontmatter the user did not give. A pre-commit transform that prepended `tags: []` to every new note was removed: it rewrote a file after the editor's save, outside `decideReload`, and the empty rows make it unnecessary.
- The agent surface is never drawn as rows. It is read verbatim as instructions, and a skill's frontmatter is Claude Code's contract, not ours.

## Rejected

- Plain-text values only: the status enum becomes a word you can misspell and dates are typed by hand.
- Hand-built controls inside the widget: a second date picker, in a layer that may not own form controls.
- A React block above the editor: frontmatter stops being part of the document.
- Un-hiding the region in the markdown editor instead of a nested editor: the markdown layers are wrong inside YAML.
- Writing frontmatter on a note's first commit (`scaffold-md`): a visible rewrite of someone's file to hold an empty list.

## Code

- `apps/desktop/src/renderer/src/editor/frontmatter.ts`, `frontmatter-region.ts`, `frontmatter-portals.ts`
- `apps/desktop/src/renderer/src/features/frontmatter/`: `FrontmatterFields.tsx` (kind to control), one file per control, `FrontmatterFieldsHost.tsx` (mounted by the Shell)
- `apps/desktop/src/renderer/src/composites/FieldRow.tsx`, `DateTimePicker.tsx`, `RecurrenceField.tsx`: the domain-agnostic rows and pickers, shared with task creation
- `apps/desktop/src/renderer/src/lib/date-presets.ts`: the date pickers' shortcuts
- `apps/desktop/src/renderer/src/primitives/Field.tsx`, `Combobox.tsx`, `field-look.ts`
- `packages/shared/src/frontmatter-schema.ts`, `yaml-document.ts`
