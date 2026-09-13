# The completion popover is ours

**Date** 2026-09-13 · **Item** `docs/upcoming.md` #12 · **Status** agreed, not built

> The UI for the slash command popover (and the "@" popover) use the standard
> codemirror layout, font etc. We should make it our own, ideally a full shadcn ui
> component with proper hover and focus states, and sub menus if possible.

## What is there today

One popup serves everything. `autocompletion()` is installed in three places:

| Call site                           | Sources                                             |
| ----------------------------------- | --------------------------------------------------- |
| `editor/extensions.ts:143`          | `@`-mentions, `/`-commands, markdown tables (notes) |
| `editor/extensions.ts:207`          | markdown tables (mail composer)                     |
| `editor/settings-completion.ts:140` | settings keys and their values (plain files)        |

Its chrome is `theme.ts:499-513`, and that block is hardcoded dark hex:
`#1f1f1f` panel, `#2563eb` selection, `#e5e5e5` text. Its own comment says CM's
default light tooltip rendered our inherited light text white-on-white, so the
fix at the time was to force dark. **That makes the completion popup the one
overlay in the app that ignores D64 theming and light mode.** Two rules below it,
`.cm-wiki-preview` already uses `var(--popover)` and gets both for free.

Rows are CodeMirror's defaults: its unicode type-glyph, the label, `detail`, 2px
padding. No grouping, no second level.

**The font is already right, and deliberately.** The tooltip is a child of
`.cm-editor` rather than of `.cm-scroller`, so it inherits the app's UI font, not
the vault's prose font. `notesFontTheme`'s closing line says so: "The menu font
is left alone: that is UI." Item 12's mention of "font" is answered; the chrome
and the rows are the real gap.

## Decisions taken

1. **Scope is every completion popup**, not only the notes editor's two. One
   surface, themed once.
2. **Keep CodeMirror's engine and replace its clothes.** Keyboard navigation,
   filtering, ranking, scroll-into-view, flipping and a11y stay CM's, and they
   are correct today. Rejected: our own DOM panel with our own engine (total
   control, but reimplements all of the above across three stacks and throws
   away working code), and a React overlay driven by CM state (gets Radix
   submenus literally, but Radix menus are built to take focus while the editor
   must keep it, and no React lives inside CodeMirror anywhere in this app).
3. **In scope:** a second level for commands that take an argument, grouped
   sections with headers, richer rows. **Out:** the side preview panel CM
   offers through `Completion.info`.
4. **Row shape:** one line, with real trailing meta rather than grey words.

Verified against the installed `@codemirror/autocomplete@6.20.3` typings:
`Completion.section`, `optionClass`, `icons: false` and `addToOptions` (default
positions: icons 20, label 50, detail 80) all exist. Only the second level does
not.

## 1. One config, three call sites

A new `editor/completion.ts` exports `holiCompletion(sources)`, wrapping
`autocompletion()` with our `icons: false`, `optionClass` and `addToOptions`. All
three call sites use it. That is what makes "every popup" true by construction
rather than by remembering to.

## 2. The chrome

`theme.ts`'s autocomplete block loses its hex:

- panel: `--popover`, `--popover-foreground`, `--shadow-popover`, `--radius-md`
- section rule: `--divider`
- detail and section headers: `--muted-foreground`
- selected row: `--accent` / `--accent-foreground`, which is exactly what
  `DropdownMenuItem` uses for `focus:`. Same gesture, same look.
- matched text: `--brand`, **not** `--primary`. `index.css`'s role note at the
  top: "Reach for `text-brand`, never `text-primary`."

Light mode and per-vault themes then work because these are tokens, not because
a second arm was added.

It stays in `editorTheme` (a `baseTheme`), so every stack inherits it, including
the mail composer and the plain/code editor.

## 3. A row

Left icon, label with CM's own match highlighting kept, trailing meta.

- **The icon comes from `type`**, which CM accepts as any string, mapped through
  our own table. A task reuses the explorer's glyph vocabulary from
  `features/explorer/icons.tsx` (`SquareCheck` done, `SquareDot` doing, `Square`
  todo), so a task in the list looks like the same task in the tree. A note uses
  its emoji from `snapshot.icons` when it has one, the markdown glyph otherwise.
- **The trailing chip does not repeat the glyph.** Status is said on the left,
  so the chip carries the due date when there is one and nothing when there is
  not. `MentionData` gains `due` and `icon`; `snapshot.tasks` already carries
  `due` (`EditorPane.tsx:176` reads it) and `snapshot.icons` is a path → emoji
  map, so both call sites (`EditorPane.tsx`, `TaskBodyEditor.tsx`) pass them
  through.
- **The `↵` hint on the selected row is CSS on `li[aria-selected]`, not a
  render.** CM moves the selection by toggling that attribute without
  re-rendering rows, so a hint rendered per row would go stale the moment the
  selection moved.
- Sources that we do not author (markdown tables) and rows with no meta degrade
  to icon plus label, which is what they render today.

## 4. Sections

`@` gets shared section objects (Notes rank 1, Tasks rank 2), created once and
referenced by every option, as CM recommends.

`/` ships **unsectioned**. One header over two commands is noise; item 11 is what
earns the groups. Table and settings completions stay unsectioned and sort above
any sections, which is CM's documented behaviour for options without one.

## 5. The second level

`/table` stops inserting a fixed 2×2 skeleton.

- Picking `table` inserts the text `/table ` and calls `startCompletion(view)`.
  `Completion.apply` may be a function, and it is responsible for the
  `pickedCompletion` annotation on any transaction it fires.
- A second source in `slash.ts` matches `/table <args>` and offers sizes. Its
  `from` is the `/`, so picking a size replaces the whole command rather than
  leaving `/table ` behind.
- **The sizes are columns × body rows, and the header row is implied**, because
  every GFM table has one. Today's `TABLE` constant is 2 columns with a header
  and one body row, so it is `2 × 1` in this notation. The offered set is
  `2 × 1`, `2 × 3`, `3 × 3` and a custom entry where typing `4x2` is accepted
  as text. "With a header" is not an option: there is no table without one.
- The trail line is the section's `header` callback, which CM renders inside the
  list. The header element needs `display: list-item`, per the typings.
- **Going back needs no code.** Backspace through the space and `/table` matches
  the first-level source again.

One extra keystroke reaches the old behaviour: `/table` Enter Enter gives today's
table, since `2 × 1` is the first option.

## 6. Motion

Per D97's vocabulary, and nothing that cannot name one of the four behaviours:

- **Panel open is `arrive`**: a keyframe in `editorTheme`, the way `cm-ask-in`
  already is, with its origin following whether CM placed the tooltip above or
  below the caret.
- **Selection and hover are `respond`**: a background transition at
  `--motion-respond`, reversing when you leave.
- Nothing loops.

**The cross-fade between levels is deliberately not built.** CM rebuilds the
option `<ul>` on every keystroke that changes the list, so an animation on it
would replay on every character typed. Telling "the level changed" apart from
"the filter changed" needs a signal CM does not hand us cheaply. The trail line
appearing is the signal instead.

## 7. Tests

- The sources stay pure and keep their node tests (`test/slash.test.ts`,
  `test/mentions.test.ts`), which gain the argument source and the chained
  `apply`.
- The row renderers are `(completion) => Node`, testable without an editor.
- One dom test mounts an `EditorView` and asserts the popup's DOM, following
  `editor/__tests__/settings-completion.test.tsx`.

## 8. Deliberately out of scope

- The side preview panel (`Completion.info`).
- A "create this note" row when `@` matches nothing.
- Any new slash command. `/date` was considered and belongs to item 11.
- A real nested flyout beside the list, which only the rejected approaches buy.

## Files

| File                                                             | Change                                   |
| ---------------------------------------------------------------- | ---------------------------------------- |
| `editor/completion.ts`                                           | new: shared config and row renderers     |
| `editor/slash.ts`                                                | `/table` gains arguments; second source  |
| `editor/mentions.ts`                                             | semantic types, `due` and `icon` on rows |
| `editor/extensions.ts`                                           | two call sites use `holiCompletion`      |
| `editor/settings-completion.ts`                                  | third call site                          |
| `editor/theme.ts`                                                | the chrome, on tokens, plus the keyframe |
| `composites/EditorPane.tsx`, `features/tasks/TaskBodyEditor.tsx` | pass `due` and `icon`                    |
