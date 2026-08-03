# Task↔Note Path-Grammar Integration — Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A task reference in note/description prose is a plain path wiki-link `[[…/task.foo.md]]` that renders as a chip with a **status orb + task title** and opens the task on click; `@` completes real tasks (inserting a path link); the dead `[[task:<id>]]` grammar is retired.

**Architecture:** The editor already resolves note chips by looking a path up in `docExistsFacet`. We add the sibling `taskByPathFacet` (path → `{title,status}|null`, fed from `snapshotAtom.tasks`). `livePreview` asks it per wiki-link: a hit renders a task chip, a miss stays a note chip. `@`-completion lists tasks from the same snapshot and inserts `formatWikiLink(task.path)`. Task navigation collapses into note navigation — a task is a file, so a click just `openNote`s the path (Shell already routes a `task.*.md` tab to `TaskFileEditor`). Once nothing reads the old grammar, `kind`/`TASK_REF_PREFIX` are deleted from the shared parser.

**Tech Stack:** CodeMirror 6 (facets, view plugins, decorations), Jotai atoms over `VaultSnapshot`, Vitest (`dom` = jsdom + Testing Library for `src/renderer/**/*.test.tsx`; `node` for `test/**/*.test.ts`; `packages/shared` own suite).

---

## File map

| File | Change |
|------|--------|
| `apps/desktop/src/renderer/src/editor/mentions.ts` | `@` lists tasks as **path** links; drop `taskId`/`onTaskMention`/`TASK_REF_PREFIX`. |
| `apps/desktop/src/renderer/src/editor/mentions.test.tsx` | **New.** Pure test of `mentionCompletions`. |
| `apps/desktop/src/renderer/src/editor/extensions.ts` | `EditorDeps`: drop `onTaskMention`, swap `taskInfo`→`taskByPath`; wire `taskByPathFacet`, `mentionSource(deps.mentionData)`. |
| `apps/desktop/src/renderer/src/editor/livePreview.ts` | Replace `taskInfoFacet`/`TaskChipInfo` with `taskByPathFacet`/`TaskChip`; classify chips by path. |
| `apps/desktop/src/renderer/src/editor/wikiLinkChips.ts` | One path-routed chip; task variant renders an orb + done-strike. |
| `apps/desktop/src/renderer/src/editor/wikiLinkChips.test.tsx` | **New.** DOM test of `WikiLinkChip.toDOM`. |
| `apps/desktop/src/renderer/src/editor/links.ts` | Retire `openTask`/`taskTarget`/`{kind:'task'}`. |
| `apps/desktop/src/renderer/src/editor/links.test.tsx` | **New.** Pure test of `resolveLinkClick`. |
| `apps/desktop/src/renderer/src/composites/EditorPane.tsx` | Feed `snapshot.tasks` into `mentionData`+`taskByPath`; allow opening task paths. |
| `apps/desktop/src/renderer/src/features/tasks/TaskDetail.tsx` | Same wiring in `TaskDescriptionEditor`. |
| `apps/desktop/src/renderer/src/editor/theme.ts` | Orb colours + done-strike CSS. |
| `packages/shared/src/wiki-links.ts` | Remove `kind` + `TASK_REF_PREFIX`; one grammar. |
| `packages/shared/test/wiki-links.test.ts` | Update to the one-grammar reality. |
| `apps/desktop/src/main/vault/backrefs.ts` | Drop the `link.kind === 'note'` guard. |

**Verification loop** (from `apps/desktop` unless noted): typecheck `pnpm exec node node_modules/typescript/bin/tsc --noEmit`; dom `pnpm exec vitest run --project dom`; shared (from `packages/shared`) `pnpm exec vitest run`. Main-process files (`backrefs.ts`) are typecheck-gated only.

---

## Task 1: `@` completes tasks as path links

**Files:**
- Modify: `apps/desktop/src/renderer/src/editor/mentions.ts`
- Create: `apps/desktop/src/renderer/src/editor/mentions.test.tsx`
- Modify: `apps/desktop/src/renderer/src/editor/extensions.ts`
- Modify: `apps/desktop/src/renderer/src/composites/EditorPane.tsx:151` (drop `onTaskMention`)
- Modify: `apps/desktop/src/renderer/src/features/tasks/TaskDetail.tsx:316` (drop `onTaskMention`)

This is plumbing: `mentionData.tasks` stays `[]` at the call sites until Task 2, so `@` lists no tasks yet — but the pure logic (a task option inserts `[[path]]`) is proven by the test now.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/editor/mentions.test.tsx`:

```tsx
import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { mentionCompletions, type MentionData } from './mentions'

function ctx(doc: string) {
  const state = EditorState.create({ doc })
  return new CompletionContext(state, doc.length, false)
}

const data: MentionData = {
  notes: [{ path: 'notes/a.md' }],
  tasks: [{ path: 'projects/task.fix-login.md', title: 'Fix login', status: 'doing' }],
}

describe('mentionCompletions', () => {
  it('completes a task as a path link carrying its status', () => {
    const result = mentionCompletions(ctx('@fix'), data)
    const opt = result?.options.find((o) => o.label === 'Fix login')
    expect(opt?.apply).toBe('[[projects/task.fix-login.md]]')
    expect(opt?.detail).toBe('doing')
  })

  it('completes a note as a path link', () => {
    const result = mentionCompletions(ctx('@a.md'), data)
    expect(result?.options.find((o) => o.label === 'notes/a.md')?.apply).toBe('[[notes/a.md]]')
  })

  it('does not hijack an email address', () => {
    expect(mentionCompletions(ctx('mail me at bob@ex'), data)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/desktop`): `pnpm exec vitest run --project dom mentions`
Expected: FAIL — `mentions.test.tsx` imports `mentionCompletions` whose task option still applies `[[task:<id>]]`, so `apply` is `undefined`/wrong and the type of `MentionData.tasks` has `id`, not `path`.

- [ ] **Step 3: Rewrite `mentions.ts`**

Replace the entire file with:

```ts
/**
 * @-mention autocomplete (notes-editor PRD FR-8). The pure core is a headless
 * function over a CompletionContext → CompletionResult, so it is unit-testable
 * without a view; `mentionSource` wraps it as a CodeMirror CompletionSource fed
 * live data (closures over the renderer's atoms).
 *
 * A task mention is an ordinary path wiki-link to the task file — there is no
 * opaque id and no `related[]` edge to maintain (D27/D60).
 */
import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from '@codemirror/autocomplete'
import { formatWikiLink, type TaskStatus } from '@holi/shared'

export interface MentionData {
  notes: { path: string }[]
  tasks: { path: string; title: string; status: TaskStatus }[]
}

/** Trigger: `@` and any following path/word chars, anchored at the `@`. */
const MENTION_RE = /@[\w.\-/]*/

export function mentionCompletions(
  context: CompletionContext,
  data: MentionData,
): CompletionResult | null {
  const match = context.matchBefore(MENTION_RE)
  if (!match) return null
  // Don't hijack email addresses: a word char immediately before the @ (foo@bar)
  // means this is not a mention trigger.
  const before = match.from > 0 ? context.state.sliceDoc(match.from - 1, match.from) : ''
  if (/\w/.test(before)) return null
  // The query is what follows the `@`. We filter ourselves and set filter:false —
  // `from` sits at the `@`, so CM's own fuzzy filter would match the `@`-prefixed
  // text against the labels and drop everything.
  const query = match.text.slice(1).toLowerCase()
  const noteOptions: Completion[] = data.notes
    .filter((n) => n.path.toLowerCase().includes(query))
    .map((n) => ({ label: n.path, type: 'text', apply: formatWikiLink(n.path) }))
  const taskOptions: Completion[] = data.tasks
    .filter((t) => t.title.toLowerCase().includes(query))
    .map((t) => ({
      label: t.title,
      detail: t.status,
      type: 'keyword',
      apply: formatWikiLink(t.path),
    }))
  return { from: match.from, options: [...noteOptions, ...taskOptions], filter: false }
}

/** The CodeMirror source: pulls live data on each `@`. A picked task inserts a
 * plain path link like any note — no side-effect to fire. */
export function mentionSource(getData: () => MentionData): CompletionSource {
  return (context) => mentionCompletions(context, getData())
}
```

- [ ] **Step 4: Update `extensions.ts` to drop `onTaskMention`**

In `apps/desktop/src/renderer/src/editor/extensions.ts`, remove the `onTaskMention` field from `EditorDeps`:

```ts
  /** Notes + tasks for `@`-mention completion (FR-8). */
  mentionData: () => MentionData
```

(delete the two lines: the `/** A picked task mention links... */` comment and `onTaskMention: (taskId: string) => void`).

Then change the completion source line (was `mentionSource(deps.mentionData, deps.onTaskMention)`):

```ts
        mentionSource(deps.mentionData),
```

- [ ] **Step 5: Drop `onTaskMention` at the two call sites**

`apps/desktop/src/renderer/src/composites/EditorPane.tsx` — delete the line `onTaskMention: () => {},` inside the `baseEditorExtensions({…})` call (currently line 151).

`apps/desktop/src/renderer/src/features/tasks/TaskDetail.tsx` — delete the line `onTaskMention: () => {},` inside `TaskDescriptionEditor`'s `baseEditorExtensions({…})` call (currently line 316).

- [ ] **Step 6: Run test + typecheck**

Run (from `apps/desktop`):
- `pnpm exec vitest run --project dom mentions` → Expected: PASS (3 tests).
- `pnpm exec node node_modules/typescript/bin/tsc --noEmit` → Expected: no errors. (`taskInfo` still exists on `EditorDeps` — untouched here; `TASK_REF_PREFIX` is now unused in the renderer but still exported by shared.)

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/editor/mentions.ts \
        apps/desktop/src/renderer/src/editor/mentions.test.tsx \
        apps/desktop/src/renderer/src/editor/extensions.ts \
        apps/desktop/src/renderer/src/composites/EditorPane.tsx \
        apps/desktop/src/renderer/src/features/tasks/TaskDetail.tsx
git commit -m "feat(editor): @ completes tasks as path links (retire task-id mention)

Claude goes brr.. via Dash"
```

---

## Task 2: Path-based task chips + retire task navigation

**Files:**
- Modify: `apps/desktop/src/renderer/src/editor/wikiLinkChips.ts`
- Create: `apps/desktop/src/renderer/src/editor/wikiLinkChips.test.tsx`
- Modify: `apps/desktop/src/renderer/src/editor/links.ts`
- Create: `apps/desktop/src/renderer/src/editor/links.test.tsx`
- Modify: `apps/desktop/src/renderer/src/editor/livePreview.ts`
- Modify: `apps/desktop/src/renderer/src/editor/extensions.ts`
- Modify: `apps/desktop/src/renderer/src/composites/EditorPane.tsx`
- Modify: `apps/desktop/src/renderer/src/features/tasks/TaskDetail.tsx`

- [ ] **Step 1: Write the failing chip test**

Create `apps/desktop/src/renderer/src/editor/wikiLinkChips.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest'
import { WikiLinkChip } from './wikiLinkChips'

describe('WikiLinkChip', () => {
  it('a task chip carries the path, an orb, and strikes when done', () => {
    const el = new WikiLinkChip('p/task.a.md', 'Fix login', true, { status: 'done' }).toDOM()
    expect(el.dataset['wikiTarget']).toBe('p/task.a.md')
    expect(el.classList.contains('cm-wikilink-task')).toBe(true)
    expect(el.classList.contains('cm-wikilink-done')).toBe(true)
    expect(el.querySelector('.cm-task-orb-done')).not.toBeNull()
    expect(el.textContent).toBe('Fix login')
  })

  it('a doing task chip has an orb but no strike', () => {
    const el = new WikiLinkChip('p/task.a.md', 'Fix login', true, { status: 'doing' }).toDOM()
    expect(el.querySelector('.cm-task-orb-doing')).not.toBeNull()
    expect(el.classList.contains('cm-wikilink-done')).toBe(false)
  })

  it('a missing note chip carries the path and the missing class, no orb', () => {
    const el = new WikiLinkChip('notes/gone.md', 'notes/gone.md', false).toDOM()
    expect(el.dataset['wikiTarget']).toBe('notes/gone.md')
    expect(el.classList.contains('cm-wikilink-missing')).toBe(true)
    expect(el.querySelector('.cm-task-orb')).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run --project dom wikiLinkChips`
Expected: FAIL — the current `WikiLinkChip` constructor is `(kind, target, label, exists)` and renders no orb.

- [ ] **Step 3: Rewrite `wikiLinkChips.ts`**

Replace the entire file with:

```ts
import { WidgetType } from '@codemirror/view'
import type { TaskStatus } from '@holi/shared'

/**
 * Inline chip for a `[[path]]` / `[[path|Label]]` wiki-link (notes-editor PRD FR-6).
 *
 * Every chip routes by path — a task is a file like any other (D27/D60), so there is
 * one grammar and one click target. A chip is a task chip when `task` is present: it
 * carries the task's status, which draws a coloured orb and strikes the title when done,
 * so it reads as a task rather than a note. `label` arrives already resolved (the caller
 * folds in `|Label` and, for a task, the path→title join).
 */
export class WikiLinkChip extends WidgetType {
  constructor(
    readonly target: string,
    readonly label: string,
    readonly exists: boolean,
    readonly task?: { status: TaskStatus },
  ) {
    super()
  }

  override eq(other: WikiLinkChip): boolean {
    return (
      other.target === this.target &&
      other.label === this.label &&
      other.exists === this.exists &&
      other.task?.status === this.task?.status
    )
  }

  override toDOM(): HTMLElement {
    const el = document.createElement('span')
    const done = this.task?.status === 'done'
    el.className = [
      'cm-wikilink',
      this.task ? 'cm-wikilink-task' : 'cm-wikilink-note',
      // A missing tint applies to notes only — a task chip resolved from a real file.
      !this.task && !this.exists ? 'cm-wikilink-missing' : '',
      done ? 'cm-wikilink-done' : '',
    ]
      .filter(Boolean)
      .join(' ')
    // The dataset key `resolveLinkClick` routes on. Always a path now.
    el.dataset['wikiTarget'] = this.target
    if (this.task) {
      const orb = document.createElement('span')
      orb.className = `cm-task-orb cm-task-orb-${this.task.status}`
      el.appendChild(orb)
    }
    el.appendChild(document.createTextNode(this.label))
    return el
  }

  override ignoreEvent(): boolean {
    return false // clicks bubble to the editor's click handler (open target)
  }
}
```

- [ ] **Step 4: Write the failing links test**

Create `apps/desktop/src/renderer/src/editor/links.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest'
import { resolveLinkClick } from './links'

describe('resolveLinkClick', () => {
  it('routes a wiki target (note or task path) to a note action', () => {
    expect(resolveLinkClick({ wikiTarget: 'p/task.a.md', modifier: false })).toEqual({
      kind: 'note',
      path: 'p/task.a.md',
    })
  })

  it('a plain markdown-link click places the caret (null); ⌘-click navigates', () => {
    expect(resolveLinkClick({ href: 'notes/b.md', modifier: false })).toBeNull()
    expect(resolveLinkClick({ href: 'notes/b.md', modifier: true })).toEqual({
      kind: 'note',
      path: 'notes/b.md',
    })
  })

  it('⌘-click on an http link leaves the app', () => {
    expect(resolveLinkClick({ href: 'https://x.dev', modifier: true })).toEqual({
      kind: 'external',
      url: 'https://x.dev',
    })
  })

  it('a bare click that hit nothing is left alone', () => {
    expect(resolveLinkClick({ modifier: false })).toBeNull()
  })
})
```

- [ ] **Step 5: Run to verify it fails**

Run: `pnpm exec vitest run --project dom links`
Expected: FAIL — `ClickTargets` still requires reasoning about `taskTarget`; the new test compiles against the new shape only after Step 6.

- [ ] **Step 6: Edit `links.ts` — retire task navigation**

In `apps/desktop/src/renderer/src/editor/links.ts`:

Remove `openTask` from `LinkNav`:

```ts
export interface LinkNav {
  /** Open a note (or task file — both are paths now) by its vault-relative path. */
  openNote: (path: string) => void
  openExternal: (url: string) => void
}
```

Remove the task case from `LinkAction`:

```ts
export type LinkAction =
  | { kind: 'note'; path: string }
  | { kind: 'external'; url: string }
  | null
```

Remove `taskTarget` from `ClickTargets` (delete the `taskTarget?` field and its doc comment).

Rewrite `resolveLinkClick` (drop the `taskTarget` param and its branch):

```ts
export function resolveLinkClick({ wikiTarget, href, modifier }: ClickTargets): LinkAction {
  // A chip wins over any enclosing link: it is the innermost thing you clicked, and it
  // is a widget, so there is no caret to place inside it.
  if (wikiTarget) return { kind: 'note', path: wikiTarget }
  // A markdown link is editable text, so navigation takes ⌘/Ctrl-click; a plain click
  // keeps placing the caret.
  if (!href || !modifier) return null
  return /^https?:\/\//i.test(href) ? { kind: 'external', url: href } : { kind: 'note', path: href }
}
```

In `linkClickHandler`, delete the `taskTarget:` line from the `resolveLinkClick({…})` call and drop the task branch so it reads:

```ts
        if (!action) return false
        if (action.kind === 'note') nav().openNote(action.path)
        else nav().openExternal(action.url)
        event.preventDefault()
        return true
```

- [ ] **Step 7: Run both new tests**

Run: `pnpm exec vitest run --project dom "wikiLinkChips|links"`
Expected: PASS (chip test 3, links test 4).

- [ ] **Step 8: Swap the facet in `livePreview.ts`**

In `apps/desktop/src/renderer/src/editor/livePreview.ts`:

Add to the shared import (line 17) the `TaskStatus` type — change it to:

```ts
import { fileKind, parseWikiLinks, resolveImageRef, type TaskStatus } from '@holi/shared'
```

Delete the `TaskChipInfo` interface and the `taskInfoFacet` definition (the block from `/** What a `[[task:<id>]]` chip should say… */` through the `taskInfoFacet` `Facet.define` call), and replace with:

```ts
/** A task chip's rendered fields, resolved by path from the board's task store. */
export interface TaskChip {
  title: string
  status: TaskStatus
}

/** Path → task lookup for chips, the sibling of `docExistsFacet`. The unwired default
 * says "no path is a task", so a bare editor renders every link as a note chip. */
export const taskByPathFacet = Facet.define<
  (path: string) => TaskChip | null,
  (path: string) => TaskChip | null
>({
  combine: (values) => values[0] ?? (() => null),
})
```

Replace `const taskInfo = state.facet(taskInfoFacet)` (line ~208) with:

```ts
  const taskByPath = state.facet(taskByPathFacet)
```

Replace the wiki-link loop body (the `for (const link of parseWikiLinks(visible)) { … }` block, roughly lines 210–235) with:

```ts
  for (const link of parseWikiLinks(visible)) {
    const start = from + link.start
    const end = from + link.end
    if (isActive(start)) continue
    if (fileKind(link.target) === 'image') {
      // [[img.png]] embeds are vault-relative (used as-is); render inline.
      ranges.push({
        from: start,
        to: end,
        deco: Decoration.replace({
          widget: new ImageWidget(vaultAssetUrl(link.target), link.label ?? link.target),
        }),
      })
      continue
    }
    // A path that resolves to a task renders a task chip (orb + title); everything else
    // is a note chip, existing or missing.
    const task = taskByPath(link.target)
    const chip = task
      ? new WikiLinkChip(link.target, link.label ?? task.title, true, { status: task.status })
      : new WikiLinkChip(link.target, link.label ?? link.target, docExists(link.target))
    ranges.push({ from: start, to: end, deco: Decoration.replace({ widget: chip }) })
  }
```

- [ ] **Step 9: Swap `taskInfo`→`taskByPath` on `EditorDeps`**

In `apps/desktop/src/renderer/src/editor/extensions.ts`:

Change the import (line 13) to drop `taskInfoFacet`/`TaskChipInfo` and add the new facet/type:

```ts
import { docExistsFacet, livePreview, notePathFacet, taskByPathFacet, type TaskChip } from './livePreview'
```

In `EditorDeps`, replace the `taskInfo` field:

```ts
  /** Title + status for a `[[path]]` chip whose path is a task, else null. */
  taskByPath: (path: string) => TaskChip | null
```

In the returned extension array, replace `taskInfoFacet.of(deps.taskInfo)` with:

```ts
    taskByPathFacet.of(deps.taskByPath),
```

- [ ] **Step 10: Wire the data in `EditorPane.tsx`**

In `apps/desktop/src/renderer/src/composites/EditorPane.tsx`:

Add `Task` to the shared import at the top:

```ts
import type { Task } from '@holi/shared'
```

Replace the pull-based deps block (currently lines 71–82) with:

```ts
  // Read on demand by the editor's pull-based seams, so a snapshot arriving
  // mid-edit does not rebuild the EditorView and drop the caret.
  const docPaths = useRef(new Set<string>())
  docPaths.current = new Set(snapshot.docs.map((d) => d.path))
  const tasksByPath = useRef(new Map<string, Task>())
  tasksByPath.current = new Map(snapshot.tasks.map((t) => [t.path, t]))
  const mentionRef = useRef<MentionData>({ notes: [], tasks: [] })
  mentionRef.current = {
    notes: snapshot.docs.map((d) => ({ path: d.path })),
    tasks: snapshot.tasks.map((t) => ({ path: t.path, title: t.title, status: t.status })),
  }
  const navRef = useRef<LinkNav>({ openNote: () => {}, openExternal: () => {} })
  navRef.current = {
    // A link can point at a note or task that does not exist yet; the chip renders
    // missing and the click no-ops rather than inventing a file.
    openNote: (target) =>
      (docPaths.current.has(target) || tasksByPath.current.has(target)) && onOpenNote(target),
    openExternal: (url) => void window.holi.openExternal(url),
  }
```

In the `baseEditorExtensions({…})` call, replace the `taskInfo: () => ({ label: 'task', missing: true }),` line with:

```ts
                  taskByPath: (p) => {
                    const t = tasksByPath.current.get(p)
                    return t ? { title: t.title, status: t.status } : null
                  },
```

- [ ] **Step 11: Wire the data in `TaskDetail.tsx` (`TaskDescriptionEditor`)**

In `apps/desktop/src/renderer/src/features/tasks/TaskDetail.tsx`, `TaskDescriptionEditor`:

The `Task` type is already imported. Replace the pull-based deps block (currently lines 293–302) with:

```ts
  // Read on demand so a snapshot arriving mid-edit does not rebuild the view.
  const docPaths = useRef(new Set<string>())
  docPaths.current = new Set(snapshot.docs.map((d) => d.path))
  const tasksByPath = useRef(new Map<string, Task>())
  tasksByPath.current = new Map(snapshot.tasks.map((t) => [t.path, t]))
  const mentionRef = useRef<MentionData>({ notes: [], tasks: [] })
  mentionRef.current = {
    notes: snapshot.docs.map((d) => ({ path: d.path })),
    tasks: snapshot.tasks.map((t) => ({ path: t.path, title: t.title, status: t.status })),
  }
  const navRef = useRef<LinkNav>({ openNote: () => {}, openExternal: () => {} })
  navRef.current = {
    openNote: (target) =>
      (docPaths.current.has(target) || tasksByPath.current.has(target)) && openNote(target),
    openExternal: (url) => void window.holi.openExternal(url),
  }
```

In this file's `baseEditorExtensions({…})` call, replace the `taskInfo: () => ({ label: 'task', missing: true }),` line with:

```ts
            taskByPath: (p) => {
              const t = tasksByPath.current.get(p)
              return t ? { title: t.title, status: t.status } : null
            },
```

- [ ] **Step 12: Typecheck + full dom suite**

Run (from `apps/desktop`):
- `pnpm exec node node_modules/typescript/bin/tsc --noEmit` → Expected: no errors. (`taskInfoFacet`/`TaskChipInfo`/`openTask` no longer referenced anywhere in the renderer.)
- `pnpm exec vitest run --project dom` → Expected: PASS (all dom tests, including the two new ones).

- [ ] **Step 13: Commit**

```bash
git add apps/desktop/src/renderer/src/editor/wikiLinkChips.ts \
        apps/desktop/src/renderer/src/editor/wikiLinkChips.test.tsx \
        apps/desktop/src/renderer/src/editor/links.ts \
        apps/desktop/src/renderer/src/editor/links.test.tsx \
        apps/desktop/src/renderer/src/editor/livePreview.ts \
        apps/desktop/src/renderer/src/editor/extensions.ts \
        apps/desktop/src/renderer/src/composites/EditorPane.tsx \
        apps/desktop/src/renderer/src/features/tasks/TaskDetail.tsx
git commit -m "feat(editor): task links render a status orb + title, click opens the task

Claude goes brr.. via Dash"
```

---

## Task 3: Retire the `[[task:<id>]]` grammar in shared

**Files:**
- Modify: `packages/shared/src/wiki-links.ts`
- Modify: `packages/shared/test/wiki-links.test.ts`
- Modify: `apps/desktop/src/main/vault/backrefs.ts`

Nothing reads `WikiLinkMatch.kind` or `TASK_REF_PREFIX` any more (renderer switched in Tasks 1–2), so the parser collapses to one grammar.

- [ ] **Step 1: Update the shared test to the one-grammar reality**

In `packages/shared/test/wiki-links.test.ts`:

Delete the `kind: 'note',` line from the `toEqual` object (line ~15) and from the two `toMatchObject` calls (lines ~27 and ~52).

Replace the task-classification test (the whole `it('classifies [[task:<id>]] as a task chip carrying the bare id', …)` block) with:

```ts
  it('has one grammar: a task: prefix is just an ordinary target now (D27/D60)', () => {
    const [link] = parseWikiLinks('do [[task:0192-abc]] first')
    expect(link).toMatchObject({ target: 'task:0192-abc', label: undefined })
  })
```

In the "conforms to the old grammar" test, change the blank-bodies assertion (line ~41) — a `task:` body is no longer special, so only a whitespace body is skipped:

```ts
    expect(parseWikiLinks('[[ ]]')).toEqual([]) // a blank body resolves to nothing
```

- [ ] **Step 2: Run to verify it fails**

Run (from `packages/shared`): `pnpm exec vitest run wiki-links`
Expected: FAIL — the parser still emits `kind` and still strips `task:`, so the updated `toMatchObject`/`toEqual` expectations mismatch.

- [ ] **Step 3: Collapse the parser in `wiki-links.ts`**

In `packages/shared/src/wiki-links.ts`:

Delete the `TASK_REF_PREFIX` export (the `/** Prefix marking a task chip body… */` comment + `export const TASK_REF_PREFIX = 'task:'`).

In `WikiLinkMatch`, delete the `kind` field and its comment.

Rewrite `parseWikiLinks` (drop the `task:` branch):

```ts
export function parseWikiLinks(text: string): WikiLinkMatch[] {
  const re = wikiLinkRegex()
  const out: WikiLinkMatch[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const body = m[1]?.trim()
    if (!body) continue
    const pipe = body.indexOf('|')
    const target = (pipe >= 0 ? body.slice(0, pipe) : body).trim()
    const label = pipe >= 0 ? body.slice(pipe + 1).trim() || undefined : undefined
    if (!target) continue
    out.push({ raw: m[0], target, label, start: m.index, end: m.index + m[0].length })
  }
  return out
}
```

In `rewriteWikiLinks`, change the guard `if (link.kind !== 'note' || link.target !== fromPath) continue` to:

```ts
    if (link.target !== fromPath) continue
```

In `rewriteWikiLinksMulti`, delete the `if (link.kind !== 'note') continue` line (keep the `const to = moves.get(link.target)` / `if (to === undefined) continue` lines that follow).

Update the module header comment: delete the `[[task:<id>]]` bullet and note there is now one grammar (path links, optionally `|Label`).

- [ ] **Step 4: Drop the kind guard in `backrefs.ts`**

In `apps/desktop/src/main/vault/backrefs.ts`, change both filters (lines ~29 and ~55):

```ts
      (link) => link.target === target,
```
```ts
      (link) => set.has(link.target),
```

- [ ] **Step 5: Run shared test + desktop typecheck**

Run (from `packages/shared`): `pnpm exec vitest run wiki-links` → Expected: PASS.
Run (from `apps/desktop`): `pnpm exec node node_modules/typescript/bin/tsc --noEmit` → Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/wiki-links.ts \
        packages/shared/test/wiki-links.test.ts \
        apps/desktop/src/main/vault/backrefs.ts
git commit -m "refactor(shared): one wiki-link grammar — retire [[task:<id>]] (D27/D60)

Claude goes brr.. via Dash"
```

---

## Task 4: Task-chip orb + done-strike styling

**Files:**
- Modify: `apps/desktop/src/renderer/src/editor/theme.ts`

No unit test — chip appearance is verified live (per `holi-ui-verification-ceiling`, hand Nicolai the live-check list below).

- [ ] **Step 1: Add the orb + done styles**

In `apps/desktop/src/renderer/src/editor/theme.ts`, replace the `.cm-wikilink-task` line (currently line 69) with the task chip's inline-flex layout, orb, status colours, and done-strike:

```ts
  // A task chip reads as a task, not a note: same shape, the board's amber tint, and a
  // status orb before the title. `inline-flex` so the orb and title share a baseline row.
  '.cm-wikilink-task': {
    background: 'rgba(251,191,36,0.12)',
    color: '#fbbf24',
    display: 'inline-flex',
    alignItems: 'baseline',
    gap: '4px',
  },
  '.cm-task-orb': {
    display: 'inline-block',
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    alignSelf: 'center',
  },
  '.cm-task-orb-todo': { background: '#6e7681' },
  '.cm-task-orb-doing': { background: '#d29922' },
  '.cm-task-orb-done': { background: '#3fb950' },
  // A done task strikes its title, matching the board card.
  '.cm-wikilink-done': { textDecoration: 'line-through', color: '#8b949e' },
```

- [ ] **Step 2: Typecheck**

Run (from `apps/desktop`): `pnpm exec node node_modules/typescript/bin/tsc --noEmit` → Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/editor/theme.ts
git commit -m "feat(editor): status orb + done-strike on task-link chips

Claude goes brr.. via Dash"
```

- [ ] **Step 4: Live-check (hand to Nicolai — `pnpm dev`)**

1. In a note, type `@` and part of a task title → the task appears in the completion list with its status as the detail; picking it inserts `[[…/task.foo.md]]`.
2. Move the caret off that line → the link renders as a chip: a coloured orb (grey todo / amber doing / green done) + the task's title.
3. Complete the task on the board → the chip's title shows strikethrough.
4. Click the chip → the task opens (as a task, via `TaskFileEditor`).
5. Same three behaviours inside a task's **description** editor (board sidebar and the in-pane task editor).
6. A `[[path]]` to a real note still renders the ordinary blue note chip; a missing note still renders the pink missing chip.

---

## Self-Review

**Spec coverage** (against the compact design + handoff Tier 1 #1):
- `@` completes real tasks, inserts a path link — Task 1. ✓
- `[[path]]` to a task renders status orb + title — Tasks 2 (chip + resolution) & 4 (style). ✓
- Click opens the task file — Task 2 (`openNote` allows task paths; Shell routes to `TaskFileEditor`). ✓
- Done → strikethrough — Tasks 2 (class) & 4 (CSS). ✓
- Retire `[[task:<id>]]` grammar + `related[]`/`onTaskMention` — Task 1 (mention side-effect) & Task 3 (parser). ✓
- Works in note bodies **and** task descriptions — Tasks 2 wiring in both `EditorPane` and `TaskDescriptionEditor`. ✓

**Type consistency:** `MentionData.tasks: {path,title,status}` (Task 1) matches the `snapshot.tasks.map` wiring (Task 2). `EditorDeps.taskByPath → TaskChip|null` (Task 2) matches `taskByPathFacet` (Task 2) and both call sites' closures. `WikiLinkChip(target,label,exists,task?)` (Task 2) matches every `new WikiLinkChip(...)` in `livePreview` (Task 2). `LinkNav` without `openTask` (Task 2) matches both `navRef` initialisers (Task 2).

**Placeholder scan:** none — every step carries full code or an exact edit.

**Ordering / green commits:** Task 1 leaves `taskInfo` intact and `tasks:[]` at call sites (compiles, `@` lists nothing yet). Task 2 switches resolution + wiring together (compiles, feature live). Task 3 removes shared `kind`/`TASK_REF_PREFIX` only after no consumer reads them. Task 4 is pure CSS. Each task ends on a green typecheck + suite.
