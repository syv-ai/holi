# Wiki-link Hover Preview Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hovering a `[[path]]` wiki-link (rendered chip or raw text) shows a small popover: for a note, its title + first lines; for a task, a status orb + title + due; for a missing target, "doesn't exist yet."

**Architecture:** A CodeMirror `hoverTooltip` finds the wiki-link under the cursor with the shared `parseWikiLinks`, then builds a card. Task data comes from the existing `taskByPathFacet` (extended with `due`); note content is read fresh via a new `readNote` dep (no cache — matches the app's read-fresh, no-index ethos). The card content extraction is a pure, unit-tested function (`previewFromMarkdown`); the CM wiring and DOM are verified live. Styling reuses the D64 `popover`/`muted-foreground`/`border` tokens — no new tokens.

**Tech Stack:** CodeMirror 6 (`hoverTooltip`), tRPC (`notes.read`), Jotai snapshot atoms, Vitest (`node` project for the pure function).

---

## File map

| File | Change |
|------|--------|
| `apps/desktop/src/renderer/src/editor/notePreview.ts` | **New.** Pure: `previewFromMarkdown` + `noteTitleFromPath`. |
| `apps/desktop/test/note-preview.test.ts` | **New.** Node test of the pure extraction. |
| `apps/desktop/src/renderer/src/editor/wikiHover.ts` | **New.** The `hoverTooltip` extension + card DOM. |
| `apps/desktop/src/renderer/src/editor/livePreview.ts` | `TaskChip` gains `due?`. |
| `apps/desktop/src/renderer/src/editor/extensions.ts` | `EditorDeps` gains `readNote`; add `wikiHoverPreview(deps.readNote)`. |
| `apps/desktop/src/renderer/src/composites/EditorPane.tsx` | Wire `readNote` + `due`. |
| `apps/desktop/src/renderer/src/features/tasks/TaskDetail.tsx` | Wire `readNote` + `due` (add `activeRemoteAtom`). |
| `apps/desktop/src/renderer/src/editor/theme.ts` | `.cm-wiki-preview` card styles + neutralise the hover-tooltip wrapper. |

**Verification loop** (from `apps/desktop`): typecheck `pnpm exec node node_modules/typescript/bin/tsc --noEmit`; node `pnpm exec vitest run --project node note-preview`; dom `pnpm exec vitest run --project dom`. Note per memory `holi-node-tests-live-outside-src`: pure editor logic is tested in the **node** project under `apps/desktop/test/`, not co-located.

---

## Task 1: Pure preview extraction

**Files:**
- Create: `apps/desktop/src/renderer/src/editor/notePreview.ts`
- Create: `apps/desktop/test/note-preview.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/test/note-preview.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { noteTitleFromPath, previewFromMarkdown } from '../src/renderer/src/editor/notePreview'

describe('previewFromMarkdown', () => {
  it('takes the first heading as the title and the next lines as the snippet', () => {
    const text = '# My Note\n\nFirst para.\nSecond line.\nThird line.\nFourth line.'
    expect(previewFromMarkdown(text)).toEqual({
      title: 'My Note',
      lines: ['First para.', 'Second line.', 'Third line.'],
    })
  })

  it('strips YAML frontmatter before reading', () => {
    const text = '---\ntitle: x\ntags: [a]\n---\n# Heading\nbody line'
    expect(previewFromMarkdown(text)).toEqual({ title: 'Heading', lines: ['body line'] })
  })

  it('returns a null title when the note does not open with a heading', () => {
    const text = 'just prose\n\nmore prose'
    expect(previewFromMarkdown(text)).toEqual({ title: null, lines: ['just prose', 'more prose'] })
  })

  it('skips blank lines and caps the snippet at three lines', () => {
    const text = '\n\nalpha\n\nbeta\ngamma\ndelta'
    expect(previewFromMarkdown(text)).toEqual({ title: null, lines: ['alpha', 'beta', 'gamma'] })
  })
})

describe('noteTitleFromPath', () => {
  it('is the basename without the .md extension', () => {
    expect(noteTitleFromPath('projects/q2/plan.md')).toBe('plan')
    expect(noteTitleFromPath('root.md')).toBe('root')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run (from `apps/desktop`): `pnpm exec vitest run --project node note-preview`
Expected: FAIL — `notePreview.ts` does not exist.

- [ ] **Step 3: Write `notePreview.ts`**

Create `apps/desktop/src/renderer/src/editor/notePreview.ts`:

```ts
/**
 * The content peek behind a wiki-link hover (notes-editor PRD FR-6). Pure and
 * framework-free so it is unit-testable without a view — the CM tooltip in
 * `wikiHover.ts` renders what this returns.
 */

/** A leading YAML frontmatter block, if present. Non-greedy to the first closing
 *  `---` line; anchored at the start so it only strips a real frontmatter block. */
const FRONTMATTER = /^---\n[\s\S]*?\n---\n?/

/**
 * The title + first lines of a note's markdown. `title` is the text of a leading
 * ATX heading (the vault convention: a note opens with `# Title`), or `null` when
 * the note does not — the caller falls back to the filename. `lines` is the first
 * three non-blank body lines, trimmed, with the title line excluded.
 */
export function previewFromMarkdown(text: string): { title: string | null; lines: string[] } {
  const body = text.replace(FRONTMATTER, '')
  const nonBlank = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  const heading = /^#{1,6}\s+(.+)$/.exec(nonBlank[0] ?? '')
  const title = heading ? heading[1]!.trim() : null
  const start = heading ? 1 : 0
  return { title, lines: nonBlank.slice(start, start + 3) }
}

/** The filename stem, the fallback title for a note with no leading heading. */
export function noteTitleFromPath(path: string): string {
  return (path.split('/').at(-1) ?? path).replace(/\.md$/, '')
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run --project node note-preview`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/editor/notePreview.ts apps/desktop/test/note-preview.test.ts
git commit -m "feat(editor): pure preview extraction for wiki-link hovers

Claude goes brr.. via Dash"
```

---

## Task 2: The hover-tooltip extension + wiring

**Files:**
- Create: `apps/desktop/src/renderer/src/editor/wikiHover.ts`
- Modify: `apps/desktop/src/renderer/src/editor/livePreview.ts` (`TaskChip.due?`)
- Modify: `apps/desktop/src/renderer/src/editor/extensions.ts` (`EditorDeps.readNote`, add extension)
- Modify: `apps/desktop/src/renderer/src/composites/EditorPane.tsx`
- Modify: `apps/desktop/src/renderer/src/features/tasks/TaskDetail.tsx`

DOM + CM wiring are verified live (per `holi-ui-verification-ceiling`), so this task is typecheck-gated with a live-check list.

- [ ] **Step 1: Add `due` to `TaskChip`**

In `apps/desktop/src/renderer/src/editor/livePreview.ts`, extend the interface:

```ts
export interface TaskChip {
  title: string
  status: TaskStatus
  /** YYYY-MM-DD; shown in the hover preview, not on the inline chip. */
  due?: string
}
```

- [ ] **Step 2: Write `wikiHover.ts`**

Create `apps/desktop/src/renderer/src/editor/wikiHover.ts`:

```ts
/**
 * Hover preview for wiki-links (notes-editor PRD FR-6). A `hoverTooltip` that finds
 * the `[[path]]` under the cursor (rendered chip or raw text — both are the same
 * token to `parseWikiLinks`) and shows a card: a task's status orb + title + due
 * from the task store, or a note's title + first lines read fresh, or a
 * "doesn't exist yet" line for a missing target.
 *
 * Note content is read on each hover rather than cached — a hover fires once per
 * settle, and reading fresh matches the app's no-index ethos (a stale peek would be
 * a small lie). Task data is already in the snapshot, so those need no read.
 */
import type { EditorState, Extension } from '@codemirror/state'
import { hoverTooltip, type Tooltip } from '@codemirror/view'
import { fileKind, parseWikiLinks } from '@holi/shared'
import { docExistsFacet, taskByPathFacet } from './livePreview'
import { noteTitleFromPath, previewFromMarkdown } from './notePreview'

/** Reads a note's text by vault-relative path; resolves null when it is not there. */
export type ReadNote = (path: string) => Promise<string | null>

function lineEl(text: string, className: string): HTMLElement {
  const el = document.createElement('div')
  el.className = className
  el.textContent = text
  return el
}

function card(children: HTMLElement[]): HTMLElement {
  const el = document.createElement('div')
  el.className = 'cm-wiki-preview'
  for (const c of children) el.appendChild(c)
  return el
}

async function buildPreview(
  state: EditorState,
  target: string,
  readNote: ReadNote,
): Promise<HTMLElement | null> {
  // A task: title + orb + due, straight from the store — no read.
  const task = state.facet(taskByPathFacet)(target)
  if (task) {
    const title = document.createElement('div')
    title.className = 'cm-wiki-preview-title'
    const orb = document.createElement('span')
    orb.className = `cm-task-orb cm-task-orb-${task.status}`
    title.appendChild(orb)
    title.appendChild(document.createTextNode(task.title))
    const meta = task.due ? `${task.status} · due ${task.due}` : task.status
    return card([title, lineEl(meta, 'cm-wiki-preview-meta')])
  }
  // A note we do not have is a missing target — never read to find that out.
  if (!state.facet(docExistsFacet)(target)) {
    return card([lineEl("This note doesn't exist yet.", 'cm-wiki-preview-meta')])
  }
  const text = await readNote(target)
  if (text === null) {
    return card([lineEl("This note doesn't exist yet.", 'cm-wiki-preview-meta')])
  }
  const { title, lines } = previewFromMarkdown(text)
  const head = lineEl(title ?? noteTitleFromPath(target), 'cm-wiki-preview-title')
  return card([head, ...lines.map((l) => lineEl(l, 'cm-wiki-preview-line'))])
}

export function wikiHoverPreview(readNote: ReadNote): Extension {
  return hoverTooltip(
    (view, pos) => {
      const line = view.state.doc.lineAt(pos)
      const rel = pos - line.from
      // A wiki-link body never spans lines, so the hovered line is the whole search.
      const link = parseWikiLinks(line.text).find((l) => rel >= l.start && rel <= l.end)
      // An image embed renders as the image, not a chip — nothing to preview.
      if (!link || fileKind(link.target) === 'image') return null
      const from = line.from + link.start
      const to = line.from + link.end
      const { target } = link
      return (async (): Promise<Tooltip | null> => {
        const dom = await buildPreview(view.state, target, readNote)
        return dom ? { pos: from, end: to, above: true, create: () => ({ dom }) } : null
      })()
    },
    { hoverTime: 300 },
  )
}
```

- [ ] **Step 3: Add `readNote` to `EditorDeps` and register the extension**

In `apps/desktop/src/renderer/src/editor/extensions.ts`:

Add the import:

```ts
import { wikiHoverPreview, type ReadNote } from './wikiHover'
```

Add the field to `EditorDeps` (after `taskByPath`):

```ts
  /** Reads a note's text for the hover preview; null when the target is missing. */
  readNote: ReadNote
```

Register the extension in the returned array, right after `linkClickHandler(deps.nav),`:

```ts
    wikiHoverPreview(deps.readNote),
```

- [ ] **Step 4: Wire `EditorPane.tsx`**

In `apps/desktop/src/renderer/src/composites/EditorPane.tsx`, the `baseEditorExtensions({…})` call — extend the `taskByPath` closure with `due` and add `readNote` (the effect already guards `remote !== null`, so `remote` is non-null here):

```ts
                  taskByPath: (p) => {
                    const t = tasksByPath.current.get(p)
                    return t ? { title: t.title, status: t.status, due: t.due } : null
                  },
                  readNote: (p) =>
                    trpc.notes.read.query({ remote, path: p }).then(
                      (text) => text,
                      () => null,
                    ),
```

- [ ] **Step 5: Wire `TaskDetail.tsx`**

In `apps/desktop/src/renderer/src/features/tasks/TaskDetail.tsx`:

Add `activeRemoteAtom` to the vaults import (currently `import { snapshotAtom } from '@/state/vaults'`):

```ts
import { activeRemoteAtom, snapshotAtom } from '@/state/vaults'
```

In `TaskDescriptionEditor`, read the remote alongside the snapshot (near `const snapshot = useAtomValue(snapshotAtom)`):

```ts
  const remote = useAtomValue(activeRemoteAtom)
```

In this file's `baseEditorExtensions({…})` call, extend `taskByPath` with `due` and add `readNote` (guarding the possibly-null remote):

```ts
            taskByPath: (p) => {
              const t = tasksByPath.current.get(p)
              return t ? { title: t.title, status: t.status, due: t.due } : null
            },
            readNote: (p) =>
              remote === null
                ? Promise.resolve(null)
                : trpc.notes.read.query({ remote, path: p }).then(
                    (text) => text,
                    () => null,
                  ),
```

- [ ] **Step 6: Typecheck + dom suite**

Run (from `apps/desktop`):
- `pnpm exec node node_modules/typescript/bin/tsc --noEmit` → Expected: no errors.
- `pnpm exec vitest run --project dom` → Expected: PASS (no regressions).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/editor/wikiHover.ts \
        apps/desktop/src/renderer/src/editor/livePreview.ts \
        apps/desktop/src/renderer/src/editor/extensions.ts \
        apps/desktop/src/renderer/src/composites/EditorPane.tsx \
        apps/desktop/src/renderer/src/features/tasks/TaskDetail.tsx
git commit -m "feat(editor): hover preview for wiki-links (title + lines; task orb/due)

Claude goes brr.. via Dash"
```

---

## Task 3: Preview card styling

**Files:**
- Modify: `apps/desktop/src/renderer/src/editor/theme.ts`

Styling only — verified live.

- [ ] **Step 1: Add the card styles**

In `apps/desktop/src/renderer/src/editor/theme.ts`, add these entries to the theme object (place them just after the `.cm-tooltip-autocomplete` autocomplete block, before the validity-strip block). The wrapper reset stops CM's base `.cm-tooltip` chrome from double-boxing the card; the card owns its chrome via the themeable tokens:

```ts
  // Wiki-link hover preview (FR-6). The card owns its chrome, so strip the base
  // tooltip wrapper. Colours are D64 tokens, so a vault theme recolours the card.
  '.cm-tooltip.cm-tooltip-hover': { background: 'transparent', border: 'none' },
  '.cm-wiki-preview': {
    background: 'var(--popover)',
    color: 'var(--popover-foreground)',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    padding: '8px 10px',
    maxWidth: '320px',
    fontSize: '12px',
    lineHeight: '1.5',
    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
  },
  '.cm-wiki-preview-title': {
    fontWeight: '600',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    marginBottom: '4px',
  },
  '.cm-wiki-preview-meta': { color: 'var(--muted-foreground)' },
  '.cm-wiki-preview-line': {
    color: 'var(--muted-foreground)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
```

- [ ] **Step 2: Typecheck**

Run (from `apps/desktop`): `pnpm exec node node_modules/typescript/bin/tsc --noEmit` → Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/editor/theme.ts
git commit -m "feat(editor): style the wiki-link hover preview card (themeable tokens)

Claude goes brr.. via Dash"
```

- [ ] **Step 4: Live-check (hand to Nicolai — `pnpm dev`)**

1. Hover a `[[note.md]]` chip → a card shows the note's title (its `# heading` or filename) + its first ~3 lines.
2. Hover a task link `[[…/task.foo.md]]` → a card shows a status orb + the task title + `status · due YYYY-MM-DD` (or just the status when no due).
3. Hover a link whose target doesn't exist → "This note doesn't exist yet."
4. Hover works on the raw `[[path]]` (caret on that line) and on the rendered chip.
5. The card reads on the theme: it uses the popover/border/muted colours, and a `.holi/theme.json` recolour of `popover` flows through.
6. Same behaviour inside a task's description editor (board sidebar + in-pane task editor).

---

## Self-Review

**Spec coverage** (against the confirmed design — option A):
- Note preview = title + first lines — Task 1 (extraction) + Task 2 (note branch). ✓
- Task preview = orb + title + due — Task 2 (`TaskChip.due`, task branch). ✓
- Missing target message — Task 2 (docExists / null-read branches). ✓
- Works on chip and raw text — Task 2 (`parseWikiLinks` on the line, position-based). ✓
- Themeable styling — Task 3 (popover/border/muted-foreground tokens; no new tokens). ✓
- Both note and task-description editors — Task 2 wires `EditorPane` and `TaskDescriptionEditor`. ✓

**Type consistency:** `ReadNote` (wikiHover) is the type of `EditorDeps.readNote` (extensions) and matches both call-site closures returning `Promise<string | null>`. `TaskChip.due?` (livePreview) is read in `buildPreview` and supplied by both `taskByPath` closures. `wikiHoverPreview(readNote)` matches its single-arg definition.

**Placeholder scan:** none — every step carries full code.

**Ordering / green commits:** Task 1 is standalone (pure module + test). Task 2 adds `readNote` everywhere it's consumed in one commit (compiles). Task 3 is pure CSS. Each ends on a green typecheck (+ node/dom suites where relevant).
```

**Deviation from the confirmed design:** no per-path cache — notes are read fresh on each hover (a hover fires once per settle; fresh reads match the app's no-index ethos). Flag if you'd rather cache.
