# VS Code-style File Tree — Phase 1 Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the sidebar file tree with a VS Code-style explorer on the headless-tree engine — explorer-header actions, chevron twisties, Holi-native skin, a right-click context menu, inline create/rename, delete, and keyboard navigation — on today's single-file backend.

**Architecture:** The tree stays a pure projection of `snapshotAtom`. headless-tree runs in controlled/external-data mode: a pure `buildTreeData` function turns the snapshot's doc paths (plus a client-only `pendingNodes` set for transient folders/inline-create rows) into the flat record headless-tree consumes. The engine owns selection/focus/expansion/keyboard; we own all DOM, CSS, and every mutation handler, so Holi's link-rewrite rename and backref/tombstone delete stay in our atoms unchanged.

**Tech Stack:** React 18, TypeScript, Tailwind v4, jotai, `@headless-tree/core` + `@headless-tree/react` (MIT), Vitest 4 (node env, no jsdom), CDP for live UI verification.

**Scope:** Phase 1 only. Phase 2 (multi-select, drag-and-drop, cut/copy/paste/duplicate, folder rename/delete/move, and the batch backend `move`/`copy`/`deleteMany`/multi-`backrefs`) gets its own plan after Phase 1 ships. See `docs/specs/2026-07-24-file-tree-vscode-design.md`.

---

## Conventions (read once)

- **Tooling quirks:** bare `node`/`npx` are broken here — always `pnpm exec`. Run everything from `apps/desktop/` unless noted.
- **Tests:** `cd apps/desktop && pnpm exec vitest run` (node env, **no jsdom** — pure logic is unit-tested; UI is CDP-verified).
- **Typecheck (the real gate):** `pnpm exec tsc --noEmit 2>&1 | grep -c error` — the baseline is **36** pre-existing errors (agent/history files). This number must not rise.
- **Live app:** an `electron-vite dev` instance runs on CDP port 9333, driver at `/tmp/holi-drive.mjs` (`pnpm exec node /tmp/holi-drive.mjs eval|shot <path>`). Renderer edits hot-reload; main-process edits need a relaunch. Teardown only with the scoped `pkill -f "better-holi-final/node_modules/.pnpm/electron@"`.
- **Commit trailer:** end every commit message with `Claude goes brr.. via Dash`.

## File Structure

- **Create** `apps/desktop/src/renderer/src/lib/tree-data.ts` — pure `buildTreeData(paths, pendingFolders)` → flat `Record<id, TreeItemData>` for headless-tree; `ROOT_ID`, hidden-root filtering, folder-first sort.
- **Create** `apps/desktop/src/renderer/src/lib/tree-data.test.ts` — unit tests for the above.
- **Create** `apps/desktop/src/renderer/src/lib/tree-paths.ts` — pure path helpers (`joinPath`, `withMdExtension`, `basename`, `parentOf`, `renameBasenameRange`).
- **Create** `apps/desktop/src/renderer/src/lib/tree-paths.test.ts` — unit tests.
- **Create** `apps/desktop/src/renderer/src/components/tree/icons.tsx` — inline SVG `FolderIcon`, `ChevronIcon`, `MarkdownIcon`.
- **Create** `apps/desktop/src/renderer/src/components/tree/ExplorerHeader.tsx` — vault name + New File / New Folder / Collapse All.
- **Create** `apps/desktop/src/renderer/src/components/tree/TreeContextMenu.tsx` — right-click popover.
- **Rewrite** `apps/desktop/src/renderer/src/components/FileTree.tsx` — headless-tree container + row renderer + pending-node state; keeps its current props so `Shell.tsx` is untouched.
- **Modify** `apps/desktop/src/renderer/src/state/vaults.ts` — add `createFolderPendingly` is client-only (no atom); keep existing `createNoteAtom`/`renameNoteAtom`/`deleteNoteAtom`/`backrefsFor`. Add `copyPathToClipboard` helpers live in the component, not atoms.
- **Modify** `apps/desktop/src/renderer/src/styles/` or Tailwind classes inline — Holi-native skin (mostly inline classes; one small `holi-scroll` already exists).
- **Delete (end of plan)** the old nested `buildTree`/`TreeNode` in `lib/tree.ts` once nothing imports it.

---

## Task 1: Install headless-tree

**Files:**
- Modify: `apps/desktop/package.json` (dependencies)

- [ ] **Step 1: Add the two packages**

Run (from repo root):

```bash
cd apps/desktop && pnpm add @headless-tree/core@^1.0.1 @headless-tree/react@^1.0.1
```

Expected: both appear under `dependencies` in `apps/desktop/package.json`; pnpm installs without a build-script prompt (both are pure JS).

- [ ] **Step 2: Typecheck still clean**

Run: `pnpm exec tsc --noEmit 2>&1 | grep -c error`
Expected: `36` (unchanged).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/package.json ../../pnpm-lock.yaml
git commit -m "build(desktop): add headless-tree for the file explorer

Claude goes brr.. via Dash"
```

---

## Task 2: `tree-data.ts` — snapshot → headless-tree flat record

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/tree-data.ts`
- Test: `apps/desktop/src/renderer/src/lib/tree-data.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { buildTreeData, ROOT_ID } from './tree-data'

describe('buildTreeData', () => {
  it('nests docs under folder ids and lists top-level under root', () => {
    const data = buildTreeData(['inbox.md', 'projects/roadmap.md', 'projects/ideas.md'])
    expect(data[ROOT_ID].children).toEqual(['projects', 'inbox.md']) // folders first, then alpha
    expect(data['projects'].isFolder).toBe(true)
    expect(data['projects'].children).toEqual(['projects/ideas.md', 'projects/roadmap.md'])
    expect(data['projects/roadmap.md'].isFolder).toBe(false)
    expect(data['inbox.md'].name).toBe('inbox.md')
  })

  it('filters hidden roots', () => {
    const data = buildTreeData(['.holi/vault.json', 'MEMORY.md', 'note.md'])
    expect(data[ROOT_ID].children).toEqual(['note.md'])
  })

  it('includes an empty pending folder that has no docs', () => {
    const data = buildTreeData(['note.md'], ['drafts'])
    expect(data[ROOT_ID].children).toEqual(['drafts', 'note.md'])
    expect(data['drafts']).toEqual({ name: 'drafts', isFolder: true, children: [] })
  })

  it('does not duplicate a folder that is both pending and has a doc', () => {
    const data = buildTreeData(['drafts/x.md'], ['drafts'])
    expect(data['drafts'].children).toEqual(['drafts/x.md'])
    expect(data[ROOT_ID].children).toEqual(['drafts'])
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm exec vitest run src/renderer/src/lib/tree-data.test.ts`
Expected: FAIL — `buildTreeData` is not defined.

- [ ] **Step 3: Implement**

```ts
/**
 * The vault snapshot as headless-tree's flat data record.
 *
 * headless-tree consumes a `Record<id, {name,isFolder,children}>` addressed by a
 * synchronous data loader (getItem/getChildren). Ids are paths; folders exist iff
 * a doc is inside them (git tracks no empty directory — see the old lib/tree.ts),
 * with the sole exception of `pendingFolders`: transient, client-only folders that
 * the UI shows until the first note lands inside (spec §Empty folders).
 */
export const ROOT_ID = '__root__'

export interface TreeItemData {
  name: string
  isFolder: boolean
  children: string[]
}

/** Vault-managed roots hidden from the tree by default (D6). */
const HIDDEN_ROOTS = new Set(['.claude', '.holi', 'AGENTS.md', 'MEMORY.md', 'CLAUDE.md'])

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

export function buildTreeData(
  paths: string[],
  pendingFolders: string[] = [],
): Record<string, TreeItemData> {
  const data: Record<string, TreeItemData> = {
    [ROOT_ID]: { name: '', isFolder: true, children: [] },
  }

  const ensureFolder = (path: string): void => {
    if (data[path]) return
    data[path] = { name: baseName(path), isFolder: true, children: [] }
    const slash = path.lastIndexOf('/')
    const parent = slash === -1 ? ROOT_ID : path.slice(0, slash)
    if (parent !== ROOT_ID) ensureFolder(parent)
    data[parent].children.push(path)
  }

  for (const folder of pendingFolders) ensureFolder(folder)

  for (const path of paths) {
    const slash = path.lastIndexOf('/')
    const parent = slash === -1 ? ROOT_ID : path.slice(0, slash)
    if (parent !== ROOT_ID) ensureFolder(parent)
    data[path] = { name: path.slice(slash + 1), isFolder: false, children: [] }
    data[parent].children.push(path)
  }

  data[ROOT_ID].children = data[ROOT_ID].children.filter((id) => !HIDDEN_ROOTS.has(data[id].name))

  const rank = (id: string) => (data[id].isFolder ? 0 : 1)
  for (const item of Object.values(data)) {
    item.children.sort(
      (a, b) => rank(a) - rank(b) || data[a].name.localeCompare(data[b].name),
    )
  }

  return data
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `pnpm exec vitest run src/renderer/src/lib/tree-data.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/tree-data.ts src/renderer/src/lib/tree-data.test.ts
git commit -m "feat(tree): buildTreeData — snapshot to headless-tree flat record

Claude goes brr.. via Dash"
```

---

## Task 3: `tree-paths.ts` — path helpers

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/tree-paths.ts`
- Test: `apps/desktop/src/renderer/src/lib/tree-paths.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { basename, joinPath, parentOf, renameBasenameRange, withMdExtension } from './tree-paths'

describe('tree-paths', () => {
  it('joins, tolerating empty parent', () => {
    expect(joinPath('', 'a.md')).toBe('a.md')
    expect(joinPath('projects', 'a.md')).toBe('projects/a.md')
  })
  it('appends .md only when no extension is present', () => {
    expect(withMdExtension('note')).toBe('note.md')
    expect(withMdExtension('note.md')).toBe('note.md')
    expect(withMdExtension('a.canvas')).toBe('a.canvas')
  })
  it('basename and parentOf', () => {
    expect(basename('projects/a.md')).toBe('a.md')
    expect(parentOf('projects/sub/a.md')).toBe('projects/sub')
    expect(parentOf('a.md')).toBe('')
  })
  it('renameBasenameRange selects the name without the extension', () => {
    // used to pre-select the editable portion on rename (VS Code behavior)
    expect(renameBasenameRange('roadmap.md')).toEqual([0, 7])
    expect(renameBasenameRange('no-ext')).toEqual([0, 6])
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm exec vitest run src/renderer/src/lib/tree-paths.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/** Small, pure path helpers for the file tree. Vault paths are POSIX-style
 *  ('/'-separated), relative to the vault root. */

export const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

export const parentOf = (path: string): string => {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

export const joinPath = (parent: string, name: string): string => (parent ? `${parent}/${name}` : name)

/** New notes default to markdown; an explicit extension is left alone. */
export const withMdExtension = (name: string): string => (/\.[^./]+$/.test(name) ? name : `${name}.md`)

/** The [start, end] of the basename minus its extension — what a rename input
 *  should pre-select so the user edits the name, not the `.md` (VS Code). */
export const renameBasenameRange = (name: string): [number, number] => {
  const dot = name.lastIndexOf('.')
  return [0, dot > 0 ? dot : name.length]
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `pnpm exec vitest run src/renderer/src/lib/tree-paths.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/tree-paths.ts src/renderer/src/lib/tree-paths.test.ts
git commit -m "feat(tree): pure path helpers for the file tree

Claude goes brr.. via Dash"
```

---

## Task 4: Icons

**Files:**
- Create: `apps/desktop/src/renderer/src/components/tree/icons.tsx`

- [ ] **Step 1: Write the icons**

```tsx
/** Monochrome inline SVGs for the Holi-native tree skin — no icon-font
 *  dependency (the app ships none). All inherit `currentColor`. */

export function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"
      style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }}>
      <path d="M6 4l4 4-4 4V4z" />
    </svg>
  )
}

export function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3l1.5 1.5H13A1.5 1.5 0 0 1 14.5 5v6.5A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5v-8z" />
    </svg>
  )
}

export function MarkdownIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M2.5 3h11A1.5 1.5 0 0 1 15 4.5v7A1.5 1.5 0 0 1 13.5 13h-11A1.5 1.5 0 0 1 1 11.5v-7A1.5 1.5 0 0 1 2.5 3zm1 3v4h1.4V8.2L6.2 10l1.3-1.8V10h1.4V6H7.5L6.2 7.9 4.9 6H3.5zm7.3 0v2.1H9.6L11.5 11l1.9-2.9h-1.2V6h-1.4z" />
    </svg>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc --noEmit 2>&1 | grep -c error`
Expected: `36`.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/tree/icons.tsx
git commit -m "feat(tree): monochrome inline SVG icons

Claude goes brr.. via Dash"
```

---

## Task 5: Rewrite `FileTree` on headless-tree (render, expand, open, skin)

This task establishes the confirmed headless-tree integration and the Holi-native skin. It replaces the whole component body. Keep the exported prop shape identical so `Shell.tsx` needs no change.

**Files:**
- Rewrite: `apps/desktop/src/renderer/src/components/FileTree.tsx`

- [ ] **Step 1: Replace the file with the headless-tree container**

```tsx
/**
 * The vault as a VS Code-style explorer.
 *
 * Pure projection of `snapshotAtom` (plus a client-only `pendingNodes` set for
 * transient folders and inline-create rows). headless-tree owns
 * selection/focus/expansion/keyboard; every mutation runs through our atoms so
 * the link-rewrite rename and backref/tombstone delete stay ours.
 */
import {
  dragAndDropFeature,
  hotkeysCoreFeature,
  renamingFeature,
  selectionFeature,
  syncDataLoaderFeature,
} from '@headless-tree/core'
import { useTree } from '@headless-tree/react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useMemo, useState } from 'react'
import { ChevronIcon, FolderIcon, MarkdownIcon } from './tree/icons'
import { buildTreeData, ROOT_ID, type TreeItemData } from '../lib/tree-data'
import { renameBasenameRange } from '../lib/tree-paths'
import { renameNoteAtom, snapshotAtom } from '../state/vaults'

export function FileTree({
  activePath,
  onOpenPreview,
  onOpenPinned,
}: {
  activePath: string | null
  onOpenPreview: (path: string) => void
  onOpenPinned: (path: string) => void
}) {
  const snapshot = useAtomValue(snapshotAtom)
  const renameNote = useSetAtom(renameNoteAtom)
  // Transient folders (spec §Empty folders): client-only until a note lands.
  const [pendingFolders] = useState<string[]>([])

  const data = useMemo(
    () => buildTreeData(snapshot.docs.map((d) => d.path), pendingFolders),
    [snapshot, pendingFolders],
  )

  const tree = useTree<TreeItemData>({
    rootItemId: ROOT_ID,
    getItemName: (item) => item.getItemData().name,
    isItemFolder: (item) => item.getItemData().isFolder,
    dataLoader: {
      getItem: (id) => data[id],
      getChildren: (id) => data[id]?.children ?? [],
    },
    indent: 12,
    // Single-click / Enter opens a preview tab (browsing costs one tab).
    onPrimaryAction: (item) => {
      if (!item.isFolder()) onOpenPreview(item.getId())
    },
    canRename: (item) => !item.isFolder(),
    onRename: (item, value) => {
      const to = value.endsWith('.md') ? value : `${value}.md`
      const from = item.getId()
      const parent = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : ''
      if (to && `${parent}${to}` !== from) void renameNote({ from, to: `${parent}${to}` })
    },
    features: [
      syncDataLoaderFeature,
      selectionFeature,
      hotkeysCoreFeature,
      dragAndDropFeature,
      renamingFeature,
    ],
  })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="holi-scroll min-h-0 flex-1 overflow-y-auto py-1 text-sm" {...tree.getContainerProps()}>
        {tree.getItems().map((item) => {
          const id = item.getId()
          const isOpen = activePath === id
          const isFolder = item.isFolder()
          return (
            <div
              key={id}
              {...item.getProps()}
              style={{ paddingLeft: `${item.getIndent() * 12 + 8}px` }}
              className={[
                'flex h-[22px] items-center gap-1 rounded pr-2 outline-none transition-colors',
                item.isSelected()
                  ? 'bg-neutral-800 text-neutral-100'
                  : 'text-neutral-300 hover:bg-neutral-800/60',
                isOpen ? 'text-sky-300' : '',
              ].join(' ')}
              onDoubleClick={() => !isFolder && onOpenPinned(id)}
            >
              <span className="flex w-4 shrink-0 justify-center text-neutral-500">
                {isFolder ? <ChevronIcon open={item.isExpanded()} /> : null}
              </span>
              <span className={`flex w-4 shrink-0 justify-center ${isOpen ? 'text-sky-400' : 'text-neutral-500'}`}>
                {isFolder ? <FolderIcon /> : <MarkdownIcon />}
              </span>
              {item.isRenaming() ? (
                <input
                  {...item.getRenameInputProps()}
                  autoFocus
                  className="min-w-0 flex-1 rounded border border-sky-700 bg-neutral-900 px-1 text-sm outline-none"
                  ref={(el) => {
                    if (!el) return
                    const [s, e] = renameBasenameRange(el.value)
                    el.setSelectionRange(s, e)
                  }}
                />
              ) : (
                <span className="min-w-0 flex-1 truncate">{item.getItemName()}</span>
              )}
            </div>
          )
        })}
        {tree.getItems().length === 0 && (
          <p className="px-2 text-xs text-neutral-500">no notes yet</p>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc --noEmit 2>&1 | grep -c error`
Expected: `36`. If headless-tree types complain about the `useTree` generic or a feature import name, fix against the installed `node_modules/@headless-tree/core` types before proceeding — do not add `any`.

- [ ] **Step 3: Verify live (CDP)**

Ensure the dev app is running on 9333 (relaunch if a main edit happened: it hasn't here). Then:

```bash
pnpm exec node /tmp/holi-drive.mjs eval "(() => { const rows=[...document.querySelectorAll('[role=treeitem],[data-tree-item]')]; return JSON.stringify({ rowCount: rows.length, firstFew: rows.slice(0,4).map(r=>r.textContent.trim()) }); })()"
pnpm exec node /tmp/holi-drive.mjs shot "$PWD/../../.brainstorm-shot-tree.png"
```

Expected: rows render for the vault's notes/folders; clicking a folder toggles expansion; clicking a file opens a preview tab (the editor loads it). Read the screenshot to confirm twisties, icons, indentation, and that the open file shows the sky accent. If rows have no `role=treeitem`, inspect `item.getProps()` output and adjust the selector — the props come from headless-tree.

- [ ] **Step 4: Full test + typecheck guard**

Run: `pnpm exec vitest run` → Expected: all green (552+ from prior tasks). Run typecheck → `36`.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/FileTree.tsx
git commit -m "feat(tree): render the file tree on headless-tree (open/expand/rename)

Claude goes brr.. via Dash"
```

---

## Task 6: ExplorerHeader — vault name + New File / New Folder / Collapse All

**Files:**
- Create: `apps/desktop/src/renderer/src/components/tree/ExplorerHeader.tsx`
- Modify: `apps/desktop/src/renderer/src/components/FileTree.tsx` (render the header; add pending-create state)

- [ ] **Step 1: Create the header**

```tsx
/** The explorer's action strip: the vault name and the three VS Code header
 *  actions. Icons are inline SVGs (the app ships no icon font). */
export function ExplorerHeader({
  title,
  onNewFile,
  onNewFolder,
  onCollapseAll,
}: {
  title: string
  onNewFile: () => void
  onNewFolder: () => void
  onCollapseAll: () => void
}) {
  return (
    <div className="flex items-center justify-between px-2 py-1">
      <span className="truncate text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
        {title}
      </span>
      <span className="flex shrink-0 gap-0.5 text-neutral-500">
        <button className="rounded p-1 hover:bg-neutral-800 hover:text-neutral-200" title="New File" onClick={onNewFile} aria-label="New File">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor"><path d="M9 1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5L9 1zm3 12H4V2h4v3h4v8zM7 7h1v2h2v1H8v2H7v-2H5V9h2V7z"/></svg>
        </button>
        <button className="rounded p-1 hover:bg-neutral-800 hover:text-neutral-200" title="New Folder" onClick={onNewFolder} aria-label="New Folder">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor"><path d="M2 3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3H2zm9 5h1v2h2v1h-2v2h-1v-2H9V10h2V8z"/></svg>
        </button>
        <button className="rounded p-1 hover:bg-neutral-800 hover:text-neutral-200" title="Collapse All" onClick={onCollapseAll} aria-label="Collapse All">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor"><path d="M2 3h12v1H2V3zm0 3h8v1H2V6zm0 3h12v1H2V9zm0 3h8v1H2v-1z"/></svg>
        </button>
      </span>
    </div>
  )
}
```

- [ ] **Step 2: Wire it into FileTree**

In `FileTree.tsx`, import the header and the active remote, add pending-create state, and render the header above the scroller. Add near the top of the component body:

```tsx
import { ExplorerHeader } from './tree/ExplorerHeader'
import { activeRemoteAtom, createNoteAtom, renameNoteAtom, snapshotAtom } from '../state/vaults'
import { joinPath, withMdExtension } from '../lib/tree-paths'
// ...
const activeRemote = useAtomValue(activeRemoteAtom)
const createNote = useSetAtom(createNoteAtom)
const [pendingFolders, setPendingFolders] = useState<string[]>([])
// A pending inline-create row: kind + the folder it is created under.
const [pending, setPending] = useState<{ kind: 'file' | 'folder'; parent: string } | null>(null)

const collapseAll = () => {
  for (const item of tree.getItems()) if (item.isFolder() && item.isExpanded()) item.collapse()
}
```

Then render the header directly inside the outer `<div className="flex min-h-0 flex-1 flex-col">`, before the scroller:

```tsx
<ExplorerHeader
  title={activeRemote?.split('/').at(-1) ?? 'vault'}
  onNewFile={() => setPending({ kind: 'file', parent: '' })}
  onNewFolder={() => setPending({ kind: 'folder', parent: '' })}
  onCollapseAll={collapseAll}
/>
```

(The `pending` row rendering is Task 7; for now the setters compile but do nothing visible.)

- [ ] **Step 3: Typecheck**

Run: `pnpm exec tsc --noEmit 2>&1 | grep -c error`
Expected: `36`. Note: `item.collapse()` is part of the expansion API; if the installed types name it differently, adjust to the real method (do not guess a second name elsewhere — use the same one).

- [ ] **Step 4: Verify live**

Reload and screenshot: header shows the vault name and three action buttons; Collapse All folds open folders.

```bash
pnpm exec node /tmp/holi-drive.mjs shot "$PWD/../../.brainstorm-shot-header.png"
```

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/tree/ExplorerHeader.tsx src/renderer/src/components/FileTree.tsx
git commit -m "feat(tree): explorer header with New File / New Folder / Collapse All

Claude goes brr.. via Dash"
```

---

## Task 7: Inline create (New File / New Folder + transient folders)

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/FileTree.tsx`

- [ ] **Step 1: Render the inline-create row**

Add a `PendingRow` sub-component to `FileTree.tsx`, and render it at the top of the scroller when `pending !== null`:

```tsx
function PendingRow({
  kind,
  parent,
  onCommit,
  onCancel,
}: {
  kind: 'file' | 'folder'
  parent: string
  onCommit: (name: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState('')
  return (
    <div className="flex h-[22px] items-center gap-1 pr-2" style={{ paddingLeft: '8px' }}>
      <span className="flex w-4 shrink-0 justify-center text-neutral-500">
        {kind === 'folder' ? <FolderIcon /> : <MarkdownIcon />}
      </span>
      <input
        autoFocus
        className="min-w-0 flex-1 rounded border border-sky-700 bg-neutral-900 px-1 text-sm outline-none"
        placeholder={kind === 'folder' ? 'folder name' : 'note name'}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
          if (e.key === 'Enter' && value.trim()) onCommit(value.trim())
        }}
        onBlur={onCancel}
      />
    </div>
  )
}
```

Render inside the scroller, before the mapped items:

```tsx
{pending && (
  <PendingRow
    kind={pending.kind}
    parent={pending.parent}
    onCancel={() => setPending(null)}
    onCommit={(name) => {
      if (pending.kind === 'folder') {
        setPendingFolders((f) => [...f, joinPath(pending.parent, name)])
        setPending(null)
      } else {
        void createNote(joinPath(pending.parent, withMdExtension(name)))
        setPending(null)
      }
    }}
  />
)}
```

- [ ] **Step 2: Drop a pending folder once a note lands inside it**

A transient folder becomes real when the snapshot carries a doc under it. Add an effect so stale pending folders are pruned:

```tsx
import { useEffect } from 'react'
// ...
useEffect(() => {
  const realPrefixes = snapshot.docs.map((d) => d.path)
  setPendingFolders((f) =>
    f.filter((folder) => !realPrefixes.some((p) => p.startsWith(`${folder}/`))),
  )
}, [snapshot])
```

- [ ] **Step 3: Typecheck**

Run: `pnpm exec tsc --noEmit 2>&1 | grep -c error`
Expected: `36`.

- [ ] **Step 4: Verify live**

Reload. Click New File → an input row appears → type `scratch` → Enter → `scratch.md` is created and opens. Click New Folder → type `drafts` → Enter → an empty `drafts` folder appears; create a note inside it (New File then type `drafts/idea` won't work yet — instead select the folder in Task 8; for now verify the empty folder shows and vanishes on reload since it's empty).

```bash
pnpm exec node /tmp/holi-drive.mjs eval "document.querySelector('[aria-label=\"New File\"]').click(); 'clicked new file'"
```

Confirm via screenshot the input row appears.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/FileTree.tsx
git commit -m "feat(tree): inline New File / New Folder with transient folders

Claude goes brr.. via Dash"
```

---

## Task 8: Right-click context menu (Rename, Delete, New in folder, Copy Path, Reveal)

**Files:**
- Create: `apps/desktop/src/renderer/src/components/tree/TreeContextMenu.tsx`
- Modify: `apps/desktop/src/renderer/src/components/FileTree.tsx` (open menu on row context-menu; wire actions)

- [ ] **Step 1: Create the menu component**

```tsx
/** A self-contained right-click popover (no menu library). Positioned at the
 *  cursor; closes on outside-click or Escape. Items are provided by the caller so
 *  the menu itself stays dumb. */
import { useEffect } from 'react'

export interface MenuItem {
  label: string
  onSelect: () => void
  kbd?: string
  danger?: boolean
}

export function TreeContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number
  y: number
  items: (MenuItem | 'separator')[]
  onClose: () => void
}) {
  useEffect(() => {
    const close = () => onClose()
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
      window.removeEventListener('keydown', esc)
    }
  }, [onClose])

  return (
    <div
      className="fixed z-50 w-56 rounded-lg border border-neutral-700 bg-neutral-900 p-1 text-xs shadow-xl"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((it, i) =>
        it === 'separator' ? (
          <div key={i} className="my-1 h-px bg-neutral-800" />
        ) : (
          <button
            key={i}
            className={`flex w-full items-center justify-between rounded px-2 py-1 text-left hover:bg-neutral-800 ${
              it.danger ? 'text-red-300' : 'text-neutral-200'
            }`}
            onClick={() => {
              it.onSelect()
              onClose()
            }}
          >
            <span>{it.label}</span>
            {it.kbd && <span className="text-neutral-500">{it.kbd}</span>}
          </button>
        ),
      )}
    </div>
  )
}
```

- [ ] **Step 2: Wire the menu in FileTree**

Add menu state and a builder. Import the delete flow (reuse the existing `DeleteConfirm` from the old FileTree — move it into `tree/DeleteConfirm.tsx` if cleaner, or keep inline). Add:

```tsx
import { TreeContextMenu, type MenuItem } from './tree/TreeContextMenu'
import { backrefsFor, deleteNoteAtom } from '../state/vaults'
import { basename, parentOf } from '../lib/tree-paths'
// ...
const getBackrefs = useSetAtom(backrefsFor)
const deleteNote = useSetAtom(deleteNoteAtom)
const [menu, setMenu] = useState<{ x: number; y: number; path: string; isFolder: boolean } | null>(null)
const [confirming, setConfirming] = useState<{ path: string; refs: { path: string; count: number }[] } | null>(null)

const buildMenu = (path: string, isFolder: boolean): (MenuItem | 'separator')[] => {
  const folderParent = isFolder ? path : parentOf(path)
  return [
    { label: 'New File…', onSelect: () => setPending({ kind: 'file', parent: folderParent }) },
    { label: 'New Folder…', onSelect: () => setPending({ kind: 'folder', parent: folderParent }) },
    'separator',
    ...(isFolder
      ? []
      : ([{ label: 'Rename…', kbd: 'F2', onSelect: () => tree.getItemInstance(path).startRenaming() }] as MenuItem[])),
    ...(isFolder
      ? []
      : ([
          {
            label: 'Delete',
            kbd: '⌫',
            danger: true,
            onSelect: () => void getBackrefs(path).then((refs) => setConfirming({ path, refs })),
          },
        ] as MenuItem[])),
    'separator',
    { label: 'Copy Path', onSelect: () => void navigator.clipboard.writeText(path) },
    { label: 'Copy Relative Path', onSelect: () => void navigator.clipboard.writeText(path) },
    { label: 'Reveal in Finder', onSelect: () => void window.holi.openPath(absPathFor(path)) },
  ]
}
```

Note: `tree.getItemInstance(id)` returns the item to call `startRenaming()`; confirm this accessor name against the installed types (headless-tree exposes an item lookup — if it is named differently, use that one consistently). `absPathFor(path)` needs the vault's absolute clone root; get it from the active vault entry:

```tsx
import { vaultsAtom } from '../state/vaults'
// ...
const entry = useAtomValue(vaultsAtom).find((v) => v.remote === activeRemote)
const absPathFor = (rel: string) => (entry ? `${entry.path}/${rel}` : rel)
```

(Copy Path vs Copy Relative Path differ once absolute paths are wired: Copy Path uses `absPathFor(path)`, Copy Relative Path uses `path`. Fix the two `onSelect`s accordingly.)

Add `onContextMenu` to the row `<div>` in the item map:

```tsx
onContextMenu={(e) => {
  e.preventDefault()
  setMenu({ x: e.clientX, y: e.clientY, path: id, isFolder })
}}
```

Render the menu and the delete dialog at the end of the component:

```tsx
{menu && (
  <TreeContextMenu x={menu.x} y={menu.y} items={buildMenu(menu.path, menu.isFolder)} onClose={() => setMenu(null)} />
)}
{confirming && (
  <DeleteConfirm
    path={confirming.path}
    refs={confirming.refs}
    onCancel={() => setConfirming(null)}
    onConfirm={() => {
      const p = confirming.path
      setConfirming(null)
      void deleteNote(p)
    }}
  />
)}
```

- [ ] **Step 3: Move `DeleteConfirm` into its own file**

Create `apps/desktop/src/renderer/src/components/tree/DeleteConfirm.tsx` with the existing `DeleteConfirm` component (copy it verbatim from the pre-rewrite `FileTree.tsx` git history — `git show HEAD~6:apps/desktop/src/renderer/src/components/FileTree.tsx` shows it) and import it in `FileTree.tsx`.

- [ ] **Step 4: Typecheck**

Run: `pnpm exec tsc --noEmit 2>&1 | grep -c error`
Expected: `36`. Resolve any headless-tree accessor-name mismatch (`getItemInstance`) against the installed types.

- [ ] **Step 5: Verify live**

Reload. Right-click a file → menu appears with Rename / Delete / Copy Path / Reveal in Finder / New File / New Folder. Rename renames (and rewrites links — check a note that links to it). Delete shows the backref dialog. Reveal in Finder opens Finder at the file. Copy Path puts the absolute path on the clipboard.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/tree/TreeContextMenu.tsx src/renderer/src/components/tree/DeleteConfirm.tsx src/renderer/src/components/FileTree.tsx
git commit -m "feat(tree): right-click context menu (rename, delete, copy path, reveal)

Claude goes brr.. via Dash"
```

---

## Task 9: Keyboard — Enter opens, F2 renames, Delete deletes

headless-tree's `hotkeysCoreFeature` already gives arrow navigation, typeahead, and F2 (via `canRename`/`renamingFeature`). Enter maps to `onPrimaryAction` (already wired). This task adds Delete.

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/FileTree.tsx`

- [ ] **Step 1: Wire a Delete hotkey**

headless-tree hotkeys are configured via `hotkeys` on `useTree`. Add to the `useTree` config:

```tsx
hotkeys: {
  customDelete: {
    hotkey: 'Delete',
    handler: (_e, tree) => {
      const focused = tree.getFocusedItem()
      if (focused && !focused.isFolder()) {
        const path = focused.getId()
        void getBackrefs(path).then((refs) => setConfirming({ path, refs }))
      }
    },
  },
},
```

Confirm `tree.getFocusedItem()` and the `hotkeys` config shape against the installed types; if the focused-item accessor differs, use the real one. Also bind Backspace on macOS by adding a second entry `customDeleteMac: { hotkey: 'Backspace', handler: <same> }`.

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc --noEmit 2>&1 | grep -c error`
Expected: `36`.

- [ ] **Step 3: Verify live**

Reload. Arrow-key up/down moves focus; typing jumps (typeahead); F2 renames the focused file; Delete/Backspace on a focused file opens the delete dialog; Enter opens the focused file.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/FileTree.tsx
git commit -m "feat(tree): keyboard — Enter opens, F2 renames, Delete deletes

Claude goes brr.. via Dash"
```

---

## Task 10: Retire the old tree module + full verification

**Files:**
- Modify/Delete: `apps/desktop/src/renderer/src/lib/tree.ts` (old `buildTree`/`TreeNode`)
- Verify: whole suite

- [ ] **Step 1: Confirm nothing imports the old module**

Run: `grep -rn "from '.*lib/tree'" apps/desktop/src` and `grep -rn "buildTree\b" apps/desktop/src`
Expected: only `tree-data.ts`/`FileTree.tsx` references remain (the new ones). If `lib/tree.ts` is now unused, delete it and its test.

- [ ] **Step 2: Delete if unused**

```bash
git rm apps/desktop/src/renderer/src/lib/tree.ts
# and its test if present
```

- [ ] **Step 3: Full gates**

Run:
```bash
cd apps/desktop && pnpm exec vitest run
pnpm exec tsc --noEmit 2>&1 | grep -c error
pnpm exec electron-vite build 2>&1 | tail -3
```
Expected: all tests green; typecheck `36`; build succeeds.

- [ ] **Step 4: Live smoke test of the whole surface**

Reload and confirm end-to-end: header actions; expand/collapse; single-click preview / double-click pin; inline New File / New Folder; right-click menu; rename (with link rewrite); delete (with backref preview); keyboard (arrows/typeahead/F2/Enter/Delete). Screenshot for the record.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(tree): retire the old nested buildTree module

Claude goes brr.. via Dash"
```

---

## Phase 2 (separate plan, after Phase 1 lands)

Not implemented here — a fresh plan will cover: multi-select (⌘/⇧-click); drag-and-drop move (`onDrop`/`canDrop`, `createForeignDragObject`) with the batch backend; cut/copy/paste/duplicate; folder rename/delete/move; and the batch tRPC procedures `notes.move({moves})` (single-pass link rewrite), `notes.copy({copies})`, `notes.deleteMany({paths})`, and multi-path `notes.backrefs({paths})` — each with focused unit tests, especially the single-pass link rewrite. See the spec's "Backend" and "Phasing" sections.

## Self-review notes

- **Spec coverage (Phase 1 slice):** header actions ✓ (T6), twisties/icons/skin ✓ (T4/T5), inline create + transient folders ✓ (T7), inline rename with basename pre-select ✓ (T3/T5), context menu incl. Copy Path/Relative/Reveal ✓ (T8), delete with backref preview ✓ (T8), keyboard ✓ (T9), snapshot-projection data model ✓ (T2/T5). Deferred to Phase 2 by design: multi-select, DnD, cut/copy/paste/duplicate, folder ops, batch backend.
- **Library-API caveat:** headless-tree accessor names used across tasks — `tree.getItems()`, `item.getProps/getId/getItemName/isFolder/isExpanded/isSelected/isRenaming/getRenameInputProps/getIndent/startRenaming`, `tree.getContainerProps()`, config `onPrimaryAction/onRename/canRename`, features `syncDataLoaderFeature/selectionFeature/hotkeysCoreFeature/dragAndDropFeature/renamingFeature` — are confirmed from the docs. Three are flagged to confirm against the installed types before use and to keep consistent if they differ: `item.collapse()` (T6), `tree.getItemInstance(id)` (T8), `tree.getFocusedItem()` + `hotkeys` config shape (T9). These are isolated to one task each and cannot silently diverge elsewhere.
