# Completion Popover Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every completion popup in the app is Holi's, on Holi's tokens, with our own rows, grouped sections, and a second level for `/table`.

**Architecture:** CodeMirror's autocomplete engine is kept and only its clothes are replaced. One new module, `editor/completion.ts`, owns the shared `autocompletion()` config and the row renderers; all three call sites go through it. The chrome moves into an exported `completionChrome` object in `theme.ts` so guards can read it. Design of record: [`docs/specs/2026-09-13-completion-popover-design.md`](../specs/2026-09-13-completion-popover-design.md).

**Tech Stack:** `@codemirror/autocomplete@6.20.3`, `@codemirror/view`, Vitest 4 (node + dom projects), `lucide-react` for the glyph geometry the guards compare against.

---

## Read this first: the four measured traps

Every one of these was measured in the running app on 2026-09-13 by reading `document.styleSheets` over CDP. Every one is silent in a browser.

1. **A CSS rule here wins on specificity, not on order.** All base themes land under one generated `.ͼ1` prefix, which cancels. CodeMirror writes `.cm-tooltip.cm-tooltip-autocomplete > ul` at (0,2,1); the block being replaced wrote `.cm-tooltip-autocomplete > ul` at (0,1,1) and **did nothing**. The popup is in browser-default `monospace` today, at CM's 10em cap and CM's `1px 3px` padding, and its selected row paints CM's `#347`, not the `#2563eb` in our file. The fix is `tooltipClass`, which stamps `cm-holi-completion` on the popup so every selector reads (0,3,n).
2. **`icons: false` would silently un-style the markdown-table menu.** `codemirror-markdown-tables` styles its own menu from roughly twenty rules keyed on `:has(.cm-completionIcon-table)`. Turning icons off deletes the element they hang from. Icons stay on; CM's glyph is hidden by CSS on our rows only.
3. **Do not contest `:has(.cm-completionIcon-table)`.** `:has()` carries its argument's specificity, so the table menu outranks everything. That is deliberate: it keeps its library's look.
4. **A per-row render cannot depend on which row is selected.** CM moves the selection by toggling `aria-selected` without re-rendering rows, so the `↵` hint is CSS on `li[aria-selected]`, never a conditional render.

Run the gates the repo's way: `pnpm -C apps/desktop exec vitest run --project node <file>` and `--project dom <file>`. Do not parallelise the node project.

---

## File Structure

| File                                                                      | Responsibility                                                      |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `apps/desktop/src/renderer/src/editor/completion.ts`                      | **New.** The shared config, the class names, the row renderers.     |
| `apps/desktop/src/renderer/src/editor/completion-icons.ts`                | **New.** The popup's SVG geometry, guarded against `lucide-react`.  |
| `apps/desktop/src/renderer/src/editor/theme.ts`                           | `completionChrome`, exported, on tokens, spread into `editorTheme`. |
| `apps/desktop/src/renderer/src/editor/extensions.ts`                      | Two call sites use `holiCompletion`.                                |
| `apps/desktop/src/renderer/src/editor/settings-completion.ts`             | Third call site; semantic `type`s.                                  |
| `apps/desktop/src/renderer/src/editor/mentions.ts`                        | Sections, semantic `type`s, emoji and due meta.                     |
| `apps/desktop/src/renderer/src/editor/slash.ts`                           | `/table`'s second level and its argument source.                    |
| `apps/desktop/src/renderer/src/composites/EditorPane.tsx`                 | Pass `icon` and `due` into `MentionData`.                           |
| `apps/desktop/src/renderer/src/features/tasks/TaskBodyEditor.tsx`         | Same.                                                               |
| `apps/desktop/test/completion.test.ts`                                    | **New.** Structural and chrome guards (node).                       |
| `apps/desktop/src/renderer/src/editor/__tests__/completion-rows.test.tsx` | **New.** Row renderers and the lucide drift guard (dom).            |

---

### Task 1: One config, three call sites

**Files:**

- Create: `apps/desktop/src/renderer/src/editor/completion.ts`
- Create: `apps/desktop/test/completion.test.ts`
- Modify: `apps/desktop/src/renderer/src/editor/extensions.ts` (lines 143 and 207)
- Modify: `apps/desktop/src/renderer/src/editor/settings-completion.ts:140`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/test/completion.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { COMPLETION_CLASS, OPTION_CLASS, holiOptionClass } from '@/editor/completion'

describe('a row we author is marked, and nothing else is', () => {
  test('our own sources name a `holi-` type, and get the class the chrome needs', () => {
    expect(holiOptionClass({ label: '/todo', type: 'holi-list-todo' })).toBe(OPTION_CLASS)
  })

  // codemirror-markdown-tables styles its own menu from ~20 rules keyed on
  // `.cm-completionIcon-table`. Marking its rows would lay our row layout over
  // theirs, and `:has()` means we would lose that fight anyway.
  test('a library’s row is left entirely alone', () => {
    expect(holiOptionClass({ label: '2x2', type: 'table' })).toBe('')
    expect(holiOptionClass({ label: 'plain' })).toBe('')
  })
})

describe('every completion popup goes through holiCompletion', () => {
  const read = (rel: string): string =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

  // The chrome hangs off a class that only `holiCompletion` stamps, so a call
  // site that reaches for `autocompletion()` directly gets CodeMirror's look
  // and says nothing about it. That is how the old block came to be dead.
  test.each([
    '../src/renderer/src/editor/extensions.ts',
    '../src/renderer/src/editor/settings-completion.ts',
  ])('%s does not call autocompletion() directly', (file) => {
    expect(read(file)).not.toMatch(/\bautocompletion\(/)
  })
})

test('the popup class is the one the chrome will look for', () => {
  expect(COMPLETION_CLASS).toBe('cm-holi-completion')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C apps/desktop exec vitest run --project node test/completion.test.ts`
Expected: FAIL, "Failed to resolve import `@/editor/completion`".

- [ ] **Step 3: Write the module**

Create `apps/desktop/src/renderer/src/editor/completion.ts`:

```ts
/**
 * The one completion popup.
 *
 * `autocompletion()` is installed in three places — the notes stack, the mail
 * composer, and settings files — and before this module each of them wore
 * CodeMirror's own chrome. They all go through `holiCompletion` now, which is
 * what makes "the popup is ours" true by construction rather than by
 * remembering to style a fourth call site later. `test/completion.test.ts`
 * fails if one appears.
 */
import { autocompletion, type Completion, type CompletionSource } from '@codemirror/autocomplete'
import type { Extension } from '@codemirror/state'

/**
 * Stamped on the popup element by `tooltipClass`, and the whole reason the
 * chrome in `theme.ts` can win the cascade.
 *
 * **Measured, 2026-09-13.** Base themes all land under one generated prefix,
 * which cancels, so a rule wins on its own weight. CodeMirror writes
 * `.cm-tooltip.cm-tooltip-autocomplete > ul` at (0,2,1). The block this
 * replaced wrote `.cm-tooltip-autocomplete > ul` at (0,1,1) and therefore did
 * nothing at all: read out of the running app's stylesheets, the popup's font,
 * height, padding and selected row were every one of them CodeMirror's. A
 * third class on every selector is what stops that happening again, and
 * `test/completion.test.ts` asserts each selector carries it.
 */
export const COMPLETION_CLASS = 'cm-holi-completion'

/** Stamped on rows whose source is ours, and only those. */
export const OPTION_CLASS = 'cm-holi-option'

/** Our sources name their glyph in `type`, which CodeMirror accepts as any
 *  string. The prefix is what tells our rows from a library's. */
export const HOLI_TYPE_PREFIX = 'holi-'

/** A `Completion` with the two extra fields our renderers read. CodeMirror
 *  ignores both and carries them through untouched. */
export interface HoliCompletion extends Completion {
  /** The trailing pill: a task's due date, and nothing that the glyph already
   *  says. */
  meta?: string
  /** Drawn instead of the type glyph, for a note whose vault gave it one. */
  emoji?: string
}

export function holiOptionClass(completion: Completion): string {
  return (completion.type?.startsWith(HOLI_TYPE_PREFIX) ?? false) ? OPTION_CLASS : ''
}

/**
 * **`icons` stays on, and that is not an oversight.** Turning it off deletes
 * `.cm-completionIcon`, which is the element every one of
 * `codemirror-markdown-tables`' rules hangs from — its menu would silently lose
 * its look. CodeMirror keeps rendering the element and `theme.ts` hides it on
 * our rows only.
 */
export function holiCompletion(sources: CompletionSource[]): Extension {
  return autocompletion({
    override: sources,
    tooltipClass: () => COMPLETION_CLASS,
    optionClass: holiOptionClass,
  })
}
```

- [ ] **Step 4: Wire the notes stack and the mail composer**

In `apps/desktop/src/renderer/src/editor/extensions.ts`, change the import on line 1 from

```ts
import { autocompletion, completionKeymap } from '@codemirror/autocomplete'
```

to

```ts
import { completionKeymap } from '@codemirror/autocomplete'
```

and add, beside the other local imports:

```ts
import { holiCompletion } from './completion'
```

Replace the notes-stack call (line 143):

```ts
    holiCompletion([mentionSource(deps.mentionData), slashCommands, markdownTableAutocompleter()]),
```

Replace the mail-composer call (line 207):

```ts
    // Table completion only. No `mentionSource` — `@` is how you type an email
    // address — and no `slashCommands`, whose commands are all vault actions.
    holiCompletion([markdownTableAutocompleter()]),
```

- [ ] **Step 5: Wire the settings stack**

In `apps/desktop/src/renderer/src/editor/settings-completion.ts`, change

```ts
import { autocompletion } from '@codemirror/autocomplete'
```

to

```ts
import { holiCompletion } from './completion'
```

and change the body of `settingsCompletion`:

```ts
export function settingsCompletion(path: string): Extension[] {
  const target = targetFor(path)
  if (target === null) return []
  return [holiCompletion([source(target)])]
}
```

- [ ] **Step 6: Run the test**

Run: `pnpm -C apps/desktop exec vitest run --project node test/completion.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 7: Typecheck and commit**

```bash
pnpm typecheck
git add apps/desktop/src/renderer/src/editor/completion.ts apps/desktop/src/renderer/src/editor/extensions.ts apps/desktop/src/renderer/src/editor/settings-completion.ts apps/desktop/test/completion.test.ts
git commit -m "feat(editor): one completion config, and all three call sites take it"
```

---

### Task 2: The chrome, on tokens, written to win

**Files:**

- Modify: `apps/desktop/src/renderer/src/editor/theme.ts:497-513`
- Modify: `apps/desktop/test/completion.test.ts`

- [ ] **Step 1: Write the failing guards**

Append to `apps/desktop/test/completion.test.ts`:

```ts
import { completionChrome } from '@/editor/theme'

describe('the chrome cannot go quietly dead again', () => {
  // The failure this catches is the one that was live for months: a selector
  // CodeMirror's own rule outranks applies nothing and reports nothing.
  test('every selector carries the class that wins the cascade', () => {
    for (const selector of Object.keys(completionChrome)) {
      if (selector.startsWith('@')) continue // keyframes have no selector
      expect(selector).toContain(COMPLETION_CLASS)
    }
  })

  // The popup was the one overlay in the app that ignored D64 theming and
  // light mode, because this block was written in hex.
  test('nothing here is a colour literal', () => {
    expect(JSON.stringify(completionChrome)).not.toMatch(/#[0-9a-fA-F]{3}/)
  })

  // `:has()` carries its argument's specificity, so the table menu outranks
  // anything here. Contesting it would only produce another dead rule.
  test('the markdown-table menu is left to its library', () => {
    expect(JSON.stringify(completionChrome)).not.toContain('cm-completionIcon-table')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -C apps/desktop exec vitest run --project node test/completion.test.ts`
Expected: FAIL, "`completionChrome` is not exported by `@/editor/theme`".

- [ ] **Step 3: Replace the block in `theme.ts`**

Add to the imports at the top of `apps/desktop/src/renderer/src/editor/theme.ts`:

```ts
import { COMPLETION_CLASS, OPTION_CLASS } from './completion'
```

Delete lines 497-513 (the comment `// autocomplete popover (mentions / slash / table) — dark, or CM's default light` through the `.cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionMatchedText` rule), and add this **above** `export const editorTheme`:

```ts
/** Every rule below is prefixed with this, and it is three classes on purpose.
 *  See `COMPLETION_CLASS`. */
const POPUP = `.cm-tooltip.cm-tooltip-autocomplete.${COMPLETION_CLASS}`

/**
 * The completion popup: mentions, slash commands, settings keys, and the
 * markdown-table menu, which is the one thing here deliberately left alone.
 *
 * **Exported so the guards can read it.** `test/completion.test.ts` asserts
 * three things the block this replaced got wrong: that every selector carries
 * `COMPLETION_CLASS`, without which CodeMirror's own rules outrank it and the
 * whole block is silently dead; that nothing here is a hex literal, because the
 * popup was the one overlay in the app that ignored D64 theming and light mode;
 * and that nothing contests `:has(.cm-completionIcon-table)`.
 *
 * The radius tokens carry fallbacks because they live in Tailwind's `@theme`,
 * which tree-shakes what it cannot see referenced, and Tailwind never scans
 * this file. The same reason `lib/motion.ts` writes `var(--motion-arrive,
 * 300ms)`.
 */
export const completionChrome = {
  [POPUP]: {
    background: 'var(--popover)',
    color: 'var(--popover-foreground)',
    // Borderless on the popover shadow, like every overlay in the app since
    // 2026-08-14 — see `primitives/Popover.tsx`.
    border: 'none',
    borderRadius: 'var(--radius-md, 6px)',
    boxShadow: 'var(--shadow-popover)',
    padding: '4px',
  },
  // The app's UI font, which is the point of item 12: CodeMirror's own rule
  // here is `fontFamily: monospace`, and it was winning.
  [`${POPUP} > ul`]: {
    fontFamily: 'inherit',
    fontSize: '13px',
    maxHeight: '18em',
    minWidth: '220px',
    padding: '0',
  },
  [`${POPUP} > ul > li`]: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '5px 8px',
    borderRadius: 'var(--radius-sm, 4px)',
    lineHeight: '1.4',
    color: 'var(--popover-foreground)',
  },
  // The same pair `DropdownMenuItem` uses for `focus:`. A keyboard-selected row
  // here and a focused menu item there are the same gesture.
  [`${POPUP} > ul > li[aria-selected]`]: {
    background: 'var(--accent)',
    color: 'var(--accent-foreground)',
  },
  // CodeMirror's own default for a section header is `border-bottom: 1px solid
  // silver` at 0.7 opacity, which belongs to no theme at all.
  [`${POPUP} > ul > completion-section`]: {
    borderBottom: 'none',
    borderTop: '1px solid var(--divider)',
    marginTop: '3px',
    padding: '7px 8px 4px',
    fontSize: '10.5px',
    fontWeight: '600',
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'var(--muted-foreground)',
    opacity: '1',
  },
  [`${POPUP} > ul > completion-section:first-child`]: {
    borderTop: 'none',
    marginTop: '0',
  },
  [`${POPUP} .cm-completionLabel`]: {
    flex: '1',
    minWidth: '0',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  [`${POPUP} .cm-completionDetail`]: {
    color: 'var(--muted-foreground)',
    fontStyle: 'normal',
    fontSize: '12px',
    flex: 'none',
  },
  [`${POPUP} > ul > li[aria-selected] .cm-completionDetail`]: { color: 'inherit' },
  // `--brand`, never `--primary`: `index.css`'s role note says the fill is not
  // a text colour.
  [`${POPUP} .cm-completionMatchedText`]: {
    color: 'var(--brand)',
    textDecoration: 'none',
    fontWeight: '600',
  },
  [`${POPUP} > ul > li[aria-selected] .cm-completionMatchedText`]: { color: 'inherit' },
  // CodeMirror's type glyph, hidden on our rows and only ours. The element has
  // to stay in the DOM: `codemirror-markdown-tables` hangs its whole menu off
  // `:has(.cm-completionIcon-table)`.
  [`${POPUP} > ul > li.${OPTION_CLASS} .cm-completionIcon`]: { display: 'none' },
}
```

Then spread it into the theme. Change line 9 from `export const editorTheme = EditorView.baseTheme({` so the object opens with the spread:

```ts
export const editorTheme = EditorView.baseTheme({
  ...completionChrome,
```

- [ ] **Step 4: Run the guards**

Run: `pnpm -C apps/desktop exec vitest run --project node test/completion.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Prove it parses, then commit**

The build is the real check that the CSS-in-JS is valid.

```bash
pnpm --filter @holi/desktop build
pnpm exec prettier --write apps/desktop/src/renderer/src/editor/theme.ts apps/desktop/test/completion.test.ts
git add apps/desktop/src/renderer/src/editor/theme.ts apps/desktop/test/completion.test.ts
git commit -m "fix(editor): the completion popup is themed, and its rules are no longer dead"
```

---

### Task 3: Our own rows

**Files:**

- Create: `apps/desktop/src/renderer/src/editor/completion-icons.ts`
- Create: `apps/desktop/src/renderer/src/editor/__tests__/completion-rows.test.tsx`
- Modify: `apps/desktop/src/renderer/src/editor/completion.ts`
- Modify: `apps/desktop/src/renderer/src/editor/theme.ts` (add to `completionChrome`)

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/editor/__tests__/completion-rows.test.tsx`:

```tsx
/**
 * The popup's rows, and the guard that keeps their glyphs honest.
 *
 * A CodeMirror option is built with `document.createElement`, so these
 * renderers are plain DOM and testable without an editor. The drift guard
 * renders the real `lucide-react` component and compares its shapes to the
 * geometry we hand-copied, because `lucide-react` exports components and not
 * geometry, and no React lives inside CodeMirror anywhere in this app.
 */
import { expect, test } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { FileText, ListTodo, Settings2, Square, SquareCheck, SquareDot, Table } from 'lucide-react'
import type { ComponentType } from 'react'
import { GLYPHS } from '../completion-icons'
import { holiIcon, holiMeta, holiEnterHint, type HoliCompletion } from '../completion'

// Typed, not inferred: `emoji` and `meta` are ours, and an object literal
// widened to CodeMirror's `Completion` would be rejected for carrying them.
const row = (c: HoliCompletion): HoliCompletion => c

/** Every shape in an SVG fragment, as comparable strings. */
function shapes(fragment: string): string[] {
  const doc = new DOMParser().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg">${fragment}</svg>`,
    'image/svg+xml',
  )
  return [...doc.documentElement.children].map(
    (el) =>
      `${el.tagName}:${[...el.attributes]
        .map((a) => `${a.name}=${a.value}`)
        .sort()
        .join(',')}`,
  )
}

const PAIRS: [string, ComponentType][] = [
  ['holi-note', FileText],
  ['holi-task-todo', Square],
  ['holi-task-doing', SquareDot],
  ['holi-task-done', SquareCheck],
  ['holi-list-todo', ListTodo],
  ['holi-table', Table],
  ['holi-setting', Settings2],
]

test.each(PAIRS)('%s is the same glyph lucide draws', (key, Icon) => {
  const markup = renderToStaticMarkup(<Icon />)
  const inner = markup.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '')
  expect(shapes(GLYPHS[key]!)).toEqual(shapes(inner))
})

test('a note with a vault emoji draws the emoji, not a glyph', () => {
  const node = holiIcon(row({ label: 'daily/2026-09-13', type: 'holi-note', emoji: '📓' }))
  expect((node as HTMLElement).textContent).toBe('📓')
})

test('a row from a source we do not author gets no icon of ours', () => {
  expect(holiIcon(row({ label: '2x2', type: 'table' }))).toBeNull()
})

test('the trailing pill appears only when there is something to say', () => {
  expect(holiMeta(row({ label: 'Write the retro', type: 'holi-task-todo' }))).toBeNull()
  const node = holiMeta(
    row({ label: 'Write the retro', type: 'holi-task-todo', meta: 'due 18 Sep' }),
  )
  expect((node as HTMLElement).textContent).toBe('due 18 Sep')
})

// CodeMirror moves the selection by toggling `aria-selected` and does NOT
// re-render the rows, so a hint rendered only for the selected row would go
// stale the moment you pressed an arrow key. It is rendered always and shown
// by CSS.
test('the enter hint is rendered on every row of ours, not just the selected one', () => {
  expect(holiEnterHint(row({ label: '/todo', type: 'holi-list-todo' }))).not.toBeNull()
  expect(holiEnterHint(row({ label: '2x2', type: 'table' }))).toBeNull()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -C apps/desktop exec vitest run --project dom src/renderer/src/editor/__tests__/completion-rows.test.tsx`
Expected: FAIL, cannot resolve `../completion-icons`.

- [ ] **Step 3: Write the glyphs**

Create `apps/desktop/src/renderer/src/editor/completion-icons.ts`:

```ts
/**
 * The popup's glyphs, as plain SVG fragments.
 *
 * **Hand-copied, and guarded rather than imported.** The explorer draws the
 * same task glyphs from `lucide-react` (`features/explorer/icons.tsx`), so a
 * task in this list should look like the same task in the tree. But a
 * CodeMirror option is built with `document.createElement`, and no React lives
 * inside CodeMirror anywhere in this app; `lucide-react` exports components,
 * not geometry, and its per-icon `__iconNode` is reachable only by a deep
 * import into `dist/`, which would break on any repackaging without saying so.
 *
 * So the geometry is copied here and
 * `__tests__/completion-rows.test.tsx` renders the real component and fails if
 * the two ever diverge. Copied from lucide-react 1.27.0.
 */

/** lucide's own SVG attributes, minus the ones a 14px inline icon re-states. */
export const SVG_ATTRS: Record<string, string> = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': '2',
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
  'aria-hidden': 'true',
}

export const GLYPHS: Record<string, string> = {
  // FileText
  'holi-note':
    '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/>' +
    '<path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  // Square / SquareDot / SquareCheck — the explorer's `TaskIcon` vocabulary.
  'holi-task-todo': '<rect width="18" height="18" x="3" y="3" rx="2"/>',
  'holi-task-doing':
    '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="12" cy="12" r="1"/>',
  'holi-task-done': '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 12 2 2 4-4"/>',
  // ListTodo
  'holi-list-todo':
    '<path d="M13 5h8"/><path d="M13 12h8"/><path d="M13 19h8"/><path d="m3 17 2 2 4-4"/>' +
    '<rect x="3" y="4" width="6" height="6" rx="1"/>',
  // Table
  'holi-table':
    '<path d="M12 3v18"/><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/>',
  // Settings2
  'holi-setting':
    '<path d="M14 17H5"/><path d="M19 7h-9"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
}
```

- [ ] **Step 4: Write the renderers**

Append to `apps/desktop/src/renderer/src/editor/completion.ts`:

```ts
import { GLYPHS, SVG_ATTRS } from './completion-icons'

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * The row's left glyph: the note's own emoji when its vault gave it one,
 * otherwise the glyph its `type` names. `null` for any row we do not author,
 * which leaves CodeMirror's icon showing — the table menu needs it.
 *
 * Built through `DOMParser` rather than `innerHTML`, so nothing here ever
 * parses a string as HTML into the live document.
 */
export function holiIcon(completion: Completion): Node | null {
  const { emoji } = completion as HoliCompletion
  if (emoji !== undefined && emoji !== '') {
    const span = document.createElement('span')
    span.className = 'cm-holi-icon cm-holi-emoji'
    span.textContent = emoji
    return span
  }
  const glyph = completion.type === undefined ? undefined : GLYPHS[completion.type]
  if (glyph === undefined) return null
  const parsed = new DOMParser().parseFromString(
    `<svg xmlns="${SVG_NS}">${glyph}</svg>`,
    'image/svg+xml',
  )
  const svg = document.createElementNS(SVG_NS, 'svg')
  for (const [name, value] of Object.entries(SVG_ATTRS)) svg.setAttribute(name, value)
  svg.setAttribute('class', 'cm-holi-icon')
  for (const child of [...parsed.documentElement.children]) svg.appendChild(child)
  return svg
}

/** The trailing pill. Only what the glyph does not already say: a task's status
 *  is drawn on the left, so this carries its due date or nothing. */
export function holiMeta(completion: Completion): Node | null {
  const { meta } = completion as HoliCompletion
  if (meta === undefined || meta === '') return null
  const span = document.createElement('span')
  span.className = 'cm-holi-meta'
  span.textContent = meta
  return span
}

/**
 * The `↵` on the selected row.
 *
 * Rendered on every row of ours and revealed by CSS, because CodeMirror moves
 * the selection by toggling `aria-selected` WITHOUT re-rendering the rows: a
 * hint rendered for the selected option only would be drawn once and then go
 * stale on the first arrow key.
 */
export function holiEnterHint(completion: Completion): Node | null {
  if (holiOptionClass(completion) === '') return null
  const span = document.createElement('span')
  span.className = 'cm-holi-enter'
  span.textContent = '↵'
  return span
}
```

and extend the config, replacing the body of `holiCompletion`:

```ts
export function holiCompletion(sources: CompletionSource[]): Extension {
  return autocompletion({
    override: sources,
    tooltipClass: () => COMPLETION_CLASS,
    optionClass: holiOptionClass,
    // CodeMirror's own positions: icons 20, label 50, detail 80.
    addToOptions: [
      { render: holiIcon, position: 20 },
      { render: holiMeta, position: 90 },
      { render: holiEnterHint, position: 95 },
    ],
  })
}
```

- [ ] **Step 5: Style the row parts**

Add to `completionChrome` in `theme.ts`, after the `.cm-completionIcon` rule:

```ts
  [`${POPUP} .cm-holi-icon`]: {
    width: '14px',
    height: '14px',
    flex: 'none',
    color: 'var(--muted-foreground)',
  },
  [`${POPUP} > ul > li[aria-selected] .cm-holi-icon`]: { color: 'inherit' },
  [`${POPUP} .cm-holi-emoji`]: {
    fontSize: '13px',
    lineHeight: '1',
    textAlign: 'center',
    display: 'inline-block',
  },
  [`${POPUP} .cm-holi-meta`]: {
    flex: 'none',
    fontSize: '10.5px',
    padding: '1px 6px',
    borderRadius: '9999px',
    background: 'var(--muted)',
    color: 'var(--muted-foreground)',
  },
  [`${POPUP} > ul > li[aria-selected] .cm-holi-meta`]: { color: 'inherit' },
  // Hidden until the row is selected, which is the whole reason it is rendered
  // on every row rather than on one. `opacity`, not `display`, so the row's
  // width does not jump as the selection moves.
  [`${POPUP} .cm-holi-enter`]: {
    flex: 'none',
    fontSize: '11px',
    color: 'var(--muted-foreground)',
    opacity: '0',
  },
  [`${POPUP} > ul > li[aria-selected] .cm-holi-enter`]: { opacity: '1', color: 'inherit' },
```

- [ ] **Step 6: Run both projects**

Run: `pnpm -C apps/desktop exec vitest run --project dom src/renderer/src/editor/__tests__/completion-rows.test.tsx`
Expected: PASS, 11 tests.

Run: `pnpm -C apps/desktop exec vitest run --project node test/completion.test.ts`
Expected: PASS, still 8.

- [ ] **Step 7: Commit**

```bash
pnpm exec prettier --write apps/desktop/src/renderer/src/editor/completion.ts apps/desktop/src/renderer/src/editor/completion-icons.ts apps/desktop/src/renderer/src/editor/theme.ts apps/desktop/src/renderer/src/editor/__tests__/completion-rows.test.tsx
git add apps/desktop/src/renderer/src/editor
git commit -m "feat(editor): a completion row is an icon, a label and what the icon does not say"
```

---

### Task 4: `@` gets sections, glyphs and due dates

**Files:**

- Modify: `apps/desktop/src/renderer/src/editor/mentions.ts`
- Modify: `apps/desktop/src/renderer/src/composites/EditorPane.tsx:86-89`
- Modify: `apps/desktop/src/renderer/src/features/tasks/TaskBodyEditor.tsx:62-66`
- Modify: `apps/desktop/test/mentions.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `apps/desktop/test/mentions.test.ts`:

```ts
// `DATA` is already taken at module scope in this file; this is the richer one.
const RICH = {
  notes: [{ path: 'work/retro.md', icon: '📓' }, { path: 'work/plan.md' }],
  tasks: [
    { path: 'task.a.md', title: 'Write the retro', status: 'doing' as const, due: '2026-09-18' },
    { path: 'task.b.md', title: 'Book the room', status: 'todo' as const },
  ],
}

test('notes and tasks are two sections, notes first', () => {
  const options = mentionCompletions(ctx('@'), RICH)!.options
  const sections = options.map((o) => (typeof o.section === 'string' ? o.section : o.section?.name))
  expect(sections.filter((s) => s === 'Notes')).toHaveLength(2)
  expect(sections.filter((s) => s === 'Tasks')).toHaveLength(2)
})

test("a task's glyph carries its status, so the row does not say it twice", () => {
  const options = mentionCompletions(ctx('@'), RICH)!.options
  expect(options.find((o) => o.label === 'Write the retro')?.type).toBe('holi-task-doing')
  expect(options.find((o) => o.label === 'Book the room')?.type).toBe('holi-task-todo')
  // The status used to be repeated in `detail`. The glyph says it now.
  expect(options.find((o) => o.label === 'Write the retro')?.detail).toBeUndefined()
})

test('a due date is the trailing pill, humanised the way the board writes it', () => {
  const options = mentionCompletions(ctx('@'), RICH)!.options
  const withDue = options.find((o) => o.label === 'Write the retro')
  expect((withDue as { meta?: string }).meta).toBe('due 18 Sep')
  const without = options.find((o) => o.label === 'Book the room')
  expect((without as { meta?: string }).meta).toBeUndefined()
})

test("a note wears the vault's own emoji when it has one", () => {
  const options = mentionCompletions(ctx('@'), RICH)!.options
  expect((options.find((o) => o.label === 'work/retro.md') as { emoji?: string }).emoji).toBe('📓')
  expect(
    (options.find((o) => o.label === 'work/plan.md') as { emoji?: string }).emoji,
  ).toBeUndefined()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -C apps/desktop exec vitest run --project node test/mentions.test.ts`
Expected: FAIL on the section test first ("expected [] to have length 2").

- [ ] **Step 3: Rewrite the option builders**

In `apps/desktop/src/renderer/src/editor/mentions.ts`, change the imports and `MentionData`:

```ts
import type {
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from '@codemirror/autocomplete'
import { formatWikiLink, type TaskStatus } from '@holi/shared'
import { shortStamp } from '@/lib/date-presets'
import type { HoliCompletion } from './completion'

export interface MentionData {
  notes: { path: string; icon?: string }[]
  tasks: { path: string; title: string; status: TaskStatus; due?: string }[]
}

/** Shared objects, as CodeMirror recommends: a section is matched by identity
 *  of name, and `rank` is what keeps Notes above Tasks rather than the
 *  alphabet. */
const NOTES = { name: 'Notes', rank: 1 }
const TASKS = { name: 'Tasks', rank: 2 }

/** The explorer's `TaskIcon` vocabulary, by status. */
const TASK_TYPE: Record<TaskStatus, string> = {
  todo: 'holi-task-todo',
  doing: 'holi-task-doing',
  done: 'holi-task-done',
}
```

and the two `map` calls inside `mentionCompletions`:

```ts
const noteOptions: HoliCompletion[] = data.notes
  .filter((n) => n.path.toLowerCase().includes(query))
  .map((n) => ({
    label: n.path,
    type: 'holi-note',
    section: NOTES,
    ...(n.icon === undefined ? {} : { emoji: n.icon }),
    apply: formatWikiLink(n.path),
  }))
const taskOptions: HoliCompletion[] = data.tasks
  .filter((t) => t.title.toLowerCase().includes(query))
  .map((t) => ({
    label: t.title,
    // No `detail: t.status` any more: the glyph on the left says the status,
    // and a row should not say one thing twice.
    type: TASK_TYPE[t.status],
    section: TASKS,
    ...(t.due === undefined ? {} : { meta: `due ${shortStamp(t.due)}` }),
    apply: formatWikiLink(t.path),
  }))
```

- [ ] **Step 4: Feed the two extra fields**

In `apps/desktop/src/renderer/src/composites/EditorPane.tsx`, replace lines 86-89:

```tsx
mentionRef.current = {
  notes: snapshot.docs.map((d) => ({
    path: d.path,
    ...(snapshot.icons[d.path] === undefined ? {} : { icon: snapshot.icons[d.path] }),
  })),
  tasks: snapshot.tasks.map((t) => ({
    path: t.path,
    title: t.title,
    status: t.status,
    ...(t.due === undefined ? {} : { due: t.due }),
  })),
}
```

Make the identical change in `apps/desktop/src/renderer/src/features/tasks/TaskBodyEditor.tsx` at lines 63-66.

- [ ] **Step 5: Run the tests**

Run: `pnpm -C apps/desktop exec vitest run --project node test/mentions.test.ts`
Expected: PASS. If an older test asserted `detail: t.status` or `type: 'text'`, update it to the new expectation rather than restoring the field.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm typecheck
pnpm exec prettier --write apps/desktop/src/renderer/src/editor/mentions.ts apps/desktop/src/renderer/src/composites/EditorPane.tsx apps/desktop/src/renderer/src/features/tasks/TaskBodyEditor.tsx apps/desktop/test/mentions.test.ts
git add apps/desktop
git commit -m "feat(editor): an @-mention is grouped, wears its icon, and says when it is due"
```

---

### Task 5: `/table` grows a second level

**Files:**

- Modify: `apps/desktop/src/renderer/src/editor/slash.ts`
- Modify: `apps/desktop/src/renderer/src/editor/extensions.ts` (register the new source)
- Modify: `apps/desktop/test/slash.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `apps/desktop/test/slash.test.ts`:

```ts
import { tableSizes, TABLE_SIZES, buildTable } from '../src/renderer/src/editor/slash'

describe('/table asks what size, instead of guessing', () => {
  test('picking /table does not insert a table, it opens the sizes', () => {
    const opt = slashCommands(ctx('/'))!.options.find((o) => o.label === '/table')!
    // An `apply` function, not a string: it types the argument and re-opens.
    expect(typeof opt.apply).toBe('function')
  })

  test('the sizes source only fires once the command has an argument slot', () => {
    expect(tableSizes(ctx('/table'))).toBeNull()
    expect(tableSizes(ctx('/table '))).not.toBeNull()
  })

  test('the sizes replace the whole command, not just the argument', () => {
    // `from` at the `/`, so picking a size leaves no `/table ` behind.
    expect(tableSizes(ctx('/table '))!.from).toBe(0)
  })

  test('every size is a valid GFM table: header, delimiter, then body rows', () => {
    for (const size of TABLE_SIZES) {
      const lines = buildTable(size).split('\n')
      expect(lines).toHaveLength(2 + size.rows)
      expect(lines[1]).toMatch(/^\|(\s*-+\s*\|)+$/)
      expect(lines[0]!.split('|').length - 2).toBe(size.cols)
    }
  })

  test("today's table is the first size offered, so Enter Enter is the old behaviour", () => {
    expect(TABLE_SIZES[0]).toEqual({ cols: 2, rows: 1 })
  })

  test('the sizes carry a trail header saying where you are', () => {
    const section = tableSizes(ctx('/table '))!.options[0]!.section
    expect(typeof section === 'string' ? section : section?.name).toBe('table')
  })

  test('backspacing out of the argument returns to the command list', () => {
    // No back-navigation code: `/table` matches the first level again.
    expect(slashCommands(ctx('/table'))!.options.map((o) => o.label)).toContain('/table')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -C apps/desktop exec vitest run --project node test/slash.test.ts`
Expected: FAIL, `tableSizes` is not exported.

- [ ] **Step 3: Rewrite `slash.ts`**

Replace the `TABLE` constant and the `COMMANDS` array in `apps/desktop/src/renderer/src/editor/slash.ts`, and add the second source:

```ts
import { startCompletion } from '@codemirror/autocomplete'
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import type { HoliCompletion } from './completion'

/** A markdown checkbox line. */
const TODO = '- [ ] '

/**
 * A table's shape, as columns by BODY rows. The header row is implied, because
 * every GFM table has one — which is why "3×2 with a header" is not an option
 * here: there is no table without one.
 */
export interface TableSize {
  cols: number
  rows: number
}

/** `2 × 1` first, deliberately: it is exactly the skeleton `/table` used to
 *  insert outright, so `/table` Enter Enter is the behaviour people had. */
export const TABLE_SIZES: TableSize[] = [
  { cols: 2, rows: 1 },
  { cols: 2, rows: 3 },
  { cols: 3, rows: 3 },
]

export function buildTable({ cols, rows }: TableSize): string {
  const header = `| ${Array.from({ length: cols }, (_, i) => `Column ${i + 1}`).join(' | ')} |`
  const delimiter = `|${' --- |'.repeat(cols)}`
  const body = Array.from({ length: rows }, () => `|${'  |'.repeat(cols)}`)
  return [header, delimiter, ...body].join('\n')
}

/** The trail line above the sizes. CodeMirror renders a section header as a
 *  `<completion-section>` inside the list, which its own base theme already
 *  gives `display: list-item`. */
const TABLE_SECTION = { name: 'table' }

const COMMANDS: HoliCompletion[] = [
  { label: '/todo', detail: 'checkbox', type: 'holi-list-todo', apply: TODO },
  {
    label: '/table',
    detail: 'pick a size…',
    type: 'holi-table',
    // **Not a string.** Picking this types the argument and re-opens the popup
    // on `tableSizes`, which is what the second level is: the panel stays and
    // its contents change. A flyout was rejected — see the design of record.
    apply: (view: EditorView, completion: Completion, from: number, to: number) => {
      view.dispatch({
        changes: { from, to, insert: '/table ' },
        selection: { anchor: from + '/table '.length },
        // `apply` owns this annotation when it fires its own transaction.
        annotations: pickedCompletion.of(completion),
      })
      startCompletion(view)
    },
  },
]
```

Add `pickedCompletion` to the import from `@codemirror/autocomplete`.

Then append the second source at the end of the file:

```ts
/** `/table ` and whatever has been typed after it. The space is the trigger:
 *  without it `slashCommands` still owns the text, which is what makes
 *  backspacing out of the argument return you to the command list with no
 *  back-navigation code at all. */
const TABLE_ARGS = /\/table\s+[\w× x]*/

export function tableSizes(context: CompletionContext): CompletionResult | null {
  const match = context.matchBefore(TABLE_ARGS)
  if (match === null) return null
  const before = match.from > 0 ? context.state.sliceDoc(match.from - 1, match.from) : ''
  if (before !== '' && !/\s/.test(before)) return null
  const typed = match.text.replace(/^\/table\s+/, '').toLowerCase()
  const options: HoliCompletion[] = TABLE_SIZES.filter((size) =>
    `${size.cols}x${size.rows}`.startsWith(typed.replace(/[×\s]/g, 'x')),
  ).map((size) => ({
    label: `${size.cols} × ${size.rows}`,
    detail: size.rows === 1 ? '1 row' : `${size.rows} rows`,
    type: 'holi-table',
    section: TABLE_SECTION,
    apply: buildTable(size),
  }))
  // `from` at the `/`, so picking a size replaces the whole command rather than
  // leaving `/table ` in the document in front of the table.
  return { from: match.from, options, filter: false }
}
```

- [ ] **Step 4: Register the source**

In `apps/desktop/src/renderer/src/editor/extensions.ts`, change the import

```ts
import { slashCommands } from './slash'
```

to

```ts
import { slashCommands, tableSizes } from './slash'
```

and the notes-stack call:

```ts
    holiCompletion([
      mentionSource(deps.mentionData),
      slashCommands,
      tableSizes,
      markdownTableAutocompleter(),
    ]),
```

- [ ] **Step 5: Run the tests**

Run: `pnpm -C apps/desktop exec vitest run --project node test/slash.test.ts`
Expected: PASS. The existing test `'/table inserts a valid markdown table skeleton'` now fails on `apply` being a function; rewrite it to assert `buildTable(TABLE_SIZES[0]!)` instead, since that is where the skeleton moved.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm typecheck
pnpm exec prettier --write apps/desktop/src/renderer/src/editor/slash.ts apps/desktop/src/renderer/src/editor/extensions.ts apps/desktop/test/slash.test.ts
git add apps/desktop
git commit -m "feat(editor): /table asks what size instead of guessing 2x1"
```

---

### Task 6: Motion

**Files:**

- Modify: `apps/desktop/src/renderer/src/editor/theme.ts` (`completionChrome`)
- Modify: `apps/desktop/test/completion.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/desktop/test/completion.test.ts`:

```ts
describe('the popup moves in the app’s vocabulary and no other', () => {
  const chrome = JSON.stringify(completionChrome)

  // D98: anything that cannot name one of the four behaviours does not animate.
  // Opening is `arrive`; the selection is `respond`. Nothing here loops.
  test('every duration comes from the motion tier', () => {
    expect(chrome).toContain('var(--motion-arrive')
    expect(chrome).toContain('var(--motion-respond')
    expect(chrome).not.toContain('var(--motion-inflight')
  })

  // The stated numbers the renderer lint gate exists to stop. A fallback inside
  // a `var()` is the one exception the app already makes, for tokens Tailwind
  // cannot see referenced from CSS-in-JS.
  test('no duration is stated at the call site', () => {
    expect(chrome.replace(/var\(--[a-z-]+, ?\d+m?s\)/g, '')).not.toMatch(/\d+ms/)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -C apps/desktop exec vitest run --project node test/completion.test.ts`
Expected: FAIL, "expected '…' to contain 'var(--motion-arrive'".

- [ ] **Step 3: Add the motion**

Add to `completionChrome` in `theme.ts`:

```ts
  // **Arrive.** The panel has weight and enters from the caret it belongs to.
  // Written as an animation rather than a transition because the element is
  // created already in place, so there is no "from" for a transition to run.
  // It plays once, on open: CodeMirror keeps this element and rebuilds only the
  // `<ul>` inside it as you keep typing, which is also why the list itself has
  // no animation — one there would replay on every keystroke.
  [`${POPUP}`]: {
    animation: 'cm-completion-in var(--motion-arrive, 300ms) var(--ease-settle, ease-out) both',
    transformOrigin: 'top left',
  },
  [`${POPUP}.cm-tooltip-above`]: { transformOrigin: 'bottom left' },
  [`${POPUP} > ul > li:hover:not([aria-selected])`]: {
    background: 'color-mix(in srgb, var(--accent) 55%, transparent)',
  },
  '@keyframes cm-completion-in': {
    from: { opacity: '0', transform: 'translateY(-4px) scale(0.97)' },
    to: { opacity: '1', transform: 'none' },
  },
```

**Respond** goes into the `li` rule that Task 2 already wrote, not a second one:
a repeated key in an object literal silently drops the earlier copy, so the row
would lose its layout. Edit that rule to read:

```ts
  [`${POPUP} > ul > li`]: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '5px 8px',
    borderRadius: 'var(--radius-sm, 4px)',
    lineHeight: '1.4',
    color: 'var(--popover-foreground)',
    // **Respond.** It notices the row under your pointer or caret, and reverses
    // the moment you leave. A transition, never an animation.
    transition: 'background var(--motion-respond, 150ms) var(--ease-settle, ease-out)',
  },
```

- [ ] **Step 4: Run the tests and the build**

Run: `pnpm -C apps/desktop exec vitest run --project node test/completion.test.ts`
Expected: PASS, 10 tests.

Run: `pnpm --filter @holi/desktop build`
Expected: success. This is the check that the keyframe block parses.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write apps/desktop/src/renderer/src/editor/theme.ts apps/desktop/test/completion.test.ts
git add apps/desktop
git commit -m "feat(editor): the completion popup arrives, and its rows respond"
```

---

### Task 7: The living docs

**Files:**

- Modify: `docs/upcoming.md:149-150`
- Modify: `docs/decisions.md` (the D99 row and the inbox sentence at line 7)
- Modify: `docs/prd/notes-editor.md` (FR-8 and FR-9)

- [ ] **Step 1: Close item 12 in `docs/upcoming.md`**

Replace lines 149-150 with a `[x]` and the record of what was built, following the shape of items 10 and 13:

```markdown
12. [x] The UI for the slash command popover (and the "@" popover) use the standard codemirror layout, font etc. We should make it our own, ideally a full shadcn ui component with proper hover and focus states, and sub menus if possible.
        — **BUILT 2026-09-13** (D99). Design: `docs/specs/2026-09-13-completion-popover-design.md`.
        — **Most of the old chrome was dead**, and measuring is what found it: base themes share one
        generated prefix, so a rule wins on specificity, and CodeMirror's `.cm-tooltip.cm-tooltip-autocomplete > ul`
        outranked ours. The popup was in browser-default monospace at CM's 10em cap, and its selected
        row painted CM's `#347`. `tooltipClass` stamps a third class so every rule wins outright, and
        a guard test fails on a selector that does not carry it.
        — Sections, our own rows (icon, label, trailing pill, `↵` on the selected row), all three
        `autocompletion()` call sites through one config, and `/table` grown a second level.
        — **`icons` stays on**: `codemirror-markdown-tables` styles its own menu from ~20 rules keyed on
        `:has(.cm-completionIcon-table)`, so turning them off would have un-styled it silently.
```

- [ ] **Step 2: Add the D99 row to `docs/decisions.md`**

The number is D99, not D98. **D97 had been spent twice** (the motion system and
"a setting is declared once"), found while writing this plan, and `48cb4cb`
resolved it at Nicolai's call: the older settings decision keeps D97, the motion
system moved to D98, and the stale section heading now agrees with the inbox
sentence. So update line 7 to say **next free is D100** when adding this row.

Add this item's row to the table in the same shape as its neighbours, using
whichever number the answer leaves free:

```markdown
| D99 — the completion popup is ours, and there is only one of it | [`prd/notes-editor.md`](prd/notes-editor.md) items 8 and 9. Design of record: [`specs/2026-09-13-completion-popover-design.md`](specs/2026-09-13-completion-popover-design.md); plan: [`plans/2026-09-13-completion-popover.md`](plans/2026-09-13-completion-popover.md). Agreed and built 2026-09-13 for [`upcoming.md`](upcoming.md) item 12, so it never sat in this inbox. **What measuring found is the decision's substance**: base themes all land under one generated prefix, so a rule here wins on specificity rather than order, and CodeMirror's own `.cm-tooltip.cm-tooltip-autocomplete > ul` outranked the block that was supposed to style the popup. Read out of the running app's stylesheets: the popup was in browser-default `monospace` at CodeMirror's 10em cap and `1px 3px` padding, and its selected row painted CodeMirror's `#347` — every one of our declarations for those was dead, and silently, which is how a popup that ignored D64 theming and light mode survived. Settles that **`tooltipClass` stamps `cm-holi-completion` on the popup** so every chrome rule wins outright, and that a guard test fails on a selector that does not carry it and on any hex literal in the block. **One config, three call sites**: `holiCompletion` in `editor/completion.ts` is the only caller of `autocompletion()` in the renderer, guarded by a test over the files, so "the popup is ours" is true by construction rather than by remembering to style a fourth one. **`icons` stays ON**, which is the opposite of the obvious move: `codemirror-markdown-tables` styles its own menu from roughly twenty rules keyed on `:has(.cm-completionIcon-table)`, so `icons: false` would have deleted the element they hang from and un-styled that menu with no error — CodeMirror keeps rendering the glyph and CSS hides it on our rows only, and nothing here contests a `:has()` it cannot outrank. **A row is an icon, a label and what the icon does not say**: a task's status is the explorer's own `TaskIcon` glyph, so the trailing pill carries its due date instead of repeating the status, and a note wears the vault's emoji when it has one. The glyphs are hand-copied from `lucide-react` because a CodeMirror option is plain DOM and no React lives inside CodeMirror anywhere in this app; a test renders the real component and fails on drift. **The `↵` hint is CSS on `li[aria-selected]`, never a conditional render**, because CodeMirror moves the selection by toggling that attribute without re-rendering rows. **`/table` asks what size** rather than guessing, and the second level is a chained completion rather than a flyout: picking it types `/table ` and re-opens the same panel on an argument source, with the trail as a section header and backspace as the way back, which needs no back-navigation code because `/table` matches the first level again. Sizes are columns × body rows with the header implied, since there is no GFM table without one. **Deliberately not built**: a cross-fade between the two levels, because CodeMirror rebuilds the option list on every keystroke and the animation would replay on each character; the side preview panel; and any new slash command, which is [D81](#d81--a-slash-command-is-a-small-program-in-the-apps-sandbox-not-a-shell)'s |
```

- [ ] **Step 3: Update the PRD**

`docs/prd/notes-editor.md` numbers its requirements as a plain list rather than
with `FR-` headings. Item 8 is `@`-mentions (line 71) and item 9 is slash
commands (line 72).

Append to item 8:

```markdown
The list is **grouped**: Notes above Tasks, under headers. A task's row
carries the explorer's own status glyph rather than repeating the status as
text, and a due date rides as a trailing pill; a note wears its vault emoji
when `icons.yaml` gives it one.
```

Replace item 9 entirely. Its "extensible via the provider registry" is the seam
D81 called one nobody outside the app can reach, and item 11 of `upcoming.md`
is what replaces it, so do not claim that here, only what is now true:

```markdown
9. **Slash commands.** `/` opens the command menu (`/todo` checkbox, `/table`).
   **A command may take an argument**, and `/table` does: picking it does not
   insert a table, it types `/table ` and re-opens the same panel on the sizes,
   with a trail line saying where you are and backspace as the way back. Sizes
   are columns × body rows, the header row implied, because there is no GFM
   table without one. **Not "subtask":** it inserts a markdown checkbox and is
   named for one.
```

Add a sentence to the editor-stack item (line 63), after the extension list, so
the chrome has a home in the PRD:

```markdown
Every completion popup in the app — this stack's, the mail composer's, and
the settings files' — is built by `holiCompletion` in `editor/completion.ts`,
which is the renderer's only caller of `autocompletion()`. Its chrome is
`completionChrome` in `editor/theme.ts`, on semantic tokens, and every
selector there is written to outrank CodeMirror's own.
```

Do **not** reformat either file: `decisions.md` and `prd/notes-editor.md` were
already not Prettier-clean before this work, and formatting them reflows
hundreds of unrelated lines.

- [ ] **Step 4: Commit**

**`docs/upcoming.md` is gitignored** (`.gitignore:11`) and untracked, so it is
edited but never committed: `git add` on it is a silent no-op, not an error.

```bash
git add docs/decisions.md docs/prd/notes-editor.md
git commit -m "docs: item 12 is built, and D99 records what measuring found"
```

---

## Final gates

Run all of these before calling the work done. All were green at `2dbc995`; there is no known-failing test.

```sh
pnpm -C packages/shared test                          # 552
pnpm -C apps/desktop exec vitest run --project node   # 2054 + the new ones, ~3-4 min
pnpm -C apps/desktop exec vitest run --project dom    # 798 + the new ones
pnpm typecheck                                        # clean
pnpm lint                                             # 0 errors, 4 pre-existing warnings
pnpm --filter @holi/desktop build
```

The dom project runs in parallel and flakes under load. Judge a failure only after re-running that file alone.

## Verifying it by eye

Renderer CSS does not hot-reload into a running window, and an already-open editor keeps the extension set it was created with. So after the build: the app needs a restart Nicolai performs, and a note needs closing and reopening before the new popup appears. CDP is read-only here. Never dispatch synthetic input at his live vault, which autosaves and pushes.

What to look at: type `@` in a note (Notes above Tasks, emoji where a note has one, a due pill), type `/` (two rows, glyphs, `↵` on the selected one), pick `/table` (the panel stays, the trail line says `table`, sizes below it), and switch to light mode (the popup follows, which it never did before).
