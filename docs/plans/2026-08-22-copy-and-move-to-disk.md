# Copy/Move to Disk Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two row-menu actions — **Copy to Folder…** and **Move to Folder…** — that write a vault file or folder anywhere on disk, with a move removing it from the vault only after the copy has actually landed.

**Architecture:** A new `main/vault/export-files.ts` mirrors `import-files.ts` in reverse: same `{ landed, failed }` result shape, same `reasonFor` errno prose, auto-renaming on collision with the same `freeCopyPath` that Duplicate uses (moved to `@holi/shared` so main can reach it). The destination comes from a native folder chooser over IPC, exactly as Convert-to-PDF's save dialog already does. The move reuses the existing backrefs confirmation, extended with a verb, and deletes only the targets whose copy succeeded.

**Tech Stack:** Electron `dialog.showOpenDialog`, node `fs.cp`, tRPC, jotai, headless-tree, Vitest (node + dom projects).

**Why this exists:** dragging a row out to Finder does not work (`webContents.startDrag` starts a drag the window accepts but Finder rejects). That was FR-13's promised way out of the vault; these two actions replace it, and Task 8 corrects the docs that still claim otherwise.

---

## Context an engineer needs before starting

**Run everything from `apps/desktop`** — `--project` resolves only from there, and the cwd drifts between tool calls, so use absolute paths or `cd` first. Bare `node`/`npx` are broken in this repo: always `pnpm exec`.

| gate | command | baseline |
|---|---|---|
| node tests | `pnpm exec vitest run --project node` | 1633 pass, ~3 min |
| dom tests | `pnpm exec vitest run --project dom` | 505 pass |
| shared tests | (from root) `pnpm --filter @holi/shared exec vitest run` | 299 pass |
| types | (from root) `pnpm typecheck` | clean |
| lint | `pnpm exec eslint src` | 0 errors, exactly 2 known warnings (`EditorPane.tsx:236`, `TaskDetail.tsx:404`) |

**Do not run the node suite in parallel with anything else.** `vitest.config.ts` says why: it is event-bound (chokidar/fsevents), and parallel load produced ~1-in-3 spurious failures. A third eslint warning is yours.

**Gotchas that have already bitten in this area:**
- `git add docs` sweeps in `docs/upcoming.md`. Stage specific paths, always.
- lint-staged runs eslint on commit and the component-hierarchy gate is an **error**: a native `<button>` outside `primitives/` fails the commit. Compose `Button`.
- Pure renderer logic is tested from `apps/desktop/test/*.test.ts` (the **node** project), *not* co-located. Only `src/renderer/**/*.test.tsx` runs in `dom`. Grep both trees before assuming a test is absent.
- `noUncheckedIndexedAccess` is on. `arr[0]` is `T | undefined`.
- Mutation-check every test written after its implementation — delete the line it covers and watch it fail. It has caught two bad tests in this area already.

---

## File structure

| File | Responsibility |
|---|---|
| `packages/shared/src/copy-names.ts` | **Create.** `freeCopyPath` — the " copy"/" copy N" naming rule, moved out of the renderer so main can use it. |
| `packages/shared/src/index.ts` | **Modify.** Re-export the new module. |
| `apps/desktop/src/renderer/src/lib/tree-paths.ts` | **Modify.** Drop the local `freeCopyPath`, re-export the shared one so `tree-actions.ts` is untouched. |
| `apps/desktop/src/main/vault/export-files.ts` | **Create.** Copy vault paths to a directory outside the vault. |
| `apps/desktop/src/main/router.ts` | **Modify.** `notes.exportFiles` route. |
| `apps/desktop/src/main/ipc.ts` | **Modify.** `holi:chooseFolder`. |
| `apps/desktop/src/preload/index.ts` | **Modify.** `chooseFolder()`. |
| `apps/desktop/src/renderer/src/global.d.ts` | **Modify.** Type it on `window.holi`. |
| `apps/desktop/src/renderer/src/state/vaults.ts` | **Modify.** `exportFilesAtom`. |
| `apps/desktop/src/renderer/src/composites/DeleteConfirm.tsx` | **Modify.** A `verb` prop. |
| `apps/desktop/src/renderer/src/features/explorer/useExplorerActions.ts` | **Modify.** `copyOut`, `startMoveOut`, and a `confirmDelete` that understands a move. |
| `apps/desktop/src/renderer/src/features/explorer/FileTree.tsx` | **Modify.** Two menu items; pass the verb through. |
| `docs/prd/notes-editor.md`, `docs/not-built.md` | **Modify.** Correct FR-13; record the broken drag-out. |

---

## Task 1: Move `freeCopyPath` into `@holi/shared`

Pure refactor — no behaviour change. Main cannot import from the renderer tree, and the export must pick the same " copy" names Duplicate does.

**Files:**
- Create: `packages/shared/src/copy-names.ts`
- Create: `packages/shared/test/copy-names.test.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/desktop/src/renderer/src/lib/tree-paths.ts:45-63`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/test/copy-names.test.ts`:

```ts
/**
 * The " copy" naming rule, shared by Duplicate (inside the vault) and the
 * export (outside it). It lives here rather than in the renderer because main
 * needs it too, and the two must agree: a file duplicated in the tree and the
 * same file exported to a folder that already has one should land on the same
 * name.
 */
import { describe, expect, it } from 'vitest'
import { freeCopyPath } from '../src/copy-names'

describe('freeCopyPath', () => {
  it('returns the path untouched when nothing is in the way', () => {
    expect(freeCopyPath(() => false, 'notes/a.md')).toBe('notes/a.md')
  })

  it('suffixes before the extension, so the file keeps its type', () => {
    const taken = (p: string) => p === 'notes/a.md'
    expect(freeCopyPath(taken, 'notes/a.md')).toBe('notes/a copy.md')
  })

  it('counts up when the copy is taken too', () => {
    const taken = (p: string) => ['notes/a.md', 'notes/a copy.md'].includes(p)
    expect(freeCopyPath(taken, 'notes/a.md')).toBe('notes/a copy 2.md')
  })

  it('suffixes a folder on the bare name — a folder has no extension', () => {
    const taken = (p: string) => p === 'archive'
    expect(freeCopyPath(taken, 'archive')).toBe('archive copy')
  })

  it('treats a dotfile as a name, not an extension', () => {
    // `.gitignore` is entirely a name: the dot is at index 0, and `dot > 0`
    // is what keeps it from becoming ' copy.gitignore'.
    const taken = (p: string) => p === '.gitignore'
    expect(freeCopyPath(taken, '.gitignore')).toBe('.gitignore copy')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run from the repo root:
```bash
pnpm --filter @holi/shared exec vitest run test/copy-names.test.ts
```
Expected: FAIL — `Cannot find module '../src/copy-names'`.

- [ ] **Step 3: Create the shared module**

Create `packages/shared/src/copy-names.ts`. This is the body currently in `tree-paths.ts`, with its path helpers inlined so the module stands alone (paths here are always '/'-separated — vault-relative in the renderer, and POSIX absolute in main, which is macOS-only):

```ts
/**
 * The " copy" / " copy 2" naming rule (VS Code's Duplicate).
 *
 * Shared because it is applied in two places that must agree: duplicating
 * inside the vault, and exporting to a folder on disk that already holds a file
 * of that name. Collision is asked of `taken` rather than of a filesystem, so
 * the same rule serves an in-memory path list and a real directory.
 *
 * Paths are '/'-separated: vault-relative in the renderer, POSIX absolute in
 * main. Holi is macOS-only, and `vaultRelPath` already refuses backslashes.
 */
export const freeCopyPath = (taken: (p: string) => boolean, path: string): string => {
  if (!taken(path)) return path
  const slash = path.lastIndexOf('/')
  const base = path.slice(slash + 1)
  const dir = slash === -1 ? '' : path.slice(0, slash)
  const dot = base.lastIndexOf('.')
  // `dot > 0`, not `dot >= 0`: a leading dot is a dotfile's name, not an
  // extension, so `.gitignore` must not become ' copy.gitignore'.
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  for (let n = 1; n < 1000; n++) {
    const name = `${stem}${n === 1 ? ' copy' : ` copy ${n}`}${ext}`
    const candidate = dir ? `${dir}/${name}` : name
    if (!taken(candidate)) return candidate
  }
  return path
}
```

- [ ] **Step 4: Export it from the package**

In `packages/shared/src/index.ts`, add after the `./path-safety` line:

```ts
export * from './copy-names'
```

- [ ] **Step 5: Run the shared tests**

```bash
pnpm --filter @holi/shared exec vitest run
```
Expected: PASS — 299 + 5 = **304**.

- [ ] **Step 6: Point the renderer at the shared copy**

In `apps/desktop/src/renderer/src/lib/tree-paths.ts`, delete the whole `freeCopyPath` block (its doc comment and body, currently lines 45-63) and add this re-export at the end of the file, so `tree-actions.ts` keeps importing it from where it always did:

```ts
/** Re-exported so the tree's own imports stay local. The rule itself is shared
 *  with main, which applies it to a directory on disk (`export-files.ts`). */
export { freeCopyPath } from '@holi/shared'
```

- [ ] **Step 7: Verify nothing else moved**

```bash
cd apps/desktop && pnpm exec vitest run --project node && cd .. && cd .. && pnpm typecheck
```
Expected: node **1633** pass, typecheck clean. `tree-actions.ts` is untouched and its existing tests still cover Duplicate/Paste.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/copy-names.ts packages/shared/src/index.ts \
        packages/shared/test/copy-names.test.ts \
        apps/desktop/src/renderer/src/lib/tree-paths.ts
git commit -m "refactor(shared): the copy-naming rule moves where both sides can reach it"
```

---

## Task 2: `export-files.ts` — copy vault paths to a directory

**Files:**
- Create: `apps/desktop/src/main/vault/export-files.ts`
- Create: `apps/desktop/test/export-files.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/test/export-files.test.ts`:

```ts
/**
 * Writing vault content OUT to a folder on disk — the replacement for the drag
 * to Finder that macOS refuses (`prd/notes-editor.md` FR-13).
 *
 * The mirror of `import-files.ts`, and it differs in exactly one decided way:
 * a name already in use is auto-renamed rather than refused. Importing protects
 * the vault, so it refuses; exporting writes to the user's own disk, where
 * getting a second copy is the useful answer and losing the first is not.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { exportFiles } from '../src/main/vault/export-files'

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})
async function scratch(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

describe('exportFiles', () => {
  it('copies a file out and leaves the vault untouched', async () => {
    const root = await scratch('holi-vault-')
    const dest = await scratch('holi-dest-')
    await writeFile(join(root, 'note.md'), '# Mine\n', 'utf8')

    const result = await exportFiles(root, ['note.md'], dest)

    expect(result.landed).toEqual([{ from: 'note.md', to: join(dest, 'note.md') }])
    expect(result.failed).toEqual([])
    expect(await readFile(join(dest, 'note.md'), 'utf8')).toBe('# Mine\n')
    expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('# Mine\n')
  })

  it('copies a folder with everything under it', async () => {
    // A folder target keeps its shape. `import-files` refuses folders because
    // recursing INTO the vault needs a decision about what a folder of unknown
    // files means; going out, a folder is just a folder.
    const root = await scratch('holi-vault-')
    const dest = await scratch('holi-dest-')
    await mkdir(join(root, 'trip/day1'), { recursive: true })
    await writeFile(join(root, 'trip/day1/a.md'), 'a\n', 'utf8')

    const result = await exportFiles(root, ['trip'], dest)

    expect(result.failed).toEqual([])
    expect(await readFile(join(dest, 'trip/day1/a.md'), 'utf8')).toBe('a\n')
  })

  it('auto-renames rather than overwriting what is already there', async () => {
    // The one place Holi could destroy something git cannot recover, because
    // the destination is outside the vault.
    const root = await scratch('holi-vault-')
    const dest = await scratch('holi-dest-')
    await writeFile(join(root, 'note.md'), 'vault\n', 'utf8')
    await writeFile(join(dest, 'note.md'), 'theirs\n', 'utf8')

    const result = await exportFiles(root, ['note.md'], dest)

    expect(result.landed).toEqual([{ from: 'note.md', to: join(dest, 'note copy.md') }])
    expect(await readFile(join(dest, 'note.md'), 'utf8')).toBe('theirs\n')
    expect(await readFile(join(dest, 'note copy.md'), 'utf8')).toBe('vault\n')
  })

  it('counts up when the copy is taken too', async () => {
    const root = await scratch('holi-vault-')
    const dest = await scratch('holi-dest-')
    await writeFile(join(root, 'note.md'), 'vault\n', 'utf8')
    await writeFile(join(dest, 'note.md'), 'one\n', 'utf8')
    await writeFile(join(dest, 'note copy.md'), 'two\n', 'utf8')

    const result = await exportFiles(root, ['note.md'], dest)

    expect(result.landed[0]?.to).toBe(join(dest, 'note copy 2.md'))
  })

  it('exports what it can and reports the rest', async () => {
    // One unreadable source must not cost the others — the same rule the import
    // follows, for the same reason.
    const root = await scratch('holi-vault-')
    const dest = await scratch('holi-dest-')
    await writeFile(join(root, 'good.md'), 'ok\n', 'utf8')

    const result = await exportFiles(root, ['ghost.md', 'good.md'], dest)

    expect(result.landed.map((l) => l.from)).toEqual(['good.md'])
    expect(result.failed).toEqual([{ name: 'ghost.md', reason: 'could not be copied (ENOENT)' }])
  })

  it('refuses a path that climbs out of the vault', async () => {
    // `safe()` guards the router, but this function is also the thing a future
    // caller reaches for, and a traversal here would read any file on disk.
    const root = await scratch('holi-vault-')
    const dest = await scratch('holi-dest-')

    await expect(exportFiles(root, ['../../etc/hosts'], dest)).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/desktop && pnpm exec vitest run --project node test/export-files.test.ts
```
Expected: FAIL — `Cannot find module '../src/main/vault/export-files'`.

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/src/main/vault/export-files.ts`:

```ts
/**
 * Vault content, written out to a folder on disk (`prd/notes-editor.md` FR-13).
 *
 * The mirror of `import-files.ts`, and the two differ in exactly one decided
 * way. Importing refuses a colliding name (`COPYFILE_EXCL`) because the vault's
 * standing rule is refuse-rather-than-overwrite. Exporting **auto-renames**,
 * using the same " copy" rule as Duplicate: the destination is the user's own
 * disk, a second copy is the useful outcome, and silently replacing a file
 * there is the one thing in this app git could not undo.
 *
 * Folders are copied whole. `import-files` refuses them because recursing INTO
 * the vault raises a question about what a folder of unknown files becomes;
 * going out, a folder is just a folder.
 */
import { cp, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { freeCopyPath, vaultRelPath } from '@holi/shared'
import { absPathFor } from './vault-files'
import { reasonFor } from './import-files'

export interface ExportResult {
  /** What actually landed: the vault-relative source, and where it went. The
   *  caller needs this separately from `failed` because a MOVE deletes only
   *  what is in here. */
  landed: { from: string; to: string }[]
  failed: { name: string; reason: string }[]
}

/** True when something already occupies `abs`. */
async function exists(abs: string): Promise<boolean> {
  try {
    await stat(abs)
    return true
  } catch {
    return false
  }
}

/**
 * The free name for `name` inside `destDir`.
 *
 * `freeCopyPath` asks a SYNCHRONOUS predicate and existence on disk is async,
 * so this walks the candidate sequence the rule generates, probing each one and
 * feeding what it found back in as the `taken` set. The rule stays the single
 * authority on what " copy 2" means — a second implementation of that naming
 * here would be one too many, and would drift from Duplicate.
 */
async function freeNameIn(destDir: string, name: string): Promise<string> {
  const taken = new Set<string>()
  let candidate = join(destDir, name)
  for (let guard = 0; guard < 1000; guard++) {
    if (!(await exists(candidate))) return candidate
    taken.add(candidate)
    candidate = freeCopyPath((p) => taken.has(p), join(destDir, name))
  }
  return candidate
}

/**
 * Copy each of `targets` (vault-relative files or folders) into `destDir`.
 *
 * `destDir` is absolute and outside the vault — it comes from a native folder
 * chooser, so it is the user's own choice rather than anything derived here.
 * The SOURCES are validated: `vaultRelPath` throws on a path that climbs out,
 * which is what stops a caller reading arbitrary disk.
 */
export async function exportFiles(
  root: string,
  targets: string[],
  destDir: string,
): Promise<ExportResult> {
  const landed: { from: string; to: string }[] = []
  const failed: { name: string; reason: string }[] = []

  for (const target of targets) {
    // Throws on a path that climbs out of the vault, and deliberately NOT
    // caught: that is a programming error, not a per-file failure to report.
    const source = absPathFor(root, vaultRelPath(target))
    const name = basename(target)
    try {
      // Resolved per target inside the loop, so exporting two files of the same
      // name in one go lands both — the second sees what the first just wrote.
      const to = await freeNameIn(destDir, name)
      // `recursive` so a folder target keeps its shape. No `force`/`errorOnExist`:
      // `freeNameIn` has already established that `to` is unoccupied.
      await cp(source, to, { recursive: true })
      landed.push({ from: target, to })
    } catch (err) {
      failed.push({ name, reason: reasonFor((err as NodeJS.ErrnoException).code) })
    }
  }
  return { landed, failed }
}
```

- [ ] **Step 4: Export `reasonFor` if it is not already exported**

`reasonFor` is already `export function reasonFor` in `apps/desktop/src/main/vault/import-files.ts`. Confirm with:

```bash
grep -n "export function reasonFor" apps/desktop/src/main/vault/import-files.ts
```
Expected: one match. If it is missing, add `export` to it.

- [ ] **Step 5: Run the tests**

```bash
cd apps/desktop && pnpm exec vitest run --project node test/export-files.test.ts
```
Expected: PASS — 6 tests.

- [ ] **Step 6: Mutation-check the auto-rename**

Temporarily change `freeNameIn` to `return join(destDir, name)`. Re-run.
Expected: the two rename tests FAIL. Restore the function.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/vault/export-files.ts apps/desktop/test/export-files.test.ts
git commit -m "feat(vault): vault content copies out to a folder, renaming rather than overwriting"
```

---

## Task 3: The `notes.exportFiles` route

**Files:**
- Modify: `apps/desktop/src/main/router.ts` (beside `importFiles`, ~line 1254)

- [ ] **Step 1: Add the route**

In `apps/desktop/src/main/router.ts`, add immediately after the `importFiles` procedure:

```ts
    /**
     * Vault content out to a folder on disk (FR-13). `dest` is absolute and
     * deliberately unvalidated: it comes from the native folder chooser, so it
     * is the user's own choice, and second-guessing it here would only refuse
     * places they can already write from Finder. The SOURCES are validated —
     * `safe()` is what stops a path climbing out of the vault.
     */
    exportFiles: vaultMutation
      .input((raw: unknown) => ({
        ...fields({ remote: 'string', dest: 'string' })(raw),
        paths: stringsOrThrow((raw as { paths?: unknown }).paths),
      }))
      .mutation(async ({ input }) => {
        const root = await rootFor(input.remote)
        return exportFiles(root, input.paths.map(safe), input.dest)
      }),
```

- [ ] **Step 2: Add the import**

At the top of `router.ts`, beside `import { importFiles } from './vault/import-files'`:

```ts
import { exportFiles } from './vault/export-files'
```

- [ ] **Step 3: Typecheck**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final && pnpm typecheck
```
Expected: clean. If `safe` is not in scope at that point in the file, check how the `deleteMany` route reaches it and match that.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/router.ts
git commit -m "feat(router): notes.exportFiles"
```

---

## Task 4: The folder chooser

**Files:**
- Modify: `apps/desktop/src/main/ipc.ts` (after the `holi:showSaveDialog` handler)
- Modify: `apps/desktop/src/preload/index.ts` (beside `showSaveDialog`, ~line 98)
- Modify: `apps/desktop/src/renderer/src/global.d.ts` (beside line 59)

- [ ] **Step 1: Add the main handler**

In `apps/desktop/src/main/ipc.ts`, after the `holi:showSaveDialog` handler:

```ts
  /**
   * Pick a folder on disk — where Copy to Folder… / Move to Folder… land
   * (FR-13). A folder rather than a save sheet because the same action serves a
   * multi-selection and a folder target, where there is no single name to type.
   * `createDirectory` so the destination can be made in the sheet; tied to the
   * calling window so it is a sheet rather than a floating dialog.
   */
  ipcMain.handle('holi:chooseFolder', async (event): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const opts = { properties: ['openDirectory' as const, 'createDirectory' as const] }
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    // `filePaths[0]` is `string | undefined` under noUncheckedIndexedAccess.
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
```

- [ ] **Step 2: Add the preload binding**

In `apps/desktop/src/preload/index.ts`, beside `showSaveDialog`:

```ts
  chooseFolder: (): Promise<string | null> => ipcRenderer.invoke('holi:chooseFolder'),
```

- [ ] **Step 3: Type it**

In `apps/desktop/src/renderer/src/global.d.ts`, beside the `showSaveDialog` line:

```ts
      chooseFolder(): Promise<string | null>
```

- [ ] **Step 4: Typecheck and run the FULL desktop suites**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final && pnpm typecheck
cd apps/desktop && pnpm exec vitest run --project dom
```
Expected: typecheck clean, dom **505**.

A preload/`window.holi` change is exactly the case where typecheck is not enough: the fake `window.holi` used by tests is not typed against the real surface, so a gap shows up only when a suite runs.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/ipc.ts apps/desktop/src/preload/index.ts \
        apps/desktop/src/renderer/src/global.d.ts
git commit -m "feat(main): a native folder chooser, for the actions that write outside the vault"
```

---

## Task 5: `DeleteConfirm` learns a verb

The move-out reuses this dialog for its backrefs warning, and a dialog that says "Delete" for a move is a dialog that lies.

**Files:**
- Modify: `apps/desktop/src/renderer/src/composites/DeleteConfirm.tsx:14-31`
- Modify: `apps/desktop/src/renderer/src/composites/__tests__/DeleteConfirm.test.tsx` (create if absent — check first)

- [ ] **Step 1: Check whether a test file exists**

```bash
ls apps/desktop/src/renderer/src/composites/__tests__/ | grep -i delete
```

- [ ] **Step 2: Write the failing test**

Append to the existing `DeleteConfirm` test file, or create `apps/desktop/src/renderer/src/composites/__tests__/DeleteConfirm.test.tsx` with the imports it needs:

```tsx
test('says what it is about to do, so a move does not read as a delete', () => {
  // Moving a file out of the vault removes it from the vault, so it earns the
  // same backrefs warning as a delete — but calling it "Delete" would describe
  // the wrong outcome to someone who asked for a move.
  render(
    <DeleteConfirm
      verb="Move"
      label="note.md"
      refs={[]}
      onCancel={() => {}}
      onConfirm={() => {}}
    />,
  )

  expect(screen.getByText(/Move/)).toBeInTheDocument()
  expect(screen.queryByText(/Delete/)).not.toBeInTheDocument()
})
```

- [ ] **Step 3: Run it and watch it fail**

```bash
cd apps/desktop && pnpm exec vitest run --project dom src/renderer/src/composites/__tests__/DeleteConfirm.test.tsx
```
Expected: FAIL — either a type error on `verb`, or the "Delete" text still present.

- [ ] **Step 4: Add the prop**

In `apps/desktop/src/renderer/src/composites/DeleteConfirm.tsx`, change the signature and the header. Keep the default so every existing call site is unchanged:

```tsx
export function DeleteConfirm({
  label,
  refs,
  onCancel,
  onConfirm,
  verb = 'Delete',
}: {
  label: string
  refs: { path: string; count: number }[]
  onCancel: () => void
  onConfirm: () => void
  /** What the confirm button is about to do. A move out of the vault removes it
   *  from the vault, so it reuses this dialog — but not its wording. */
  verb?: 'Delete' | 'Move'
}) {
```

and the header line:

```tsx
        <Dialog.Header>
          {verb} <span className="font-mono">{label}</span>?
        </Dialog.Header>
```

Then find the confirm button's label further down the same file and make it `{verb}` as well. Read the file before editing — the button text is a second literal `Delete`, and both have to change or the test's `queryByText(/Delete/)` will still match.

- [ ] **Step 5: Run the dom suite**

```bash
pnpm exec vitest run --project dom
```
Expected: **506** — the existing DeleteConfirm tests still pass on the default.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/composites/DeleteConfirm.tsx \
        apps/desktop/src/renderer/src/composites/__tests__/DeleteConfirm.test.tsx
git commit -m "feat(ui): the confirm dialog says which verb it is about to apply"
```

---

## Task 6: The export atom

**Files:**
- Modify: `apps/desktop/src/renderer/src/state/vaults.ts` (beside `importFilesAtom`, ~line 344)

- [ ] **Step 1: Add the atom**

In `apps/desktop/src/renderer/src/state/vaults.ts`, immediately after `importFilesAtom`:

```ts
/**
 * Vault content out to a folder on disk (FR-13).
 *
 * Returns what LANDED as well as what failed, and the difference is load-
 * bearing: a move deletes only the targets whose copy actually succeeded, so a
 * file that could not be written is still in the vault afterwards. No snapshot
 * reload — nothing in the vault changed.
 */
export const exportFilesAtom = atom(
  null,
  async (
    get,
    _set,
    paths: string[],
    dest: string,
  ): Promise<{ landed: { from: string; to: string }[]; failed: { name: string; reason: string }[] }> => {
    const remote = get(activeRemoteAtom)
    if (!remote || paths.length === 0) return { landed: [], failed: [] }
    return trpc.notes.exportFiles.mutate({ remote, paths, dest })
  },
)
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final && pnpm typecheck
```
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/state/vaults.ts
git commit -m "feat(state): exportFilesAtom"
```

---

## Task 7: The two actions

The rule with teeth lives here: **a target whose copy failed is not deleted.**

**Files:**
- Modify: `apps/desktop/src/renderer/src/features/explorer/useExplorerActions.ts`
- Create: `apps/desktop/src/renderer/src/features/explorer/__tests__/FileTree.export.test.tsx`
- Modify: `apps/desktop/src/renderer/src/features/explorer/FileTree.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/features/explorer/__tests__/FileTree.export.test.tsx`. Model the harness on `FileTree.drop.test.tsx` in the same directory — read it first; it already seeds the atoms and fakes `window.holi`.

```tsx
/**
 * Copy to Folder… / Move to Folder… (FR-13), the supported way out of the vault
 * now that the drag to Finder is known not to work.
 *
 * The assertion that matters is the last one: a move deletes only what actually
 * landed. Anything else loses the file — copied nowhere and deleted from the
 * one place that had it.
 */
import { getDefaultStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
// `fireEvent.contextMenu` is how this codebase opens a Radix ContextMenu in
// jsdom (see primitives/__tests__/ContextMenu.test.tsx). A right-click through
// `userEvent.pointer` does NOT open it.
import { fireEvent, render, screen, waitFor } from '@/test/render'
import { FileTree } from '../FileTree'
import { activeRemoteAtom, snapshotAtom, vaultsAtom } from '../../../state/vaults'

const exportMock = vi.fn((_input: unknown) =>
  Promise.resolve({ landed: [{ from: 'b.md', to: '/out/b.md' }], failed: [] }),
)
const deleteMock = vi.fn((_input: unknown) => Promise.resolve(undefined))
const backrefsMock = vi.fn((_input: unknown) => Promise.resolve([]))

vi.mock('../../../lib/trpc', () => ({
  trpc: {
    notes: {
      exportFiles: { mutate: (i: unknown) => exportMock(i) },
      deleteMany: { mutate: (i: unknown) => deleteMock(i) },
      backrefs: { query: (i: unknown) => backrefsMock(i) },
    },
    sync: { commitNow: { mutate: () => Promise.resolve(undefined) } },
    vaults: { snapshot: { query: () => Promise.resolve(EMPTY) } },
  },
}))

const REMOTE = 'syv-ai/holi'
const EMPTY = { docs: [], tasks: [], broken: [], files: [], dirs: [] }
const store = getDefaultStore()

function tree() {
  store.set(activeRemoteAtom, REMOTE)
  store.set(vaultsAtom, [{ remote: REMOTE, path: '/vault' } as never])
  store.set(snapshotAtom, {
    ...EMPTY,
    docs: [{ path: 'b.md', kind: 'note', updatedAt: '' }],
  })
  return render(
    <FileTree
      activePath={null}
      onOpenPreview={() => {}}
      onOpenPinned={() => {}}
      onOpenInNewPane={() => {}}
    />,
  )
}

const rowFor = (path: string) => document.querySelector(`[data-path="${path}"]`)!

beforeEach(() => {
  exportMock.mockClear()
  deleteMock.mockClear()
  window.holi = { chooseFolder: () => Promise.resolve('/out') } as never
})

test('Copy to Folder… writes the file out and leaves the vault alone', async () => {
  tree()
  fireEvent.contextMenu(rowFor('b.md'))

  await userEvent.click(await screen.findByText('Copy to Folder…'))

  await waitFor(() =>
    expect(exportMock).toHaveBeenCalledWith(
      expect.objectContaining({ paths: ['b.md'], dest: '/out' }),
    ),
  )
  expect(deleteMock).not.toHaveBeenCalled()
})

test('a cancelled folder chooser does nothing at all', async () => {
  window.holi = { chooseFolder: () => Promise.resolve(null) } as never
  tree()
  fireEvent.contextMenu(rowFor('b.md'))

  await userEvent.click(await screen.findByText('Copy to Folder…'))

  await new Promise((r) => setTimeout(r, 0))
  expect(exportMock).not.toHaveBeenCalled()
})

test('a move deletes ONLY what actually landed', async () => {
  // The whole reason the export reports `landed` separately. A file that could
  // not be written must still be in the vault afterwards — deleting it would
  // destroy the only copy.
  exportMock.mockResolvedValueOnce({
    landed: [],
    failed: [{ name: 'b.md', reason: 'could not be copied (EACCES)' }],
  })
  tree()
  fireEvent.contextMenu(rowFor('b.md'))
  await userEvent.click(await screen.findByText('Move to Folder…'))
  await userEvent.click(await screen.findByRole('button', { name: /Move/ }))

  await waitFor(() => expect(exportMock).toHaveBeenCalled())
  expect(deleteMock).not.toHaveBeenCalled()
  expect(await screen.findByText(/could not be copied/)).toBeInTheDocument()
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/desktop && pnpm exec vitest run --project dom src/renderer/src/features/explorer/__tests__/FileTree.export.test.tsx
```
Expected: FAIL — `Unable to find an element with the text: Copy to Folder…`.

- [ ] **Step 3: Extend the actions hook**

In `apps/desktop/src/renderer/src/features/explorer/useExplorerActions.ts`:

Widen the preview type (it is currently `DeletePreview` at line 31):

```ts
type DeletePreview = {
  label: string
  /** The vault FILES this affects — what the backrefs were computed over, and
   *  what a delete removes. */
  paths: string[]
  refs: { path: string; count: number }[]
  /** Set when this is a move OUT of the vault: the targets as picked (a folder
   *  stays a folder, so it keeps its shape on disk) and where they go. */
  move?: { targets: string[]; dest: string }
}
```

Add to the `ExplorerActions` interface:

```ts
  /** Copy targets to a folder on disk. The vault is unchanged. */
  copyOut(targets: string[]): void
  /** Move targets out: confirm first (backrefs), then copy, then delete. */
  startMoveOut(targets: string[], isFolder: boolean): void
  /** The verb the open confirmation is about to apply. */
  confirmVerb: 'Delete' | 'Move'
  /** Files the last export refused, held until dismissed or superseded. */
  exportFailures: { name: string; reason: string }[]
  dismissExportFailures(): void
```

Add the implementation inside the hook, after `confirmDelete`:

```ts
  const exportFiles = useSetAtom(exportFilesAtom)
  const [exportFailures, setExportFailures] = useState<{ name: string; reason: string }[]>([])

  const copyOut = useCallback(
    (targets: string[]) => {
      void (async () => {
        const dest = await window.holi.chooseFolder()
        if (dest === null) return
        const { failed } = await exportFiles(targets, dest)
        setExportFailures(failed)
      })()
    },
    [exportFiles],
  )

  const startMoveOut = useCallback(
    (targets: string[], isFolder: boolean) => {
      void (async () => {
        // The destination is chosen BEFORE the confirmation, so cancelling the
        // confirmation leaves nothing behind — no copy has happened yet.
        const dest = await window.holi.chooseFolder()
        if (dest === null) return
        const files = filesUnder(docPathsRef.current, targets)
        if (files.length === 0) return
        const label = deleteLabel(targets, files.length, isFolder)
        const refs = await getBackrefs(files)
        setConfirming({ label, paths: files, refs, move: { targets, dest } })
      })()
    },
    [getBackrefs],
  )
```

and replace `confirmDelete` with a version that understands a move:

```ts
  const confirmDelete = useCallback(() => {
    const preview = confirmingRef.current
    if (!preview) return
    setConfirming(null)
    if (!preview.move) {
      void deleteMany({ paths: preview.paths })
      return
    }
    const { targets, dest } = preview.move
    void (async () => {
      const { landed, failed } = await exportFiles(targets, dest)
      setExportFailures(failed)
      // ONLY what landed. A target that could not be written is still the only
      // copy there is, and deleting it here would destroy it.
      const survived = new Set(landed.map((l) => l.from))
      const toDelete = filesUnder(
        docPathsRef.current,
        targets.filter((t) => survived.has(t)),
      )
      if (toDelete.length > 0) await deleteMany({ paths: toDelete })
    })()
  }, [deleteMany, exportFiles])
```

Add `confirmVerb` and the new members to the returned object:

```ts
    copyOut,
    startMoveOut,
    confirmVerb: confirming?.move ? ('Move' as const) : ('Delete' as const),
    exportFailures,
    dismissExportFailures: () => setExportFailures([]),
```

Import `exportFilesAtom` from `@/state/vaults` at the top of the file.

- [ ] **Step 4: Add the menu items**

In `apps/desktop/src/renderer/src/features/explorer/FileTree.tsx`, in `rowMenu`, immediately before the `Convert to PDF…` block:

```tsx
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => actions.copyOut(targets)}>
          Copy to Folder…
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.startMoveOut(targets, isFolder)}>
          Move to Folder…
        </ContextMenuItem>
```

These sit outside the `{!multi && (` guard: both act on a whole selection, exactly as Cut/Copy/Delete already do.

- [ ] **Step 5: Pass the verb and surface the failures**

Find where `FileTree.tsx` renders `DeleteConfirm` (grep for `DeleteConfirm`) and add the verb:

```tsx
          verb={actions.confirmVerb}
```

Then extend the existing amber banner so an export failure shows in the same place an import failure does. Find the `skipped.length > 0 &&` block and change its condition and content to read from both sources:

```tsx
        {(skipped.length > 0 || actions.exportFailures.length > 0) && (
          <Button
            variant="link"
            onClick={() => {
              setSkipped([])
              actions.dismissExportFailures()
            }}
            className="mb-1 h-auto w-full justify-start whitespace-normal p-0 px-2 text-left text-[11px] text-amber-300/90 hover:text-amber-200"
          >
            {[...skipped, ...actions.exportFailures].map((s) => s.name).join(', ')} —{' '}
            {[...skipped, ...actions.exportFailures][0]!.reason}. Click to dismiss.
          </Button>
        )}
```

- [ ] **Step 6: Run the new test**

```bash
pnpm exec vitest run --project dom src/renderer/src/features/explorer/__tests__/FileTree.export.test.tsx
```
Expected: PASS — 3 tests.

- [ ] **Step 7: Mutation-check the rule with teeth**

In `confirmDelete`, replace the `survived` filter with `targets` (i.e. delete everything regardless of what landed). Re-run.
Expected: **"a move deletes ONLY what actually landed" FAILS.** Restore the filter.

If that test still passes, the test is wrong, not the code — fix the test before continuing.

- [ ] **Step 8: Run every gate**

```bash
cd apps/desktop && pnpm exec vitest run --project dom
pnpm exec vitest run --project node
pnpm exec eslint src
cd /Users/nicolaibthomsen/repos/syv/better-holi-final && pnpm typecheck
```
Expected: dom **509**, node **1633**, eslint 0 errors + the 2 known warnings, typecheck clean.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/renderer/src/features/explorer/useExplorerActions.ts \
        apps/desktop/src/renderer/src/features/explorer/FileTree.tsx \
        apps/desktop/src/renderer/src/features/explorer/__tests__/FileTree.export.test.tsx
git commit -m "feat(explorer): Copy to Folder… and Move to Folder…, and a move that only deletes what landed"
```

---

## Task 8: Tell the truth in the docs

FR-13 currently claims "Dropped in Finder, the file lands there." It does not. A PRD describing a product that does not exist is the exact failure `docs/README.md` splits `not-built.md` out to prevent.

**Files:**
- Modify: `docs/prd/notes-editor.md` (the FR-13 bullet beginning "**A file drags out to the OS**")
- Modify: `docs/not-built.md`

- [ ] **Step 1: Correct FR-13**

Replace the bullet beginning "**A file drags out to the OS, and the same drag brings it back.**" with:

```markdown
    - **A row's drag is a native drag, and that is how the in-tree move works.** A web drag never tells the operating system a file is involved, so a row hands the gesture to `startDrag`, which **replaces** the web drag rather than joining it. Dropped back on the window it arrives as an ordinary file drop, and a source inside this vault is treated as a **move** — through the move path, so links are rewritten and open tabs follow, rather than a copy that would leave a duplicate and a pile of links pointing at the original. A drop on a *row* is served by headless-tree's foreign-drag hooks rather than the container's handler; see the import bullet above for why that distinction is load-bearing. **Folders keep the web drag**: there is no single file to hand over, and their move already worked.
    - **Dropping a row into Finder does not work**, and the way out of the vault is **Copy to Folder…** / **Move to Folder…** in the row menu. Both act on a whole selection and on folders, both auto-rename rather than overwriting what is already at the destination — the vault's refuse-rather-than-overwrite rule protects the *vault*, and the destination here is the user's own disk, where a second copy is the useful answer and a silent replacement is the one thing git could not undo. A **move** shows the same backrefs warning a delete does, because it is a delete as far as the vault is concerned, and it removes only the files whose copy actually landed.
```

- [ ] **Step 2: Record the broken drag-out**

Add to `docs/not-built.md`:

```markdown
**Dragging a row out to Finder.** `webContents.startDrag` starts a drag the app's own window accepts — that round trip is what the in-tree move rides on — but Finder refuses the drop, so nothing lands. Verified by hand on macOS 2026-08-22; it cannot be tested, since no test or CDP can drive an OS drag. The handler matches Electron's documented shape (`files` + `file` + a non-empty `icon`), so the cause is not obviously in the call, and the 1×1 transparent drag icon is the first thing to suspect. **Copy to Folder… / Move to Folder… exist because of this** and cover the same need without a gesture; the drag would be a convenience on top, not a missing capability.
```

- [ ] **Step 3: Commit — stage the two files by name**

Never `git add docs`: it sweeps in `docs/upcoming.md`, which is untracked scratch.

```bash
git add docs/prd/notes-editor.md docs/not-built.md
git commit -m "docs: the drag to Finder does not work, and what replaces it"
```

---

## Done when

- [ ] `Copy to Folder…` writes a file, a multi-selection, and a folder to a chosen directory, vault unchanged.
- [ ] A second export to the same directory lands as `name copy.ext` and does not touch the first.
- [ ] `Move to Folder…` shows the backrefs warning worded as a move, and on confirm copies then deletes.
- [ ] A move whose copy fails deletes **nothing** and says why.
- [ ] Cancelling the folder chooser, or the confirmation, leaves no trace.
- [ ] node 1633 · dom 509 · shared 304 · typecheck clean · eslint 0 errors + 2 known warnings.
- [ ] `docs/prd/notes-editor.md` no longer claims the Finder drag works.

## Verify by hand before calling it done

None of this exercises a native dialog, and the dialog is where it will break first. In a running app (`pnpm dev:debug`):

1. Right-click a note → **Copy to Folder…** → pick Desktop. The file is on the Desktop; the note is still in the tree.
2. Do it again to the same folder. `note copy.md` appears; the first is untouched.
3. Right-click a folder → **Copy to Folder…**. The folder arrives with its contents.
4. Select two notes → **Move to Folder…** → confirm. Both leave the tree and arrive on disk.
5. Try a destination inside a Google Drive mirror. It should fail per file with a legible reason rather than hanging — the same `reasonFor` prose the import uses.
