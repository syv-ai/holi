# Arbitrary file types in the vault — Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the vault hold and show files of any type — not only markdown. Text files (`.json`, `.txt`, `.csv`, `.yaml`, …) open in a plain in-app editor; images, PDFs, and office docs open a typed in-app **placeholder** that a real renderer can later replace (no "Reveal in Finder" stopgap). Markdown keeps its full editor untouched.

**Architecture:** The scanner grows a second list — `VaultSnapshot.files` for every non-markdown, non-ignored file — kept separate from `docs` so notes, mentions, backrefs, and the link-rewrite stay markdown-only and correct. The tree projects `docs ∪ files`. A pure `fileKind(path)` classifier (in `@holi/shared`) drives both the row icon and the editor pane the Shell renders: `markdown → EditorPane`, `text → EditorPane` in a new plain mode, everything else → `FilePlaceholder`. New File creates the literal name you type (defaulting `.md` only when you type no extension at all), with markdown scaffold content for `.md` and an empty file otherwise.

**Tech Stack:** React 18, TypeScript, Tailwind v4, jotai, CodeMirror 6, `@holi/shared`, Vitest 4 (node env), CDP for live UI.

**User decisions (locked this session):**
- The vault must support non-markdown files; "files will mostly be markdown."
- Text files: editable in-app now. Images / PDFs / Word docs / etc.: **placeholder** now, real renderers later. **No** "Reveal in Finder" temporary affordance.

---

## Conventions (read once)

- **Tooling:** bare `node`/`npx` broken — always `pnpm exec`. Desktop tests from `apps/desktop/`; shared from `packages/shared/`.
- **Typecheck gate:** from `apps/desktop`, `pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"` — baseline **36**, must not rise.
- **Live app:** dev instance on CDP 9333, driver `/tmp/holi-drive.mjs`. Renderer edits hot-reload; **main edits (scanner) need a relaunch** — ask the user to relaunch, or note it.
- **Commit trailer:** end every commit message with `Claude goes brr.. via Dash`.

## File Structure

- **Modify** `packages/shared/src/types.ts` — add `FileMeta` and `VaultSnapshot.files: FileMeta[]`.
- **Create** `packages/shared/src/file-kind.ts` — `fileKind(path): FileKind` classifier.
- **Create** `packages/shared/test/file-kind.test.ts` — tests.
- **Modify** `packages/shared/src/index.ts` — export `fileKind` / `FileKind` / `FileMeta` (whatever the barrel exports).
- **Modify** `apps/desktop/src/main/vault/vault-store.ts` — `scanVault` emits `files`.
- **Modify** `apps/desktop/test/vault-store.test.ts` — assert non-md files land in `files`, md stays in `docs`.
- **Modify** every `VaultSnapshot` literal to include `files: []` — `src/renderer/src/state/vaults.ts` (EMPTY_SNAPSHOT), `src/main/vault/active-vault.ts`, and test helpers in `test/rename-state.test.ts`, `test/batch-ops-state.test.ts` (and any other `{ docs: [], tasks: [], broken: [] }`).
- **Modify** `apps/desktop/src/renderer/src/components/FileTree.tsx` — feed `docs ∪ files` to the tree; pick the row icon by `fileKind`; open the created file; drop the md coercion in favour of literal names.
- **Modify** `apps/desktop/src/renderer/src/lib/tree-paths.ts` + `test/tree-paths.test.ts` — `withMdExtension` back to "append `.md` only when no extension".
- **Modify** `apps/desktop/src/renderer/src/state/vaults.ts` — `createNoteAtom` scaffolds only for `.md`, empty otherwise; opens files too.
- **Create** `apps/desktop/src/renderer/src/components/tree/icons.tsx` additions — `FileIcon`, `ImageIcon`, `PdfIcon`, `DocIcon` (or a small `kindIcon` map).
- **Modify** `apps/desktop/src/renderer/src/editor/extensions.ts` — a `plainTextExtensions()` set (no frontmatter/wiki/mention layers).
- **Modify** `apps/desktop/src/renderer/src/components/EditorPane.tsx` — a `plain` mode that swaps extensions, caret, and the save-gate; the markdown path stays byte-identical.
- **Create** `apps/desktop/src/renderer/src/components/FilePlaceholder.tsx` — the typed "no preview yet" panel.
- **Modify** `apps/desktop/src/renderer/src/components/Shell.tsx` — dispatch the note tab by `fileKind`.

---

## Task 1: `fileKind` classifier + `VaultSnapshot.files` (shared)

**Files:**
- Create: `packages/shared/src/file-kind.ts`
- Test: `packages/shared/test/file-kind.test.ts`
- Modify: `packages/shared/src/types.ts`, `packages/shared/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/test/file-kind.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { fileKind } from '../src/file-kind'

describe('fileKind', () => {
  it('classifies markdown', () => {
    expect(fileKind('a.md')).toBe('markdown')
    expect(fileKind('notes/deep/b.md')).toBe('markdown')
  })
  it('classifies editable text (incl. unknown/no extension — the forgiving default)', () => {
    for (const p of ['a.json', 'a.txt', 'a.csv', 'a.yaml', 'a.yml', 'a.env', 'a.ts', '.gitignore', 'Makefile'])
      expect(fileKind(p)).toBe('text')
  })
  it('classifies known rich types that need a renderer', () => {
    for (const p of ['a.png', 'a.jpg', 'a.jpeg', 'a.gif', 'a.webp', 'a.svg']) expect(fileKind(p)).toBe('image')
    expect(fileKind('a.pdf')).toBe('pdf')
    for (const p of ['a.docx', 'a.doc', 'a.xlsx', 'a.pptx']) expect(fileKind(p)).toBe('doc')
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd packages/shared && pnpm exec vitest run test/file-kind.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/shared/src/file-kind.ts`:

```ts
/**
 * What kind of file a vault path is, for choosing an icon and an editor.
 *
 * The vault is "mostly markdown" but holds anything now. `markdown` and `text`
 * open in an editor; `image` / `pdf` / `doc` open a typed placeholder until a
 * real renderer exists. Unknown or extension-less files default to `text` (the
 * forgiving choice — a `.env` or a `Makefile` is editable), so the placeholder
 * is reserved for the known visual/rich formats that would be garbage as UTF-8.
 */
export type FileKind = 'markdown' | 'text' | 'image' | 'pdf' | 'doc'

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg'])
const DOC = new Set(['doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp', 'pages', 'numbers', 'key'])

export function fileKind(path: string): FileKind {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (ext === 'pdf') return 'pdf'
  if (IMAGE.has(ext)) return 'image'
  if (DOC.has(ext)) return 'doc'
  return 'text'
}
```

- [ ] **Step 4: Add `FileMeta` + `files` to the snapshot type**

In `packages/shared/src/types.ts`, after `DocMeta`:

```ts
/** A non-markdown file the vault carries (spec §Arbitrary files). Not a note —
 *  it has no `kind`, no frontmatter, and never participates in wiki-links; the
 *  scanner keeps it out of `docs` precisely so backrefs/rename stay markdown. */
export interface FileMeta {
  /** Vault-relative, '/'-separated. */
  path: string
  /** File mtime, ISO. */
  updatedAt: string
}
```

And add to `VaultSnapshot`:

```ts
export interface VaultSnapshot {
  docs: DocMeta[]
  tasks: Task[]
  broken: BrokenTask[]
  /** Non-markdown files, kept separate from notes so link-aware ops stay md-only. */
  files: FileMeta[]
}
```

- [ ] **Step 5: Export from the barrel**

In `packages/shared/src/index.ts`, add exports so the renderer and main can import them (match the existing export style — likely `export * from './file-kind'` and `FileMeta` rides along with the `types` export). Verify `FileMeta`, `FileKind`, `fileKind` are all reachable from `@holi/shared`.

- [ ] **Step 6: Run tests + typecheck the package**

Run: `cd packages/shared && pnpm exec vitest run` → the shared suite goes red where snapshot literals now miss `files`; those are fixed in Task 2 (main) and Task 3 (renderer). The `file-kind` test must PASS. Then `pnpm exec tsc --noEmit` in `packages/shared` — expect errors only where a `VaultSnapshot` literal omits `files` (fixed next). If `packages/shared` itself has no such literal, it is clean.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/file-kind.ts packages/shared/test/file-kind.test.ts packages/shared/src/types.ts packages/shared/src/index.ts
git commit -m "feat(shared): fileKind classifier + VaultSnapshot.files

Claude goes brr.. via Dash"
```

---

## Task 2: `scanVault` emits non-markdown files (main)

**Files:**
- Modify: `apps/desktop/src/main/vault/vault-store.ts`
- Modify: `apps/desktop/test/vault-store.test.ts`
- Modify: `apps/desktop/src/main/vault/active-vault.ts` (any empty-snapshot literal)

- [ ] **Step 1: Write the failing test**

Add to `apps/desktop/test/vault-store.test.ts` (match its existing `vault({...})` helper; if it constructs files, add non-md ones):

```ts
it('lists non-markdown files separately from notes, ignoring junk', async () => {
  const root = await vault({
    'note.md': '# Note',
    'data.json': '{"a":1}',
    'sub/pic.png': 'binary-ish',
    '.DS_Store': 'junk',
  })
  const snap = await scanVault(root)
  expect(snap.docs.map((d) => d.path)).toEqual(['note.md'])
  expect(snap.files.map((f) => f.path).sort()).toEqual(['data.json', 'sub/pic.png'])
})
```

(If `vault-store.test.ts` has no `vault` helper, mirror the one in `backrefs.test.ts`. Confirm the existing test file's imports include `scanVault`.)

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/desktop && pnpm exec vitest run test/vault-store.test.ts`
Expected: FAIL — `snap.files` is undefined (and TS: `files` missing on the literals).

- [ ] **Step 3: Implement the scan**

In `apps/desktop/src/main/vault/vault-store.ts`, initialize `files` and split the walk. Replace the current body of `scanVault`:

```ts
export async function scanVault(root: string): Promise<VaultSnapshot> {
  const snapshot: VaultSnapshot = { docs: [], tasks: [], broken: [], files: [] }

  const all = (await listFiles(root)).filter((rel) => !isIgnoredPath(rel))

  for (const path of all) {
    const mtime = () =>
      stat(`${root}/${path}`)
        .then((s) => s.mtime.toISOString())
        .catch(() => new Date(0).toISOString())

    // Non-markdown: a plain file entry. No read, no parse — it is not a note.
    if (!path.endsWith('.md')) {
      snapshot.files.push({ path, updatedAt: await mtime() })
      continue
    }

    const text = await readFile(`${root}/${path}`, 'utf8').catch(() => null)
    if (text === null) continue

    if (isTaskFilePath(path)) {
      try {
        snapshot.tasks.push(parseTaskFile(text, path))
      } catch (err) {
        if (!(err instanceof TaskFileError)) throw err
        snapshot.broken.push({ path, error: err.message })
      }
      continue
    }

    snapshot.docs.push({ path, kind: isDaily(text) ? 'daily' : 'note', updatedAt: await mtime() })
  }

  return snapshot
}
```

- [ ] **Step 4: Fix `active-vault.ts` empty-snapshot literal**

Grep for `broken: []` in `apps/desktop/src/main/vault/active-vault.ts`; add `files: []` to any `{ docs: [], tasks: [], broken: [] }` literal there.

- [ ] **Step 5: Run tests + typecheck**

Run: `cd apps/desktop && pnpm exec vitest run test/vault-store.test.ts` → PASS.
Run typecheck; resolve any remaining `files`-missing errors in main.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/vault/vault-store.ts apps/desktop/test/vault-store.test.ts apps/desktop/src/main/vault/active-vault.ts
git commit -m "feat(vault): scanVault lists non-markdown files in snapshot.files

Claude goes brr.. via Dash"
```

---

## Task 3: Renderer snapshot literals + tree projection & icons

**Files:**
- Modify: `apps/desktop/src/renderer/src/state/vaults.ts` (EMPTY_SNAPSHOT)
- Modify: `apps/desktop/test/rename-state.test.ts`, `apps/desktop/test/batch-ops-state.test.ts` (emptySnapshot helpers)
- Modify: `apps/desktop/src/renderer/src/components/tree/icons.tsx`
- Modify: `apps/desktop/src/renderer/src/components/FileTree.tsx`

- [ ] **Step 1: Add `files: []` to every renderer/test snapshot literal**

In `apps/desktop/src/renderer/src/state/vaults.ts`:

```ts
const EMPTY_SNAPSHOT: VaultSnapshot = { docs: [], tasks: [], broken: [], files: [] }
```

In `apps/desktop/test/rename-state.test.ts` and `apps/desktop/test/batch-ops-state.test.ts`, update each `emptySnapshot`:

```ts
const emptySnapshot = (): VaultSnapshot => ({ docs: [], tasks: [], broken: [], files: [] })
```

(Grep the whole `apps/desktop` tree for `broken: [] }` and `broken: []\n` to catch any other literal — `Panel.tsx` had one; add `files: []` there too if present.)

- [ ] **Step 2: Add file icons**

Append to `apps/desktop/src/renderer/src/components/tree/icons.tsx`:

```tsx
export function FileIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M4 1.5h5L13 5.5v8A1.5 1.5 0 0 1 11.5 15h-7A1.5 1.5 0 0 1 3 13.5v-10A1.5 1.5 0 0 1 4 1.5zm5 1v3h3l-3-3z" />
    </svg>
  )
}

export function ImageIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M2.5 3h11A1.5 1.5 0 0 1 15 4.5v7A1.5 1.5 0 0 1 13.5 13h-11A1.5 1.5 0 0 1 1 11.5v-7A1.5 1.5 0 0 1 2.5 3zm2 2a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm-2 6h11l-3.5-4-2.5 3-1.5-1.5L2.5 11z" />
    </svg>
  )
}

export function PdfIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M4 1.5h5L13 5.5v8A1.5 1.5 0 0 1 11.5 15h-7A1.5 1.5 0 0 1 3 13.5v-10A1.5 1.5 0 0 1 4 1.5zm1 8v3h1.2v-1h.6a1 1 0 0 0 0-2H5zm1.2 1H6.8a.3.3 0 0 1 0 .6H6.2v-.6zM9 9.5v3h1a1.5 1.5 0 0 0 0-3H9zm1.2 1h-.2v1H10a.5.5 0 0 0 0-1z" />
    </svg>
  )
}

export function DocIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M4 1.5h5L13 5.5v8A1.5 1.5 0 0 1 11.5 15h-7A1.5 1.5 0 0 1 3 13.5v-10A1.5 1.5 0 0 1 4 1.5zM5 8h6v1H5V8zm0 2h6v1H5v-1zm0-4h3v1H5V6z" />
    </svg>
  )
}
```

- [ ] **Step 3: Feed `files` into the tree and pick icons by kind**

In `FileTree.tsx`:

Import the classifier and icons:

```tsx
import { fileKind } from '@holi/shared'
import { ChevronIcon, DocIcon, FileIcon, FolderIcon, ImageIcon, MarkdownIcon, PdfIcon } from './tree/icons'
```

Change `docPaths` to include files:

```tsx
const docPaths = useMemo(
  () => [...snapshot.docs.map((d) => d.path), ...snapshot.files.map((f) => f.path)],
  [snapshot],
)
```

(The `useEffect` that prunes pending folders already keys off `docPaths`; leaving it keyed off the combined list is correct — a pending folder becomes real when *any* file lands inside it.)

Add a leaf-icon helper near `absPathFor`:

```tsx
const leafIcon = (path: string) => {
  switch (fileKind(path)) {
    case 'markdown':
      return <MarkdownIcon />
    case 'image':
      return <ImageIcon />
    case 'pdf':
      return <PdfIcon />
    case 'doc':
      return <DocIcon />
    default:
      return <FileIcon />
  }
}
```

In the row's icon span, replace `{isFolder ? <FolderIcon /> : <MarkdownIcon />}` with:

```tsx
{isFolder ? <FolderIcon /> : leafIcon(id)}
```

- [ ] **Step 4: Typecheck + tests**

Run typecheck (expect `36`), then `pnpm exec vitest run` (all green — the snapshot literals now satisfy the type).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/state/vaults.ts apps/desktop/test/rename-state.test.ts apps/desktop/test/batch-ops-state.test.ts apps/desktop/src/renderer/src/components/tree/icons.tsx apps/desktop/src/renderer/src/components/FileTree.tsx apps/desktop/src/renderer/src/panel/Panel.tsx
git commit -m "feat(tree): show non-markdown files with type icons

Claude goes brr.. via Dash"
```

---

## Task 4: New File creates literal-extension files

**Files:**
- Modify: `apps/desktop/src/renderer/src/lib/tree-paths.ts`, `apps/desktop/test/tree-paths.test.ts`
- Modify: `apps/desktop/src/renderer/src/state/vaults.ts` (`createNoteAtom`)
- Modify: `apps/desktop/src/renderer/src/components/FileTree.tsx` (open the created file)

- [ ] **Step 1: Revert `withMdExtension` to "append only when no extension"**

Now that a foreign extension is a first-class file, coercion is wrong. Update the test in `apps/desktop/test/tree-paths.test.ts`:

```ts
it('appends .md only when NO extension is present — a typed extension is kept literally', () => {
  expect(withMdExtension('note')).toBe('note.md')
  expect(withMdExtension('note.md')).toBe('note.md')
  expect(withMdExtension('hello.json')).toBe('hello.json') // a real .json file now
  expect(withMdExtension('data.csv')).toBe('data.csv')
})
```

And the helper in `tree-paths.ts`:

```ts
/** A New File / rename name, defaulted to markdown. The vault is mostly markdown,
 *  so a bare name becomes a note; but a typed extension is kept literally — the
 *  vault holds arbitrary files now (spec §Arbitrary files). */
export const withMdExtension = (name: string): string =>
  /\.[^./]+$/.test(name) ? name : `${name}.md`
```

- [ ] **Step 2: `createNoteAtom` — scaffold only for markdown, and open any created file**

In `apps/desktop/src/renderer/src/state/vaults.ts`, update `createNoteAtom`:

```ts
export const createNoteAtom = atom(null, async (get, set, path: string) => {
  const remote = get(activeRemoteAtom)
  if (!remote) return
  // Markdown gets starter frontmatter; any other file is created empty (a .json
  // note-scaffold would be nonsense and unparseable).
  const isoDate = new Date().toLocaleDateString('en-CA')
  const text = path.endsWith('.md') ? scaffoldNoteText(isoDate) : ''
  await trpc.notes.create.mutate({ remote, path, text })
  await set(loadSnapshotAtom)
  set(activeDocAtom, get(snapshotAtom).docs.find((d) => d.path === path) ?? null)
})
```

- [ ] **Step 3: Open the created file in the editor**

In `FileTree.tsx`, the New File commit currently only creates. Open it too so a fresh file lands in the editor (a `.json` won't be in `docs`, so relying on `activeDocAtom` is not enough — open a tab explicitly). Change the `onCommit` file branch:

```tsx
} else {
  const path = joinPath(pending.parent, withMdExtension(name))
  void createNote(path).then(() => onOpenPreview(path))
}
```

- [ ] **Step 4: Typecheck + tests**

Run `pnpm exec vitest run test/tree-paths.test.ts` → PASS. Typecheck → `36`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/tree-paths.ts apps/desktop/test/tree-paths.test.ts apps/desktop/src/renderer/src/state/vaults.ts apps/desktop/src/renderer/src/components/FileTree.tsx
git commit -m "feat(tree): New File keeps a typed extension; non-md files created empty

Claude goes brr.. via Dash"
```

---

## Task 5: Editor dispatch — plain-text mode + typed placeholder

**Files:**
- Modify: `apps/desktop/src/renderer/src/editor/extensions.ts`
- Modify: `apps/desktop/src/renderer/src/components/EditorPane.tsx`
- Create: `apps/desktop/src/renderer/src/components/FilePlaceholder.tsx`
- Modify: `apps/desktop/src/renderer/src/components/Shell.tsx`

- [ ] **Step 1: A plain-text extension set**

Inspect `apps/desktop/src/renderer/src/editor/extensions.ts` for `baseEditorExtensions`. Add a sibling that keeps the theme/keymap/history but drops the markdown layers (frontmatter widget, wiki-link chips, `@` mentions):

```ts
/** CodeMirror extensions for a plain (non-markdown) text file: the shared theme
 *  and editing keymap, but none of the note-specific layers (frontmatter widget,
 *  wiki-link chips, mentions) — a `.json` or `.csv` is just text. */
export function plainTextExtensions() {
  return [
    // Reuse whatever baseEditorExtensions uses for theme/history/keymap/lineWrap
    // WITHOUT the markdown decorations. Assemble from the same primitives that
    // file already imports (e.g. history(), keymap.of([...defaultKeymap, ...historyKeymap]),
    // EditorView.lineWrapping, and the shared theme). Keep it minimal.
  ]
}
```

Implement it concretely from the primitives `extensions.ts` already imports — the markdown-specific decorations are the only thing to leave out. (Read the file first; do not invent imports.)

- [ ] **Step 2: `EditorPane` gains a `plain` mode**

In `EditorPane.tsx`, add an optional prop and branch the three markdown-specific spots; the save/flush/reload machinery is shared and unchanged.

Prop:

```tsx
export function EditorPane({
  path,
  onOpenNote,
  onConflict,
  onEdit,
  plain = false,
}: {
  path: string | null
  onOpenNote: (path: string) => void
  onConflict: (path: string) => void
  onEdit?: () => void
  plain?: boolean
}) {
```

Branch the extensions when building the `EditorState`:

```tsx
extensions: [
  ...(plain
    ? plainTextExtensions()
    : baseEditorExtensions({
        docExists: (p) => docPaths.current.has(p),
        taskInfo: () => ({ label: 'task', missing: true }),
        mentionData: () => mentionRef.current,
        onTaskMention: () => {},
        nav: () => navRef.current,
      })),
  EditorView.updateListener.of((update) => { /* unchanged */ }),
],
```

Caret — a plain file has no frontmatter, so open at 0:

```tsx
selection: EditorSelection.cursor(plain ? 0 : bodyStart(text), 1),
```

Save-gate — the `frontmatterValid` hold-off is markdown-only; a plain file always saves:

```tsx
const save = async (): Promise<boolean> => {
  const view = viewRef.current
  if (view === null || disposed) return false
  if (!plain && !frontmatterValid(view.state)) return false
  const text = view.state.doc.toString()
  if (text !== baseRef.current) {
    baseRef.current = text
    await trpc.notes.write.mutate({ remote, path, text })
  }
  return true
}
```

Add `plain` to the effect dependency array (`[path, remote, plain]`) so switching kinds rebuilds the view.

- [ ] **Step 3: The typed placeholder**

Create `apps/desktop/src/renderer/src/components/FilePlaceholder.tsx`:

```tsx
/**
 * The in-app stand-in for a file we can't yet render (image, PDF, office doc).
 * A real renderer replaces this per kind later (spec §Arbitrary files); it is
 * deliberately NOT a "reveal in Finder" shortcut — the file stays in-app.
 */
import type { FileKind } from '@holi/shared'
import { DocIcon, ImageIcon, PdfIcon } from './tree/icons'

const COPY: Record<Exclude<FileKind, 'markdown' | 'text'>, { label: string; icon: () => JSX.Element }> = {
  image: { label: 'Image', icon: ImageIcon },
  pdf: { label: 'PDF', icon: PdfIcon },
  doc: { label: 'Document', icon: DocIcon },
}

export function FilePlaceholder({ path, kind }: { path: string; kind: Exclude<FileKind, 'markdown' | 'text'> }) {
  const { label, icon: Icon } = COPY[kind]
  const name = path.slice(path.lastIndexOf('/') + 1)
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-neutral-500">
      <div className="text-neutral-600">
        <Icon />
      </div>
      <p className="font-mono text-sm text-neutral-300">{name}</p>
      <p className="text-xs">{label} preview isn’t available yet — it lives in the vault and syncs.</p>
    </div>
  )
}
```

- [ ] **Step 4: Dispatch the note tab in `Shell.tsx`**

Import `fileKind` and the two components, and replace the `EditorPane` render for a note tab with a kind switch:

```tsx
import { fileKind } from '@holi/shared'
import { FilePlaceholder } from './FilePlaceholder'
// ...
{tab?.kind === 'board' ? (
  <BoardView />
) : tab?.kind === 'note' ? (
  (() => {
    const kind = fileKind(tab.path)
    if (kind === 'image' || kind === 'pdf' || kind === 'doc') {
      return <FilePlaceholder path={tab.path} kind={kind} />
    }
    return (
      <EditorPane
        path={tab.path}
        plain={kind === 'text'}
        onOpenNote={open}
        onEdit={() => setWorkspace((w) => pinActive(w))}
        onConflict={(path) =>
          setBanner(`${path} changed underneath your edit and could not be merged`)
        }
      />
    )
  })()
) : (
  <EditorPane
    path={null}
    onOpenNote={open}
    onEdit={() => setWorkspace((w) => pinActive(w))}
    onConflict={() => {}}
  />
)}
```

(Keep the empty-state `EditorPane path={null}` so "select or create a note" still shows when no tab is open. Match the existing prop wiring exactly; only the dispatch is new.)

- [ ] **Step 5: Typecheck + full suite + build**

Run: `pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"` → `36`.
Run: `pnpm exec vitest run` → all green.
Run: `pnpm exec electron-vite build 2>&1 | tail -3` → succeeds.

- [ ] **Step 6: Live verify (ask the user to relaunch — scanner is a main edit)**

After a relaunch: a `.json` created via New File opens in a plain editor and autosaves; an existing `.png`/`.pdf` in the vault shows the placeholder; markdown notes are unchanged (frontmatter widget, wiki-links, `@`); the tree shows type icons.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/editor/extensions.ts apps/desktop/src/renderer/src/components/EditorPane.tsx apps/desktop/src/renderer/src/components/FilePlaceholder.tsx apps/desktop/src/renderer/src/components/Shell.tsx
git commit -m "feat(editor): plain-text mode for non-md files + typed placeholder for rich files

Claude goes brr.. via Dash"
```

---

## Self-review notes

- **Decision coverage:** arbitrary files held + shown ✓ (T1 type, T2 scanner, T3 tree); text editable in-app ✓ (T5 plain mode); images/PDF/docs → placeholder, no Reveal-in-Finder ✓ (T5 FilePlaceholder); "mostly markdown" default ✓ (T4 bare name → `.md`, typed extension literal); markdown editor untouched ✓ (T5 branches only the 3 md-specific spots).
- **Correctness guards:** `docs` stays markdown-only, so backrefs / rename link-rewrite / mentions never see a non-note file (T2 keeps non-md out of `docs`). Move/copy/delete already path-based — a non-md file rides them unchanged, and its rename triggers an empty backref scan (nothing wiki-links to it), so it is a plain move.
- **Blast radius (the `files` required field):** every `VaultSnapshot` literal updated — `scanVault`, `EMPTY_SNAPSHOT`, `active-vault.ts`, and the `emptySnapshot` test helpers (T1 flags it; T2/T3 fix each). The typecheck gate catches any missed one.
- **Type consistency:** `FileKind = 'markdown' | 'text' | 'image' | 'pdf' | 'doc'` used identically in `fileKind`, the tree icon switch, the Shell dispatch, and `FilePlaceholder` (which narrows to the three placeholder kinds).
- **Deferred (noted, not built):** real renderers for image/pdf/doc; content-sniffing (extension-based classification is the v1 — an unknown binary opened as text shows garbage but only corrupts if edited-and-saved, an acceptable v1 edge); `.gitignore`/dotfiles now appear in the tree (VS Code-like) — raise with the user if they want them hidden.
- **Placeholder scan:** the only non-literal step is T5 Step 1 (`plainTextExtensions` assembled from `extensions.ts`'s own primitives) — it is explicitly "read the file first, reuse its imports," because the concrete extension list depends on what that module already pulls in.
