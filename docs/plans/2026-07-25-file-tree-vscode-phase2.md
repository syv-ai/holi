# VS Code-style File Tree — Phase 2 Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the file tree to full VS Code parity — multi-select, folder rename/delete/move, drag-and-drop (files and folders, atomic multi-move), and cut/copy/paste/duplicate — on a new batch tRPC backend whose highest-risk piece, a **single-pass** link rewrite over a whole from→to map, is test-first.

**Architecture:** The tree stays a pure projection of `snapshotAtom`. Four new/generalized note procedures (`notes.move`, `notes.copy`, `notes.deleteMany`, `notes.backrefsMany`) do the disk work; each is wrapped by a renderer atom in the existing flush→commit→op→commit order so a whole batch lands as **one** commit-pair. `notes.move` rewrites every inbound `[[link]]` in one pass over the full map — the property that N independent renames cannot preserve (they double-rewrite a link whose target is itself another move's source). headless-tree already carries the `selectionFeature`/`dragAndDropFeature`; Phase 2 wires them to these batch atoms.

**Tech Stack:** React 18, TypeScript, Tailwind v4, jotai, `@headless-tree/core` + `@headless-tree/react` (MIT), Vitest 4 (node env, no jsdom), CDP for live UI verification. tRPC over IPC (typed router in `main/router.ts`).

**Scope:** Phase 2 only. Phase 1 (chrome, single-file CRUD, single-file drag) shipped. See `docs/specs/2026-07-24-file-tree-vscode-design.md` §Backend, §Interaction spec, §Phasing.

---

## Conventions (read once)

- **Tooling quirks:** bare `node`/`npx` are broken here — always `pnpm exec`. Run everything from `apps/desktop/` unless noted; the shared-package task runs from `packages/shared/`.
- **Tests:** `cd apps/desktop && pnpm exec vitest run` (node env, **no jsdom** — pure logic is unit-tested; the batch procedures are integration-tested against a tmpdir vault via `createCaller`; UI is CDP-verified). Shared: `cd packages/shared && pnpm exec vitest run`.
- **Typecheck (the real gate):** from `apps/desktop`, run `pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c error` — the baseline is **36** pre-existing errors (agent/history files). This number must not rise. (`pnpm exec tsc` now resolves the repo-root `typescript@^7` tsgo preview and mis-parses `--noEmit`, so invoke the local 5.9.3 binary explicitly.)
- **Live app:** an `electron-vite dev` instance runs on CDP port 9333, driver at `/tmp/holi-drive.mjs` (`pnpm exec node /tmp/holi-drive.mjs eval|shot <path>`). Renderer edits hot-reload; **main-process edits (router, vault helpers) need a relaunch**. Teardown only with the scoped `pkill -f "better-holi-final/node_modules/.pnpm/electron@"`. HTML5 drag is unreliable via CDP — ask the user to test real drags.
- **Vault writes auto-push** to the user's real GitHub repo (`nthomsencph/a-demo-vault-3`). Keep probe files minimal; don't delete vault files you didn't create.
- **Commit trailer:** end every commit message with `Claude goes brr.. via Dash`.

## File Structure

- **Modify** `packages/shared/src/wiki-links.ts` — add `rewriteWikiLinksMulti(text, map)`, the single-pass multi-target rewrite.
- **Modify** `packages/shared/test/wiki-links.test.ts` — tests for the above.
- **Create** `apps/desktop/src/main/vault/move.ts` — `moveNotes(root, moves)`: single-pass link rewrite + move, read-all-then-write so a chain can't clobber an unread file.
- **Create** `apps/desktop/test/move.test.ts` — unit tests (single, folder, multi, chain, self-referencing target).
- **Create** `apps/desktop/src/main/vault/copy.ts` — `copyNotes(root, copies)`: verbatim copy, no link rewrite.
- **Create** `apps/desktop/test/copy.test.ts` — unit tests.
- **Modify** `apps/desktop/src/main/vault/backrefs.ts` — add `scanBackrefsMany(root, targets)`, excluding links from within the set.
- **Modify** `apps/desktop/test/backrefs.test.ts` — tests for the above.
- **Modify** `apps/desktop/src/main/router.ts` — `notes.move`, `notes.copy`, `notes.deleteMany`, `notes.backrefsMany` + array input validators.
- **Modify** `apps/desktop/test/router.test.ts` — integration tests for the four procedures (incl. CONFLICT/NOT_FOUND).
- **Modify** `apps/desktop/src/renderer/src/lib/tree-paths.ts` — `expandToFiles`, `remapUnder`, `pathTaken`, `freeCopyPath`.
- **Modify** `apps/desktop/src/renderer/src/lib/tree-paths.test.ts` — tests for the above.
- **Modify** `apps/desktop/src/renderer/src/state/panes.ts` — `retargetTabs(workspace, moves)`, `closeTabsForPaths(workspace, paths)`.
- **Modify** `apps/desktop/test/panes.test.ts` — tests for the above.
- **Modify** `apps/desktop/src/renderer/src/state/vaults.ts` — `moveNotesAtom`, `copyNotesAtom`, `deleteManyAtom`, `backrefsForMany`.
- **Create** `apps/desktop/test/batch-ops-state.test.ts` — atom ordering/tab-retarget tests.
- **Modify** `apps/desktop/src/renderer/src/components/tree/DeleteConfirm.tsx` — generalize to a `label` + N-file preview.
- **Rewrite** `apps/desktop/src/renderer/src/components/FileTree.tsx` — multi-select, folder ops, DnD (folders + atomic multi-move), clipboard, keyboard, all on the batch atoms.

---

## Task 1: `rewriteWikiLinksMulti` — single-pass multi-target rewrite (shared)

The crux of the whole phase. A link whose target is a key in the map is rewritten **once**, using the original map — never chained through a value that is itself a key. This is exactly what sequential single renames get wrong.

**Files:**
- Modify: `packages/shared/src/wiki-links.ts`
- Test: `packages/shared/test/wiki-links.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/test/wiki-links.test.ts` (import `rewriteWikiLinksMulti` alongside the existing imports at the top of the file):

```ts
describe('rewriteWikiLinksMulti', () => {
  it('rewrites each targeted link once, from the ORIGINAL map (no chaining)', () => {
    // a→b and b→c in the SAME batch: the [[a.md]] link must become [[b.md]],
    // NOT be chained on to [[c.md]]. This is the property N sequential renames
    // cannot hold — the whole reason move is one pass over a full map.
    const map = new Map([
      ['a.md', 'b.md'],
      ['b.md', 'c.md'],
    ])
    const { text, count } = rewriteWikiLinksMulti('see [[a.md]] and [[b.md|Old]]', map)
    expect(text).toBe('see [[b.md]] and [[c.md|Old]]')
    expect(count).toBe(2)
  })

  it('leaves untargeted links and task chips alone, and returns the input unchanged at count 0', () => {
    const map = new Map([['a.md', 'z.md']])
    expect(rewriteWikiLinksMulti('[[keep.md]] and [[task:t1]]', map)).toEqual({
      text: '[[keep.md]] and [[task:t1]]',
      count: 0,
    })
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd packages/shared && pnpm exec vitest run test/wiki-links.test.ts`
Expected: FAIL — `rewriteWikiLinksMulti` is not exported.

- [ ] **Step 3: Implement**

Add to `packages/shared/src/wiki-links.ts`, after `rewriteWikiLinks`:

```ts
/**
 * Rewrite every note link whose target is a key of `moves` to that key's value,
 * in ONE pass over the ORIGINAL map — the batch-move primitive (spec §Backend).
 *
 * The single pass is the correctness. A link `[[a.md]]` under a map that also
 * moves `b.md` must resolve to `map.get('a.md')` and stop there, even when that
 * value is itself a key (`a→b`, `b→c`): chaining it on to `c` is precisely the
 * double-rewrite that applying N single-target `rewriteWikiLinks` in sequence
 * produces. Labels are preserved; task chips and untargeted links are untouched.
 */
export function rewriteWikiLinksMulti(
  text: string,
  moves: Map<string, string>,
): { text: string; count: number } {
  const links = parseWikiLinks(text)
  let out = ''
  let cursor = 0
  let count = 0
  for (const link of links) {
    if (link.kind !== 'note') continue
    const to = moves.get(link.target)
    if (to === undefined) continue
    out += text.slice(cursor, link.start) + formatWikiLink(to, link.label)
    cursor = link.end
    count += 1
  }
  return count === 0 ? { text, count: 0 } : { text: out + text.slice(cursor), count }
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `cd packages/shared && pnpm exec vitest run test/wiki-links.test.ts`
Expected: PASS (existing tests + 2 new).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/wiki-links.ts packages/shared/test/wiki-links.test.ts
git commit -m "feat(shared): rewriteWikiLinksMulti — single-pass multi-target link rewrite

Claude goes brr.. via Dash"
```

---

## Task 2: `moveNotes` — batch move + single-pass rewrite (main)

**Files:**
- Create: `apps/desktop/src/main/vault/move.ts`
- Test: `apps/desktop/test/move.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/test/move.test.ts`:

```ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { moveNotes } from '../src/main/vault/move'

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

async function vault(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holi-mv-'))
  dirs.push(root)
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(root, rel, '..'), { recursive: true })
    await writeFile(join(root, rel), text, 'utf8')
  }
  return root
}

const read = (root: string, rel: string) => readFile(join(root, rel), 'utf8')

describe('moveNotes', () => {
  it('a single move behaves exactly like a rename (file + inbound rewrite)', async () => {
    const root = await vault({
      'old.md': 'body',
      'ref.md': 'see [[old.md]] and [[old.md|Alias]]',
    })
    const { rewritten } = await moveNotes(root, [{ from: 'old.md', to: 'sub/new.md' }])
    expect(rewritten).toEqual([{ path: 'ref.md', count: 2 }])
    await expect(read(root, 'old.md')).rejects.toThrow()
    expect(await read(root, 'sub/new.md')).toBe('body')
    expect(await read(root, 'ref.md')).toBe('see [[sub/new.md]] and [[sub/new.md|Alias]]')
  })

  it('moves a whole folder, remapping inbound links to every file in it', async () => {
    const root = await vault({
      'projects/a.md': 'A',
      'projects/b.md': 'B',
      'index.md': '[[projects/a.md]] and [[projects/b.md]]',
    })
    await moveNotes(root, [
      { from: 'projects/a.md', to: 'work/a.md' },
      { from: 'projects/b.md', to: 'work/b.md' },
    ])
    expect(await read(root, 'work/a.md')).toBe('A')
    expect(await read(root, 'work/b.md')).toBe('B')
    expect(await read(root, 'index.md')).toBe('[[work/a.md]] and [[work/b.md]]')
  })

  it('rewrites a moved file’s OWN outbound link when its target also moved', async () => {
    // b.md links a.md, and both move in the same batch. b's own [[a.md]] must
    // land as [[x/a.md]] at b's new home — the map covers moved files too.
    const root = await vault({
      'a.md': 'A',
      'b.md': 'see [[a.md]]',
    })
    await moveNotes(root, [
      { from: 'a.md', to: 'x/a.md' },
      { from: 'b.md', to: 'x/b.md' },
    ])
    expect(await read(root, 'x/b.md')).toBe('see [[x/a.md]]')
  })

  it('resolves a chain in one pass — a link to a shifted name is NOT double-rewritten', async () => {
    // a→b and b→c together. keep.md’s [[a.md]] must become [[b.md]] (a’s new
    // name), never [[c.md]]. Sequential renames would chain it to c.
    const root = await vault({
      'a.md': 'A',
      'b.md': 'B',
      'keep.md': 'to a: [[a.md]]  to b: [[b.md]]',
    })
    await moveNotes(root, [
      { from: 'a.md', to: 'b.md' },
      { from: 'b.md', to: 'c.md' },
    ])
    // a’s content is now at b.md; b’s content is now at c.md.
    expect(await read(root, 'b.md')).toBe('A')
    expect(await read(root, 'c.md')).toBe('B')
    expect(await read(root, 'keep.md')).toBe('to a: [[b.md]]  to b: [[c.md]]')
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/desktop && pnpm exec vitest run test/move.test.ts`
Expected: FAIL — module `../src/main/vault/move` not found.

- [ ] **Step 3: Implement**

Create `apps/desktop/src/main/vault/move.ts`:

```ts
/**
 * Batch move: move every `from`→`to` and rewrite every inbound `[[link]]` in a
 * SINGLE pass over the full map (spec §The move link-rewrite). This is
 * `renameNote` generalized from one pair to a map, and the generalization is the
 * whole point: N independent renames double-rewrite a link whose target is
 * itself another move's source, and race each other's file writes. The renderer
 * expands a folder to its file list before calling; the router refuses clobbers.
 *
 * Read-all-then-write, deliberately. A chain (a→b, b→c) has one move's
 * destination equal to another's source, so writing as we go would overwrite a
 * file we have not yet read. Every file's new content is computed from the
 * on-disk originals first; only then are sources removed and destinations
 * written. There is no transaction — a mid-apply crash leaves a partial move
 * visible in `git status`, same contract as rename (prd §Rename).
 */
import { readFile } from 'node:fs/promises'
import { rewriteWikiLinksMulti, vaultRelPath } from '@holi/shared'
import { absPathFor, listFiles, removeDocFile, writeAtomic } from './vault-files'

export async function moveNotes(
  root: string,
  moves: { from: string; to: string }[],
): Promise<{ rewritten: { path: string; count: number }[] }> {
  const map = new Map(moves.map((m) => [m.from, m.to]))
  const rewritten: { path: string; count: number }[] = []
  const planned: { dest: string; text: string }[] = []

  for (const path of await listFiles(root)) {
    if (!path.endsWith('.md')) continue
    const text = await readFile(absPathFor(root, vaultRelPath(path)), 'utf8')
    const { text: next, count } = rewriteWikiLinksMulti(text, map)
    const dest = map.get(path) ?? path
    if (count > 0) rewritten.push({ path: dest, count })
    // A file needs writing if it moved OR its links changed; an untouched,
    // unmoved file is left exactly as it is.
    if (dest !== path || count > 0) planned.push({ dest, text: next })
  }

  for (const from of map.keys()) await removeDocFile(root, vaultRelPath(from))
  for (const p of planned) await writeAtomic(root, vaultRelPath(p.dest), p.text)

  return { rewritten: rewritten.sort((a, b) => a.path.localeCompare(b.path)) }
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `cd apps/desktop && pnpm exec vitest run test/move.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/vault/move.ts apps/desktop/test/move.test.ts
git commit -m "feat(vault): moveNotes — batch move with single-pass link rewrite

Claude goes brr.. via Dash"
```

---

## Task 3: `copyNotes` — verbatim batch copy (main)

**Files:**
- Create: `apps/desktop/src/main/vault/copy.ts`
- Test: `apps/desktop/test/copy.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/test/copy.test.ts`:

```ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { copyNotes } from '../src/main/vault/copy'

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

async function vault(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holi-cp-'))
  dirs.push(root)
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(root, rel, '..'), { recursive: true })
    await writeFile(join(root, rel), text, 'utf8')
  }
  return root
}

describe('copyNotes', () => {
  it('duplicates content verbatim and does NOT rewrite links (copies point at the originals)', async () => {
    const root = await vault({ 'a.md': 'body with [[other.md]]' })
    await copyNotes(root, [{ from: 'a.md', to: 'a copy.md' }])
    // The original survives, and the copy keeps the link untouched.
    expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('body with [[other.md]]')
    expect(await readFile(join(root, 'a copy.md'), 'utf8')).toBe('body with [[other.md]]')
  })

  it('copies multiple in one call, creating folders on the way', async () => {
    const root = await vault({ 'a.md': 'A', 'b.md': 'B' })
    await copyNotes(root, [
      { from: 'a.md', to: 'dup/a.md' },
      { from: 'b.md', to: 'dup/b.md' },
    ])
    expect(await readFile(join(root, 'dup/a.md'), 'utf8')).toBe('A')
    expect(await readFile(join(root, 'dup/b.md'), 'utf8')).toBe('B')
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/desktop && pnpm exec vitest run test/copy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/desktop/src/main/vault/copy.ts`:

```ts
/**
 * Batch copy: each source read and written to its destination verbatim. NO link
 * rewrite — a copy's `[[links]]` keep pointing where the original's did, matching
 * VS Code and the spec (§Cut/Copy/Paste). Callers refuse clobbers before calling
 * (the router checks each `to`), so this is pure read-and-write.
 */
import { readFile } from 'node:fs/promises'
import { vaultRelPath } from '@holi/shared'
import { absPathFor, writeAtomic } from './vault-files'

export async function copyNotes(
  root: string,
  copies: { from: string; to: string }[],
): Promise<void> {
  for (const c of copies) {
    const text = await readFile(absPathFor(root, vaultRelPath(c.from)), 'utf8')
    await writeAtomic(root, vaultRelPath(c.to), text)
  }
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `cd apps/desktop && pnpm exec vitest run test/copy.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/vault/copy.ts apps/desktop/test/copy.test.ts
git commit -m "feat(vault): copyNotes — verbatim batch copy, no link rewrite

Claude goes brr.. via Dash"
```

---

## Task 4: `scanBackrefsMany` — set-aware backrefs (main)

**Files:**
- Modify: `apps/desktop/src/main/vault/backrefs.ts`
- Test: `apps/desktop/test/backrefs.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/desktop/test/backrefs.test.ts` (import `scanBackrefsMany` alongside `scanBackrefs`):

```ts
describe('scanBackrefsMany', () => {
  it('counts external inbound links to any target, EXCLUDING links from within the set', async () => {
    // Deleting the folder {p/a.md, p/b.md} wholesale: a→b inside the set is not
    // "left dangling", so it must not be reported. outside.md IS an external ref.
    const root = await vault({
      'p/a.md': 'links [[p/b.md]]',
      'p/b.md': 'the other',
      'outside.md': 'refers [[p/a.md]] and [[p/b.md]]',
    })
    expect(await scanBackrefsMany(root, ['p/a.md', 'p/b.md'])).toEqual([
      { path: 'outside.md', count: 2 },
    ])
  })

  it('returns an empty array when nothing outside the set links in', async () => {
    const root = await vault({ 'p/a.md': 'lonely', 'q.md': 'unrelated' })
    expect(await scanBackrefsMany(root, ['p/a.md'])).toEqual([])
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/desktop && pnpm exec vitest run test/backrefs.test.ts`
Expected: FAIL — `scanBackrefsMany` not exported.

- [ ] **Step 3: Implement**

Add to `apps/desktop/src/main/vault/backrefs.ts`, after `scanBackrefs`:

```ts
/**
 * Files OUTSIDE `targets` that link INTO the set, with how many such links each
 * has — the delete preview for a folder or multi-selection (FR-12 generalized).
 *
 * Links that ORIGINATE from within the set are excluded: an internal link
 * between two notes being deleted together is not a tombstone anyone is left
 * with, so counting it would over-warn.
 */
export async function scanBackrefsMany(
  root: string,
  targets: string[],
): Promise<{ path: string; count: number }[]> {
  const set = new Set(targets)
  const out: { path: string; count: number }[] = []
  for (const path of await listFiles(root)) {
    if (!path.endsWith('.md') || set.has(path)) continue
    const text = await readFile(`${root}/${path}`, 'utf8').catch(() => null)
    if (text === null) continue
    const count = parseWikiLinks(text).filter(
      (link) => link.kind === 'note' && set.has(link.target),
    ).length
    if (count > 0) out.push({ path, count })
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `cd apps/desktop && pnpm exec vitest run test/backrefs.test.ts`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/vault/backrefs.ts apps/desktop/test/backrefs.test.ts
git commit -m "feat(vault): scanBackrefsMany — set-aware backrefs, excluding internal links

Claude goes brr.. via Dash"
```

---

## Task 5: Wire the four batch procedures into the router (main)

**Files:**
- Modify: `apps/desktop/src/main/router.ts`
- Test: `apps/desktop/test/router.test.ts`

- [ ] **Step 1: Write the failing integration tests**

Add to `apps/desktop/test/router.test.ts`, inside the top-level `describe('notes', ...)` block (after the existing `rename refuses to clobber` test):

```ts
it('move renames many files and rewrites inbound links in one pass', async () => {
  const { caller, root } = await rig({
    'projects/a.md': 'A',
    'projects/b.md': 'B',
    'index.md': '[[projects/a.md]] and [[projects/b.md]]',
  })
  await caller.notes.move({
    remote: REMOTE,
    moves: [
      { from: 'projects/a.md', to: 'work/a.md' },
      { from: 'projects/b.md', to: 'work/b.md' },
    ],
  })
  expect(await readFile(join(root, 'work/a.md'), 'utf8')).toBe('A')
  expect(await readFile(join(root, 'index.md'), 'utf8')).toBe('[[work/a.md]] and [[work/b.md]]')
})

it('move refuses to clobber a destination outside the moved set', async () => {
  const { caller } = await rig({ 'a.md': 'a', 'taken.md': 'b' })
  await expect(
    caller.notes.move({ remote: REMOTE, moves: [{ from: 'a.md', to: 'taken.md' }] }),
  ).rejects.toThrow(/already exists/)
})

it('move allows a destination that is itself a source in the same batch (a swap-shaped chain)', async () => {
  const { caller, root } = await rig({ 'a.md': 'A', 'b.md': 'B' })
  await caller.notes.move({
    remote: REMOTE,
    moves: [
      { from: 'a.md', to: 'b.md' },
      { from: 'b.md', to: 'c.md' },
    ],
  })
  expect(await readFile(join(root, 'b.md'), 'utf8')).toBe('A')
  expect(await readFile(join(root, 'c.md'), 'utf8')).toBe('B')
})

it('copy duplicates without rewriting links, and refuses to clobber', async () => {
  const { caller, root } = await rig({ 'a.md': 'body [[x.md]]', 'taken.md': 'mine' })
  const result = await caller.notes.copy({ remote: REMOTE, copies: [{ from: 'a.md', to: 'dup.md' }] })
  expect(result).toEqual({ copied: ['dup.md'] })
  expect(await readFile(join(root, 'dup.md'), 'utf8')).toBe('body [[x.md]]')
  await expect(
    caller.notes.copy({ remote: REMOTE, copies: [{ from: 'a.md', to: 'taken.md' }] }),
  ).rejects.toThrow(/already exists/)
})

it('copy reports a missing source rather than writing an empty file', async () => {
  const { caller } = await rig()
  await expect(
    caller.notes.copy({ remote: REMOTE, copies: [{ from: 'ghost.md', to: 'dup.md' }] }),
  ).rejects.toThrow(/ghost/)
})

it('deleteMany removes every path in one call', async () => {
  const { caller } = await rig({ 'a.md': 'A', 'b.md': 'B', 'c.md': 'C' })
  await caller.notes.deleteMany({ remote: REMOTE, paths: ['a.md', 'b.md'] })
  await expect(caller.notes.read({ remote: REMOTE, path: 'a.md' })).rejects.toThrow()
  await expect(caller.notes.read({ remote: REMOTE, path: 'b.md' })).rejects.toThrow()
  expect(await caller.notes.read({ remote: REMOTE, path: 'c.md' })).toBe('C')
})

it('backrefsMany names external referrers and excludes links inside the set', async () => {
  const { caller } = await rig({
    'p/a.md': 'links [[p/b.md]]',
    'p/b.md': 'other',
    'outside.md': '[[p/a.md]] and [[p/b.md]]',
  })
  expect(await caller.notes.backrefsMany({ remote: REMOTE, paths: ['p/a.md', 'p/b.md'] })).toEqual([
    { path: 'outside.md', count: 2 },
  ])
})

it('the batch procedures guard paths just like the single ones', async () => {
  const { caller } = await rig()
  await expect(
    caller.notes.move({ remote: REMOTE, moves: [{ from: '../evil.md', to: 'x.md' }] }),
  ).rejects.toThrow()
  await expect(
    caller.notes.deleteMany({ remote: REMOTE, paths: ['../evil.md'] }),
  ).rejects.toThrow()
})
```

- [ ] **Step 2: Run them, verify they fail**

Run: `cd apps/desktop && pnpm exec vitest run test/router.test.ts`
Expected: FAIL — `caller.notes.move` etc. do not exist.

- [ ] **Step 3: Add the array input validators**

In `apps/desktop/src/main/router.ts`, add near the `fields` helper (after the `fields` function, before `createRouter`):

```ts
/** Batch inputs the string-only `fields` helper cannot express. Each throws on a
 *  bad shape; tRPC turns that into a BAD_REQUEST. The RETURN type is the client's
 *  input contract (tRPC infers it), so the keys here are what callers pass. */
function pairsOf(raw: unknown, key: 'moves' | 'copies'): { from: string; to: string }[] {
  if (raw === null || typeof raw !== 'object') throw new Error('input must be an object')
  const arr = (raw as Record<string, unknown>)[key]
  if (!Array.isArray(arr)) throw new Error(`${key} must be an array`)
  return arr.map((p) => {
    if (p === null || typeof p !== 'object') throw new Error(`each ${key} entry must be an object`)
    const { from, to } = p as Record<string, unknown>
    if (typeof from !== 'string' || typeof to !== 'string') {
      throw new Error(`${key} entries need string from and to`)
    }
    return { from, to }
  })
}

function movesInput(raw: unknown): { remote: string; moves: { from: string; to: string }[] } {
  return { ...fields({ remote: 'string' })(raw), moves: pairsOf(raw, 'moves') }
}

function copiesInput(raw: unknown): { remote: string; copies: { from: string; to: string }[] } {
  return { ...fields({ remote: 'string' })(raw), copies: pairsOf(raw, 'copies') }
}

function pathsInput(raw: unknown): { remote: string; paths: string[] } {
  const { remote } = fields({ remote: 'string' })(raw)
  const paths = (raw as Record<string, unknown>).paths
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string')) {
    throw new Error('paths must be an array of strings')
  }
  return { remote, paths: paths as string[] }
}
```

- [ ] **Step 4: Add the four procedures**

In `apps/desktop/src/main/router.ts`, import the new helpers at the top (next to `import { renameNote } from './vault/rename'`):

```ts
import { moveNotes } from './vault/move'
import { copyNotes } from './vault/copy'
import { scanBackrefs, scanBackrefsMany } from './vault/backrefs'
```

(Replace the existing `import { scanBackrefs } from './vault/backrefs'` line with the combined one above.)

Then add to the `notes` router, after the existing `rename` procedure:

```ts
    // Batch move: one commit-pair from the renderer, one single-pass link
    // rewrite here. The renderer expands a folder to its file list before
    // calling; each `to` outside the moved set must be free (a swap-shaped chain,
    // where a `to` IS another move's `from`, is allowed — that is the whole
    // reason it is one procedure).
    move: vaultMutation
      .input(movesInput)
      .mutation(async ({ input }): Promise<{ rewritten: { path: string; count: number }[] }> => {
        const root = await rootFor(input.remote)
        const fromSet = new Set(input.moves.map((m) => m.from))
        for (const m of input.moves) {
          safe(m.from)
          const to = safe(m.to)
          if (!fromSet.has(m.to) && (await exists(root, to))) {
            throw new TRPCError({ code: 'CONFLICT', message: `already exists: ${m.to}` })
          }
        }
        return moveNotes(root, input.moves)
      }),

    // Batch copy: verbatim, no link rewrite (spec §Cut/Copy). Refuses to clobber
    // and reports a missing source rather than writing an empty file.
    copy: vaultMutation
      .input(copiesInput)
      .mutation(async ({ input }): Promise<{ copied: string[] }> => {
        const root = await rootFor(input.remote)
        for (const c of input.copies) {
          const from = safe(c.from)
          const to = safe(c.to)
          if (!(await exists(root, from))) {
            throw new TRPCError({ code: 'NOT_FOUND', message: c.from })
          }
          if (await exists(root, to)) {
            throw new TRPCError({ code: 'CONFLICT', message: `already exists: ${c.to}` })
          }
        }
        await copyNotes(root, input.copies)
        return { copied: input.copies.map((c) => c.to) }
      }),

    // Batch delete: file, folder (expanded by the renderer) or multi-selection.
    // Lands as one commit-pair (the renderer wraps it); a missing path is not an
    // error, matching single delete.
    deleteMany: vaultMutation
      .input(pathsInput)
      .mutation(async ({ input }) => {
        const root = await rootFor(input.remote)
        for (const p of input.paths) await removeDocFile(root, safe(p))
        return { ok: true as const }
      }),

    // FR-12 generalized: the delete preview for a folder or multi-selection.
    backrefsMany: t.procedure
      .input(pathsInput)
      .query(async ({ input }): Promise<{ path: string; count: number }[]> => {
        return scanBackrefsMany(
          await rootFor(input.remote),
          input.paths.map((p) => safe(p)),
        )
      }),
```

- [ ] **Step 5: Typecheck + run tests**

Run: `cd apps/desktop && pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c error`
Expected: `36`.

Run: `pnpm exec vitest run test/router.test.ts`
Expected: PASS (existing + 8 new).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/router.ts apps/desktop/test/router.test.ts
git commit -m "feat(router): batch notes procedures — move, copy, deleteMany, backrefsMany

Claude goes brr.. via Dash"
```

---

## Task 6: `tree-paths` helpers for folder/clipboard math (renderer)

**Files:**
- Modify: `apps/desktop/src/renderer/src/lib/tree-paths.ts`
- Test: `apps/desktop/src/renderer/src/lib/tree-paths.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/desktop/src/renderer/src/lib/tree-paths.test.ts` (extend the import to include the new names):

```ts
import {
  basename,
  expandToFiles,
  freeCopyPath,
  joinPath,
  parentOf,
  pathTaken,
  remapUnder,
  renameBasenameRange,
  withMdExtension,
} from './tree-paths'

describe('tree-paths — folder & clipboard helpers', () => {
  const docs = ['inbox.md', 'projects/a.md', 'projects/sub/b.md']

  it('expandToFiles returns a file itself and every doc under a folder', () => {
    expect(expandToFiles(docs, 'inbox.md')).toEqual(['inbox.md'])
    expect(expandToFiles(docs, 'projects')).toEqual(['projects/a.md', 'projects/sub/b.md'])
    expect(expandToFiles(docs, 'empty')).toEqual([]) // transient folder, no docs
  })

  it('remapUnder rewrites the source prefix, preserving nested structure', () => {
    expect(remapUnder(docs, 'projects', 'work/projects')).toEqual([
      { from: 'projects/a.md', to: 'work/projects/a.md' },
      { from: 'projects/sub/b.md', to: 'work/projects/sub/b.md' },
    ])
    expect(remapUnder(docs, 'inbox.md', 'archive/inbox.md')).toEqual([
      { from: 'inbox.md', to: 'archive/inbox.md' },
    ])
  })

  it('pathTaken sees a file OR a folder-prefix collision', () => {
    expect(pathTaken(docs, 'inbox.md')).toBe(true)
    expect(pathTaken(docs, 'projects')).toBe(true) // occupied as a folder prefix
    expect(pathTaken(docs, 'nope')).toBe(false)
  })

  it('freeCopyPath appends " copy", then " copy 2", before the extension', () => {
    const taken = (p: string) => pathTaken(['a.md', 'a copy.md'], p)
    expect(freeCopyPath(taken, 'fresh.md')).toBe('fresh.md') // free — untouched
    expect(freeCopyPath(taken, 'a.md')).toBe('a copy 2.md') // a.md and a copy.md taken
    expect(freeCopyPath((p) => pathTaken(['a.md'], p), 'a.md')).toBe('a copy.md')
  })

  it('freeCopyPath suffixes a folder name (no extension)', () => {
    const taken = (p: string) => pathTaken(['projects/x.md'], p)
    expect(freeCopyPath(taken, 'projects')).toBe('projects copy')
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/desktop && pnpm exec vitest run src/renderer/src/lib/tree-paths.test.ts`
Expected: FAIL — new helpers not exported.

- [ ] **Step 3: Implement**

Add to `apps/desktop/src/renderer/src/lib/tree-paths.ts` (after the existing helpers):

```ts
/** Every doc at or under `source`: a file matches itself; a folder matches its
 *  `source/` prefix. A folder move/delete fans out to exactly these. */
export const expandToFiles = (docPaths: string[], source: string): string[] =>
  docPaths.filter((p) => p === source || p.startsWith(`${source}/`))

/** `{ from, to }` for every doc under `source` such that `source` itself lands at
 *  `dest` — a file → `dest`, a folder → `dest/…` preserving nested structure. */
export const remapUnder = (
  docPaths: string[],
  source: string,
  dest: string,
): { from: string; to: string }[] =>
  expandToFiles(docPaths, source).map((from) => ({ from, to: dest + from.slice(source.length) }))

/** True if `path` is occupied as a file OR as a folder prefix among `paths`. */
export const pathTaken = (paths: Iterable<string>, path: string): boolean => {
  for (const p of paths) if (p === path || p.startsWith(`${path}/`)) return true
  return false
}

/** The first non-colliding `… copy` / `… copy N` name for `path` (VS Code's
 *  Duplicate). Collision is asked of `taken`, so it works for a file (suffix
 *  before the extension) and a folder (suffix on the bare name) alike. */
export const freeCopyPath = (taken: (p: string) => boolean, path: string): string => {
  if (!taken(path)) return path
  const base = basename(path)
  const dir = parentOf(path)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  for (let n = 1; n < 1000; n++) {
    const candidate = joinPath(dir, `${stem}${n === 1 ? ' copy' : ` copy ${n}`}${ext}`)
    if (!taken(candidate)) return candidate
  }
  return path
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `cd apps/desktop && pnpm exec vitest run src/renderer/src/lib/tree-paths.test.ts`
Expected: PASS (existing + new).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/tree-paths.ts src/renderer/src/lib/tree-paths.test.ts
git commit -m "feat(tree): path helpers for folder ops and copy/duplicate naming

Claude goes brr.. via Dash"
```

---

## Task 7: `panes` — retarget/close tabs for batches (renderer)

**Files:**
- Modify: `apps/desktop/src/renderer/src/state/panes.ts`
- Test: `apps/desktop/test/panes.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/desktop/test/panes.test.ts` (extend the import from `../src/renderer/src/state/panes` to include `retargetTabs` and `closeTabsForPaths`):

```ts
describe('retargetTabs', () => {
  it('points every open tab at its moved path, across panes, leaving others alone', () => {
    let w = emptyWorkspace()
    w = openTab(w, { kind: 'note', path: 'a.md' })
    w = openTab(w, { kind: 'note', path: 'keep.md' })
    w = retargetTabs(w, [{ from: 'a.md', to: 'sub/a.md' }])
    expect(w.panes[0]!.tabs).toEqual([
      { kind: 'note', path: 'sub/a.md' },
      { kind: 'note', path: 'keep.md' },
    ])
  })
})

describe('closeTabsForPaths', () => {
  it('closes deleted tabs and keeps the user on a surviving document', () => {
    let w = emptyWorkspace()
    w = openTab(w, { kind: 'note', path: 'a.md' }) // idx 0
    w = openTab(w, { kind: 'note', path: 'b.md' }) // idx 1
    w = openTab(w, { kind: 'note', path: 'c.md' }) // idx 2, active
    w = closeTabsForPaths(w, ['a.md']) // delete one to the left of active
    expect(w.panes[0]!.tabs).toEqual([
      { kind: 'note', path: 'b.md' },
      { kind: 'note', path: 'c.md' },
    ])
    expect(w.panes[0]!.active).toBe(1) // still on c.md
  })

  it('falls back to a neighbour when the active tab is deleted, and empties cleanly', () => {
    let w = emptyWorkspace()
    w = openTab(w, { kind: 'note', path: 'a.md' })
    w = openTab(w, { kind: 'note', path: 'b.md' }) // active
    expect(closeTabsForPaths(w, ['b.md']).panes[0]!.active).toBe(0)
    expect(closeTabsForPaths(w, ['a.md', 'b.md']).panes[0]).toEqual({ tabs: [], active: -1 })
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/desktop && pnpm exec vitest run test/panes.test.ts`
Expected: FAIL — `retargetTabs` / `closeTabsForPaths` not exported.

- [ ] **Step 3: Implement**

Add to `apps/desktop/src/renderer/src/state/panes.ts` (after `retargetTab`):

```ts
/** `retargetTab` for a whole batch (FR-11, folder/multi-move). One map, applied
 *  across all panes; a tab whose path is a `from` follows to its `to`. */
export function retargetTabs(workspace: Workspace, moves: { from: string; to: string }[]): Workspace {
  const map = new Map(moves.map((m) => [m.from, m.to]))
  return {
    ...workspace,
    panes: workspace.panes.map((pane) => ({
      ...pane,
      tabs: pane.tabs.map((tab) =>
        tab.kind === 'note' && map.has(tab.path) ? { ...tab, path: map.get(tab.path)! } : tab,
      ),
    })),
  }
}

/**
 * Close every tab pointing at a deleted path, in every pane.
 *
 * The active selection follows the *document*: if what was active survives, the
 * user stays on it (its index is re-found after the removals); if it was one of
 * the deleted, the pane falls back to the nearest surviving neighbour, and an
 * emptied pane stays as the empty-editor state (`active: -1`), never disappears.
 */
export function closeTabsForPaths(workspace: Workspace, paths: string[]): Workspace {
  const gone = (t: Tab) => t.kind === 'note' && paths.includes(t.path)
  return {
    ...workspace,
    panes: workspace.panes.map((pane) => {
      if (!pane.tabs.some(gone)) return pane
      const activeTab = pane.tabs[pane.active]
      const tabs = pane.tabs.filter((t) => !gone(t))
      if (tabs.length === 0) return { tabs, active: -1 }
      if (activeTab !== undefined && !gone(activeTab)) return { tabs, active: tabs.indexOf(activeTab) }
      return { tabs, active: Math.max(0, Math.min(pane.active, tabs.length - 1)) }
    }),
  }
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `cd apps/desktop && pnpm exec vitest run test/panes.test.ts`
Expected: PASS (existing + new).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/state/panes.ts apps/desktop/test/panes.test.ts
git commit -m "feat(panes): retargetTabs and closeTabsForPaths for batch note ops

Claude goes brr.. via Dash"
```

---

## Task 8: Batch mutation atoms (renderer)

**Files:**
- Modify: `apps/desktop/src/renderer/src/state/vaults.ts`
- Test: `apps/desktop/test/batch-ops-state.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/test/batch-ops-state.test.ts`:

```ts
/**
 * The renderer half of the batch note ops. What matters is the ORDER — flush,
 * commit a clean restore point, run the batch, commit again — so a whole batch
 * lands as one commit-pair on safe ground, plus the open tabs following a move
 * and closing on a delete.
 */
import { createStore } from 'jotai'
import { afterEach, describe, expect, it } from 'vitest'
import type { VaultSnapshot } from '@holi/shared'
import { installFakeHoli, type FakeHoli } from './helpers/fake-holi'
import {
  activeRemoteAtom,
  copyNotesAtom,
  deleteManyAtom,
  moveNotesAtom,
} from '../src/renderer/src/state/vaults'
import { emptyWorkspace, openTab, workspaceAtom } from '../src/renderer/src/state/panes'

let holi: FakeHoli | null = null
afterEach(() => {
  holi?.restore()
  holi = null
})

const emptySnapshot = (): VaultSnapshot => ({ docs: [], tasks: [], broken: [] })

describe('moveNotesAtom', () => {
  it('flushes, commits, moves, commits — and retargets the open tabs', async () => {
    holi = installFakeHoli((op) => {
      if (op.path === 'notes.move') return { rewritten: [] }
      if (op.path === 'vaults.snapshot') return emptySnapshot()
      return undefined
    })
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/notes')
    store.set(workspaceAtom, openTab(emptyWorkspace(), { kind: 'note', path: 'projects/a.md' }))

    await store.set(moveNotesAtom, { moves: [{ from: 'projects/a.md', to: 'work/a.md' }] })

    expect(holi.calls.map((c) => c.path)).toEqual([
      'sync.commitNow',
      'notes.move',
      'vaults.snapshot',
      'sync.commitNow',
    ])
    expect(store.get(workspaceAtom).panes[0]!.tabs).toEqual([{ kind: 'note', path: 'work/a.md' }])
  })

  it('is a no-op with no vault open, and with an empty batch', async () => {
    holi = installFakeHoli()
    const store = createStore()
    await store.set(moveNotesAtom, { moves: [{ from: 'a.md', to: 'b.md' }] })
    store.set(activeRemoteAtom, 'syv-ai/notes')
    await store.set(moveNotesAtom, { moves: [] })
    expect(holi.calls).toEqual([])
  })
})

describe('deleteManyAtom', () => {
  it('flushes, commits, deletes, commits — and closes the deleted tabs', async () => {
    holi = installFakeHoli((op) => (op.path === 'vaults.snapshot' ? emptySnapshot() : undefined))
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/notes')
    store.set(workspaceAtom, openTab(emptyWorkspace(), { kind: 'note', path: 'a.md' }))

    await store.set(deleteManyAtom, { paths: ['a.md'] })

    expect(holi.calls.map((c) => c.path)).toEqual([
      'sync.commitNow',
      'notes.deleteMany',
      'vaults.snapshot',
      'sync.commitNow',
    ])
    expect(store.get(workspaceAtom).panes[0]!.tabs).toEqual([])
  })
})

describe('copyNotesAtom', () => {
  it('flushes, commits, copies, commits', async () => {
    holi = installFakeHoli((op) => {
      if (op.path === 'notes.copy') return { copied: ['a copy.md'] }
      if (op.path === 'vaults.snapshot') return emptySnapshot()
      return undefined
    })
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/notes')

    await store.set(copyNotesAtom, { copies: [{ from: 'a.md', to: 'a copy.md' }] })

    expect(holi.calls.map((c) => c.path)).toEqual([
      'sync.commitNow',
      'notes.copy',
      'vaults.snapshot',
      'sync.commitNow',
    ])
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/desktop && pnpm exec vitest run test/batch-ops-state.test.ts`
Expected: FAIL — the atoms are not exported.

- [ ] **Step 3: Implement**

In `apps/desktop/src/renderer/src/state/vaults.ts`, extend the panes import:

```ts
import { closeTabsForPaths, retargetTab, retargetTabs, workspaceAtom } from './panes'
```

Then add, after `renameNoteAtom`:

```ts
/**
 * Batch move (folder rename/delete-to-move, drag, cut+paste). Same order as
 * `renameNoteAtom`, one commit-pair for the whole batch: flush the live buffer
 * and commit a clean restore point, run the single-pass `notes.move`, retarget
 * every open tab, reload the snapshot, follow the active doc, commit again.
 */
export const moveNotesAtom = atom(
  null,
  async (get, set, { moves }: { moves: { from: string; to: string }[] }) => {
    const remote = get(activeRemoteAtom)
    if (!remote || moves.length === 0) return
    await flushAllBuffers()
    await trpc.sync.commitNow.mutate()
    await trpc.notes.move.mutate({ remote, moves })
    set(workspaceAtom, retargetTabs(get(workspaceAtom), moves))
    const active = get(activeDocAtom)
    const moved = active ? moves.find((m) => m.from === active.path) : undefined
    await set(loadSnapshotAtom)
    if (moved) set(activeDocAtom, get(snapshotAtom).docs.find((d) => d.path === moved.to) ?? null)
    await trpc.sync.commitNow.mutate()
  },
)

/**
 * Batch copy (Duplicate, Copy+Paste). No link rewrite and no tab retarget — the
 * originals stay put — but the same commit-pair ordering, and the flush ensures a
 * copy of a note being edited includes the latest keystrokes.
 */
export const copyNotesAtom = atom(
  null,
  async (get, set, { copies }: { copies: { from: string; to: string }[] }) => {
    const remote = get(activeRemoteAtom)
    if (!remote || copies.length === 0) return
    await flushAllBuffers()
    await trpc.sync.commitNow.mutate()
    await trpc.notes.copy.mutate({ remote, copies })
    await set(loadSnapshotAtom)
    await trpc.sync.commitNow.mutate()
  },
)

/**
 * Batch delete (file, folder, multi-selection). Clears the editor if the open
 * note is among them and closes every deleted tab, so the pane never holds a doc
 * that no longer exists. One commit-pair, like the others.
 */
export const deleteManyAtom = atom(null, async (get, set, { paths }: { paths: string[] }) => {
  const remote = get(activeRemoteAtom)
  if (!remote || paths.length === 0) return
  await flushAllBuffers()
  await trpc.sync.commitNow.mutate()
  await trpc.notes.deleteMany.mutate({ remote, paths })
  const gone = new Set(paths)
  if (gone.has(get(activeDocAtom)?.path ?? '')) set(activeDocAtom, null)
  set(workspaceAtom, closeTabsForPaths(get(workspaceAtom), paths))
  await set(loadSnapshotAtom)
  await trpc.sync.commitNow.mutate()
})

/** What links into a set — the folder / multi-selection delete preview (FR-12
 *  generalized). Empty, and no call, for an empty set. */
export const backrefsForMany = atom(
  null,
  async (get, _set, paths: string[]): Promise<{ path: string; count: number }[]> => {
    const remote = get(activeRemoteAtom)
    if (!remote || paths.length === 0) return []
    return trpc.notes.backrefsMany.query({ remote, paths })
  },
)
```

Note: `retargetTab` stays imported because `renameNoteAtom` still uses it.

- [ ] **Step 4: Run it, verify it passes**

Run: `cd apps/desktop && pnpm exec vitest run test/batch-ops-state.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck**

Run: `cd apps/desktop && pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c error`
Expected: `36`.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/state/vaults.ts apps/desktop/test/batch-ops-state.test.ts
git commit -m "feat(state): batch move/copy/deleteMany atoms + multi-path backrefs

Claude goes brr.. via Dash"
```

---

## Task 9: Generalize `DeleteConfirm` to a label + N-file preview

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/tree/DeleteConfirm.tsx`

- [ ] **Step 1: Replace the component**

The dialog now previews a single file, a whole folder, or a multi-selection. It takes a display `label` and the already-computed external `refs`; the caller owns expanding a folder to its file set.

Replace `apps/desktop/src/renderer/src/components/tree/DeleteConfirm.tsx` with:

```tsx
/**
 * The FR-12 delete preview, generalized to a set. Names how many external links
 * across how many files will be left dangling (they become tombstones — no
 * cascade), so deleting a file, a folder, or a multi-selection is a decision made
 * with the fallout in view. The caller passes a human `label` and the external
 * `refs` (folder-internal links are already excluded by `backrefsMany`).
 */
export function DeleteConfirm({
  label,
  refs,
  onCancel,
  onConfirm,
}: {
  label: string
  refs: { path: string; count: number }[]
  onCancel: () => void
  onConfirm: () => void
}) {
  const total = refs.reduce((n, r) => n + r.count, 0)
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onCancel}
    >
      <div
        data-delete-dialog={label}
        className="w-80 rounded-lg border border-neutral-800 bg-neutral-950 p-4 text-sm text-neutral-200 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="mb-2">
          Delete <span className="font-mono text-neutral-100">{label}</span>?
        </p>
        {refs.length === 0 ? (
          <p className="mb-3 text-xs text-neutral-500">Nothing links to it.</p>
        ) : (
          <div className="mb-3">
            <p className="mb-1 text-xs text-neutral-400">
              {total} link{total === 1 ? '' : 's'} in {refs.length} file
              {refs.length === 1 ? '' : 's'} will be left dangling (they become tombstones — no
              cascade):
            </p>
            <ul className="max-h-40 overflow-y-auto text-xs">
              {refs.map((r) => (
                <li key={r.path} className="flex justify-between font-mono text-neutral-300">
                  <span className="truncate">{r.path}</span>
                  <span className="ml-2 shrink-0 text-neutral-500">×{r.count}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button
            className="rounded px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            data-delete-confirm={label}
            className="rounded bg-red-900/60 px-2 py-1 text-xs text-red-200 hover:bg-red-900"
            onClick={onConfirm}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}
```

(The prop rename from `path` to `label` is picked up by the FileTree rewrite in Task 10; nothing else imports this component.)

- [ ] **Step 2: Commit** (typecheck will show a transient error in `FileTree.tsx` until Task 10 — commit the component alone; the file is not built in isolation, and Task 10 lands in the same session)

```bash
git add src/renderer/src/components/tree/DeleteConfirm.tsx
git commit -m "refactor(tree): DeleteConfirm previews a label + N-file set

Claude goes brr.. via Dash"
```

---

## Task 10: Rewrite `FileTree` — multi-select, folder ops, DnD, clipboard, keyboard

This replaces the whole component body. The prop shape is unchanged, so `Shell.tsx` needs no edit. Every mutation routes through the batch atoms from Task 8.

**Files:**
- Rewrite: `apps/desktop/src/renderer/src/components/FileTree.tsx`

- [ ] **Step 1: Replace the file**

```tsx
/**
 * The vault as a VS Code-style explorer — Phase 2: multi-select, folder
 * rename/delete/move, drag-and-drop (files and folders, atomic multi-move), and
 * cut/copy/paste/duplicate.
 *
 * Pure projection of `snapshotAtom` (plus a client-only `pendingFolders` set for
 * transient folders). headless-tree owns selection/focus/expansion/keyboard;
 * every mutation runs through the batch atoms so the single-pass link-rewrite
 * move and the backref/tombstone delete stay ours. Handlers read the freshest
 * snapshot/clipboard through refs, because headless-tree captures its config
 * closures once.
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
import { useEffect, useMemo, useRef, useState } from 'react'
import { DeleteConfirm } from './tree/DeleteConfirm'
import { ExplorerHeader } from './tree/ExplorerHeader'
import { TreeContextMenu, type MenuItem } from './tree/TreeContextMenu'
import { ChevronIcon, FolderIcon, MarkdownIcon } from './tree/icons'
import { buildTreeData, ROOT_ID, type TreeItemData } from '../lib/tree-data'
import {
  basename,
  expandToFiles,
  freeCopyPath,
  joinPath,
  parentOf,
  pathTaken,
  remapUnder,
  renameBasenameRange,
  withMdExtension,
} from '../lib/tree-paths'
import {
  activeRemoteAtom,
  backrefsForMany,
  copyNotesAtom,
  createNoteAtom,
  deleteManyAtom,
  moveNotesAtom,
  renameNoteAtom,
  snapshotAtom,
  vaultsAtom,
} from '../state/vaults'

/** The inline editable row shown when creating a file or folder. */
function PendingRow({
  kind,
  onCommit,
  onCancel,
}: {
  kind: 'file' | 'folder'
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

type Clipboard = { mode: 'cut' | 'copy'; paths: string[] } | null

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
  const activeRemote = useAtomValue(activeRemoteAtom)
  const vaults = useAtomValue(vaultsAtom)
  const renameNote = useSetAtom(renameNoteAtom)
  const createNote = useSetAtom(createNoteAtom)
  const moveNotes = useSetAtom(moveNotesAtom)
  const copyNotes = useSetAtom(copyNotesAtom)
  const deleteMany = useSetAtom(deleteManyAtom)
  const getBackrefs = useSetAtom(backrefsForMany)

  const [menu, setMenu] = useState<{
    x: number
    y: number
    path: string
    isFolder: boolean
    targets: string[]
  } | null>(null)
  const [confirming, setConfirming] = useState<{
    label: string
    paths: string[]
    refs: { path: string; count: number }[]
  } | null>(null)
  const [pendingFolders, setPendingFolders] = useState<string[]>([])
  const [pending, setPending] = useState<{ kind: 'file' | 'folder'; parent: string } | null>(null)
  // Cut/Copy staging (spec §Cut/Copy). Cut dims its rows; paste consumes a cut,
  // keeps a copy (VS Code pastes a copy repeatedly).
  const [clipboard, setClipboard] = useState<Clipboard>(null)

  const docPaths = useMemo(() => snapshot.docs.map((d) => d.path), [snapshot])
  const data = useMemo(() => buildTreeData(docPaths, pendingFolders), [docPaths, pendingFolders])

  // headless-tree captures config closures once; these refs keep the handlers
  // reading the latest values.
  const dataRef = useRef(data)
  dataRef.current = data
  const docPathsRef = useRef(docPaths)
  docPathsRef.current = docPaths
  const clipboardRef = useRef(clipboard)
  clipboardRef.current = clipboard

  // ── batch action helpers (no `tree` closure — targets come from the caller) ──

  const filesUnder = (targets: string[]): string[] => {
    const out = new Set<string>()
    for (const t of targets) for (const f of expandToFiles(docPathsRef.current, t)) out.add(f)
    return [...out]
  }

  const startDelete = (targets: string[], isFolder: boolean) => {
    const files = filesUnder(targets)
    if (files.length === 0) {
      // Nothing on disk — a transient (empty) folder; just drop it from pending.
      setPendingFolders((f) => f.filter((x) => !targets.includes(x)))
      return
    }
    const label =
      targets.length > 1
        ? `${files.length} notes`
        : isFolder
          ? `${targets[0]}/ (${files.length} note${files.length === 1 ? '' : 's'})`
          : targets[0]!
    void getBackrefs(files).then((refs) => setConfirming({ label, paths: files, refs }))
  }

  const moveInto = (sources: string[], destFolder: string) => {
    const moves = sources
      .flatMap((s) => remapUnder(docPathsRef.current, s, joinPath(destFolder, basename(s))))
      .filter((m) => m.from !== m.to)
    if (moves.length) void moveNotes({ moves })
  }

  const renameFolder = (folder: string, newName: string) => {
    const dest = joinPath(parentOf(folder), newName)
    if (dest === folder) return
    const files = expandToFiles(docPathsRef.current, folder)
    if (files.length === 0) {
      setPendingFolders((f) => f.map((x) => (x === folder ? dest : x)))
      return
    }
    const moves = remapUnder(docPathsRef.current, folder, dest).filter((m) => m.from !== m.to)
    if (moves.length) void moveNotes({ moves })
  }

  const paste = (destFolder: string) => {
    const clip = clipboardRef.current
    if (!clip) return
    if (clip.mode === 'cut') {
      moveInto(clip.paths, destFolder)
      setClipboard(null)
      return
    }
    const claimed = new Set(docPathsRef.current)
    const isTaken = (p: string) => pathTaken(claimed, p)
    const copies: { from: string; to: string }[] = []
    for (const src of clip.paths) {
      const destRoot = freeCopyPath(isTaken, joinPath(destFolder, basename(src)))
      for (const from of expandToFiles(docPathsRef.current, src)) {
        const to = destRoot + from.slice(src.length)
        claimed.add(to)
        copies.push({ from, to })
      }
    }
    if (copies.length) void copyNotes({ copies })
  }

  const duplicate = (targets: string[]) => {
    const claimed = new Set(docPathsRef.current)
    const isTaken = (p: string) => pathTaken(claimed, p)
    const copies: { from: string; to: string }[] = []
    for (const src of targets) {
      const newRoot = freeCopyPath(isTaken, src)
      for (const from of expandToFiles(docPathsRef.current, src)) {
        const to = newRoot + from.slice(src.length)
        claimed.add(to)
        copies.push({ from, to })
      }
    }
    if (copies.length) void copyNotes({ copies })
  }

  // Selection-aware target set from a tree instance: the whole multi-selection
  // when the focused/clicked row is part of it, else just that one row (VS Code).
  const targetsFrom = (t: typeof tree, clickedId?: string): string[] => {
    const sel = t.getSelectedItems().map((i) => i.getId())
    if (clickedId !== undefined) return sel.length > 1 && sel.includes(clickedId) ? sel : [clickedId]
    const focused = t.getFocusedItem()?.getId()
    if (sel.length > 1 && focused && sel.includes(focused)) return sel
    return focused ? [focused] : sel
  }

  // The folder a paste/new-in lands in for a tree instance: the focused folder
  // itself, or the parent of the focused file, or root.
  const destFolderFrom = (t: typeof tree): string => {
    const f = t.getFocusedItem()
    if (!f) return ''
    return f.isFolder() ? (f.getId() === ROOT_ID ? '' : f.getId()) : parentOf(f.getId())
  }

  const tree = useTree<TreeItemData>({
    rootItemId: ROOT_ID,
    initialState: { expandedItems: [ROOT_ID] },
    getItemName: (item) => dataRef.current[item.getId()]?.name ?? '',
    isItemFolder: (item) => dataRef.current[item.getId()]?.isFolder ?? false,
    dataLoader: {
      getItem: (id) => dataRef.current[id] ?? { name: '', isFolder: false, children: [] },
      getChildren: (id) => dataRef.current[id]?.children ?? [],
    },
    indent: 12,
    onPrimaryAction: (item) => {
      if (!item.isFolder()) onOpenPreview(item.getId())
    },
    // Folders rename too now (they fan out to N notes via renameFolder).
    canRename: () => true,
    onRename: (item, value) => {
      const from = item.getId()
      const name = value.trim()
      if (!name) return
      if (item.isFolder()) {
        renameFolder(from, name)
      } else {
        const to = joinPath(parentOf(from), withMdExtension(name))
        if (to !== from) void renameNote({ from, to })
      }
    },
    hotkeys: {
      customDelete: {
        hotkey: 'Delete',
        handler: (_e, t) => {
          const focused = t.getFocusedItem()
          if (focused) startDelete(targetsFrom(t), focused.isFolder())
        },
      },
      customBackspace: {
        hotkey: 'Backspace',
        handler: (_e, t) => {
          const focused = t.getFocusedItem()
          if (focused) startDelete(targetsFrom(t), focused.isFolder())
        },
      },
      // ⌘/Ctrl + X/C/V/D. Tokens are `KeyboardEvent.code`; `metaorcontrol`
      // matches Meta on macOS and Control elsewhere (headless-tree specialKeys).
      cut: {
        hotkey: 'metaorcontrol+KeyX',
        preventDefault: true,
        handler: (_e, t) => setClipboard({ mode: 'cut', paths: targetsFrom(t) }),
      },
      copy: {
        hotkey: 'metaorcontrol+KeyC',
        preventDefault: true,
        handler: (_e, t) => setClipboard({ mode: 'copy', paths: targetsFrom(t) }),
      },
      paste: {
        hotkey: 'metaorcontrol+KeyV',
        preventDefault: true,
        handler: (_e, t) => paste(destFolderFrom(t)),
      },
      duplicate: {
        hotkey: 'metaorcontrol+KeyD',
        preventDefault: true,
        handler: (_e, t) => duplicate(targetsFrom(t)),
      },
    },
    // Drag files AND folders onto a folder = move; multi-drag moves the whole
    // selection as ONE atomic batch (spec §Drag-and-drop). No sibling reorder.
    canReorder: false,
    canDrag: () => true,
    canDrop: (items, target) => {
      const dest = target.item
      if (!dest.isFolder()) return false
      const destPath = dest.getId() === ROOT_ID ? '' : dest.getId()
      return items.every((i) => {
        const id = i.getId()
        if (parentOf(id) === destPath) return false // already there — a no-op
        if (destPath === id || destPath.startsWith(`${id}/`)) return false // into itself/descendant
        return true
      })
    },
    onDrop: (items, target) => {
      const destPath = target.item.getId() === ROOT_ID ? '' : target.item.getId()
      moveInto(
        items.map((i) => i.getId()),
        destPath,
      )
    },
    features: [
      syncDataLoaderFeature,
      selectionFeature,
      hotkeysCoreFeature,
      dragAndDropFeature,
      renamingFeature,
    ],
  })

  // Re-read the whole tree when the snapshot changes (wholesale replace model).
  useEffect(() => {
    tree.rebuildTree()
  }, [data]) // eslint-disable-line react-hooks/exhaustive-deps

  // A transient folder becomes real once the snapshot carries a note inside it.
  useEffect(() => {
    setPendingFolders((f) => f.filter((folder) => !docPaths.some((p) => p.startsWith(`${folder}/`))))
  }, [docPaths])

  const entry = vaults.find((v) => v.remote === activeRemote)
  const absPathFor = (rel: string) => (entry ? `${entry.path}/${rel}` : rel)

  const buildMenu = (path: string, isFolder: boolean, targets: string[]): (MenuItem | 'separator')[] => {
    const folderDest = isFolder ? path : parentOf(path)
    const multi = targets.length > 1
    const items: (MenuItem | 'separator')[] = []
    if (!multi) {
      items.push(
        { label: 'New File…', onSelect: () => setPending({ kind: 'file', parent: folderDest }) },
        { label: 'New Folder…', onSelect: () => setPending({ kind: 'folder', parent: folderDest }) },
        'separator',
        { label: 'Rename…', kbd: 'F2', onSelect: () => tree.getItemInstance(path).startRenaming() },
      )
    }
    items.push(
      { label: 'Delete', kbd: '⌫', danger: true, onSelect: () => startDelete(targets, isFolder) },
      'separator',
      { label: 'Cut', kbd: '⌘X', onSelect: () => setClipboard({ mode: 'cut', paths: targets }) },
      { label: 'Copy', kbd: '⌘C', onSelect: () => setClipboard({ mode: 'copy', paths: targets }) },
      { label: 'Paste', kbd: '⌘V', onSelect: () => paste(folderDest) },
      { label: 'Duplicate', kbd: '⌘D', onSelect: () => duplicate(targets) },
    )
    if (!multi) {
      items.push(
        'separator',
        { label: 'Copy Path', onSelect: () => void navigator.clipboard.writeText(absPathFor(path)) },
        { label: 'Copy Relative Path', onSelect: () => void navigator.clipboard.writeText(path) },
        { label: 'Reveal in Finder', onSelect: () => void window.holi.openPath(absPathFor(path)) },
      )
    }
    return items
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ExplorerHeader
        title={activeRemote?.split('/').at(-1) ?? 'vault'}
        onNewFile={() => setPending({ kind: 'file', parent: '' })}
        onNewFolder={() => setPending({ kind: 'folder', parent: '' })}
        onCollapseAll={() => tree.collapseAll()}
      />
      <div
        className="holi-scroll min-h-0 flex-1 overflow-y-auto py-1 text-sm"
        {...tree.getContainerProps()}
      >
        {pending && (
          <PendingRow
            kind={pending.kind}
            onCancel={() => setPending(null)}
            onCommit={(name) => {
              if (pending.kind === 'folder') {
                setPendingFolders((f) => [...f, joinPath(pending.parent, name)])
              } else {
                void createNote(joinPath(pending.parent, withMdExtension(name)))
              }
              setPending(null)
            }}
          />
        )}
        {tree
          .getItems()
          .filter((item) => item.getId() !== ROOT_ID)
          .map((item) => {
            const id = item.getId()
            const isFolder = item.isFolder()
            const isOpen = activePath === id
            const level = item.getItemMeta().level
            const isCut = clipboard?.mode === 'cut' && clipboard.paths.includes(id)
            const rowProps = item.getProps()
            const origClick = rowProps.onClick as ((e: unknown) => void) | undefined
            return (
              <div
                key={id}
                {...rowProps}
                onClick={(e) => {
                  origClick?.(e)
                  // A plain click opens a preview; a modified click is a
                  // selection gesture (⌘/⇧) and must not open anything.
                  if (!isFolder && !e.metaKey && !e.shiftKey && !e.ctrlKey) onOpenPreview(id)
                }}
                onDoubleClick={() => {
                  if (!isFolder) onOpenPinned(id)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  const sel = tree.getSelectedItems().map((it) => it.getId())
                  const targets = sel.length > 1 && sel.includes(id) ? sel : [id]
                  setMenu({ x: e.clientX, y: e.clientY, path: id, isFolder, targets })
                }}
                style={{ paddingLeft: `${level * 12 + 8}px` }}
                className={[
                  'flex h-[22px] items-center gap-1 rounded pr-2 outline-none transition-colors',
                  item.isSelected()
                    ? 'bg-neutral-800 text-neutral-100'
                    : 'text-neutral-300 hover:bg-neutral-800/60',
                  isOpen ? 'text-sky-300' : '',
                  item.isDragTarget() ? 'bg-sky-500/20 ring-1 ring-inset ring-sky-500/60' : '',
                  isCut ? 'opacity-40' : '',
                ].join(' ')}
              >
                <span className="flex w-4 shrink-0 justify-center text-neutral-500">
                  {isFolder ? <ChevronIcon open={item.isExpanded()} /> : null}
                </span>
                <span
                  className={`flex w-4 shrink-0 justify-center ${isOpen ? 'text-sky-400' : 'text-neutral-500'}`}
                >
                  {isFolder ? <FolderIcon /> : <MarkdownIcon />}
                </span>
                {item.isRenaming() ? (
                  <input
                    {...item.getRenameInputProps()}
                    autoFocus
                    className="min-w-0 flex-1 rounded border border-sky-700 bg-neutral-900 px-1 text-sm outline-none"
                    onFocus={(e) => {
                      const el = e.currentTarget
                      const [s, end] = renameBasenameRange(el.value)
                      setTimeout(() => el.setSelectionRange(s, end), 0)
                    }}
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate">{item.getItemName()}</span>
                )}
              </div>
            )
          })}
        {tree.getItems().filter((item) => item.getId() !== ROOT_ID).length === 0 && (
          <p className="px-2 text-xs text-neutral-500">no notes yet</p>
        )}
      </div>

      {menu && (
        <TreeContextMenu
          x={menu.x}
          y={menu.y}
          items={buildMenu(menu.path, menu.isFolder, menu.targets)}
          onClose={() => setMenu(null)}
        />
      )}
      {confirming && (
        <DeleteConfirm
          label={confirming.label}
          refs={confirming.refs}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const paths = confirming.paths
            setConfirming(null)
            void deleteMany({ paths })
          }}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/desktop && pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c error`
Expected: `36`. If headless-tree complains about the `typeof tree` self-reference in `targetsFrom`/`destFolderFrom` (used before `tree` is declared as a *value*, though only its *type* is referenced), replace `t: typeof tree` with the concrete instance type — import `TreeInstance` from `@headless-tree/core` and use `t: TreeInstance<TreeItemData>`. Confirm the exact exported name against `node_modules/@headless-tree/core/dist/index.d.ts` (grep for `TreeInstance`); if it differs, use that name. The two helpers reference only `t`'s methods, so this is the sole typing touch-point.

- [ ] **Step 3: Full test + typecheck guard**

Run: `pnpm exec vitest run` → Expected: all green (prior baseline 555 + the new tests from Tasks 1–8). Typecheck → `36`.

- [ ] **Step 4: Verify live (CDP) — ask the user for the drag checks**

Relaunch the dev app if a main-process edit happened this session (Tasks 2–5 touched main; **relaunch is required** for those, but the tree UI itself hot-reloads). Ensure a vault is open (the app does not auto-open on cold start — run in the renderer if the tree is empty: `window.holi.trpc({path:'vaults.open',type:'mutation',input:{remote:'nthomsencph/a-demo-vault-3'}})`, then touch a vault file to trigger a watcher push).

Verify:
- **Multi-select:** ⌘-click toggles rows, ⇧-click ranges; the selection highlights.
- **Context menu on a selection:** right-clicking a selected row offers Delete/Cut/Copy/Paste/Duplicate acting on the whole set (New/Rename/Copy-Path hidden for multi).
- **Folder rename:** F2 / Rename on a folder renames it and every note under it (check a note that links into the folder — the link rewrites).
- **Folder delete:** shows the summarized preview ("N notes · M inbound links…"); confirming deletes all.
- **Cut+Paste = move; Copy+Paste / Duplicate = new notes** (a duplicated note keeps its `[[links]]` pointing at the originals; a cut+paste rewrites inbound links).
- **Keyboard:** ⌘X/⌘C/⌘V/⌘D and Delete act on the focused row or selection.
- **Drag (ask the user — CDP can't drive HTML5 DnD reliably):** dragging a multi-selection or a folder onto a folder moves the whole set atomically; dropping onto the tree background/root moves to vault root.

```bash
pnpm exec node /tmp/holi-drive.mjs shot "$PWD/../../.brainstorm-shot-phase2.png"
```

Read the screenshot to confirm selection tint, cut-dimming, and drag-target highlight render.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/FileTree.tsx
git commit -m "feat(tree): multi-select, folder ops, DnD, and cut/copy/paste/duplicate

Claude goes brr.. via Dash"
```

---

## Task 11: Final verification + spec status

**Files:**
- Modify: `docs/specs/2026-07-24-file-tree-vscode-design.md` (status line)

- [ ] **Step 1: Full gates**

Run, from `apps/desktop`:

```bash
pnpm exec vitest run
pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c error
pnpm exec electron-vite build 2>&1 | tail -3
```

Also run the shared suite:

```bash
cd ../../packages/shared && pnpm exec vitest run
```

Expected: all tests green (desktop 555 + the new tests; shared green); desktop typecheck `36`; `electron-vite build` succeeds.

- [ ] **Step 2: Live smoke of the whole Phase-2 surface**

Confirm end-to-end in the running app (per Task 10 Step 4), plus a regression pass of Phase 1 (single-file open/rename/delete, inline create, transient folders, single-file drag) to be sure nothing regressed.

- [ ] **Step 3: Mark the spec delivered**

In `docs/specs/2026-07-24-file-tree-vscode-design.md`, update the status line near the top from `Design approved, pre-plan` to:

```
**Status:** Delivered — Phase 1 (`docs/plans/2026-07-24-file-tree-vscode.md`) + Phase 2 (`docs/plans/2026-07-25-file-tree-vscode-phase2.md`)
```

- [ ] **Step 4: Commit**

```bash
git add docs/specs/2026-07-24-file-tree-vscode-design.md
git commit -m "docs(tree): mark the VS Code file-tree spec delivered

Claude goes brr.. via Dash"
```

---

## Self-review notes

- **Spec coverage (Phase 2 slice):**
  - Multi-select (⌘/⇧-click) wired to context-menu/delete/drag ✓ (T10, on `selectionFeature`).
  - Folder rename / delete / move ✓ (T10 `renameFolder`/`startDelete`/drag, fanning out via `remapUnder` + `moveNotesAtom`/`deleteManyAtom`).
  - Drag folders + atomic multi-note moves ✓ (T10 `canDrag: () => true`, `onDrop` → one `moveInto` → one `moveNotesAtom`).
  - Cut / Copy / Paste / Duplicate ✓ (T10 clipboard + `paste`/`duplicate`; cut→move, copy/duplicate→`copyNotesAtom`, no link rewrite).
  - Batch tRPC backend ✓: `notes.move` single-pass rewrite (T1 primitive + T2 helper + T5 procedure, TDD'd incl. the chain case), `notes.copy` (T3/T5), `notes.deleteMany` (T5), `notes.backrefsMany` (T4/T5). Renderer wraps each in flush→commit→op→commit, one commit-pair (T8).
  - Delete preview for folder/multi excludes internal links ✓ (T4 `scanBackrefsMany`, T9 dialog).
  - Conflicts refused (move/copy clobber) ✓ (T5 router, T5 tests).
  - Hidden roots never valid drop targets ✓ (they are filtered out of `buildTreeData`, so they are not items and cannot be a drop `target`; a move whose dest is a hidden root can't be produced from the UI).
  - Open tab follows a moved note / clears on delete ✓ (T7 `retargetTabs`/`closeTabsForPaths`, wired in T8).
- **Known Phase-1 gap carried forward, now resolved:** rename caret pre-select still uses the `onFocus`+`setTimeout` workaround (T10 keeps it); folders rename too now.
- **Type consistency:** the batch shapes are `{ from: string; to: string }[]` (moves/copies) and `string[]` (paths/deleteMany/backrefsMany) end-to-end — router validators (`movesInput`/`copiesInput`/`pathsInput`), atoms (`moveNotesAtom`/`copyNotesAtom`/`deleteManyAtom`/`backrefsForMany`), and helpers (`remapUnder`/`expandToFiles`/`freeCopyPath`) all agree. `DeleteConfirm` is `{ label, refs }` (T9) and every call site passes exactly that (T10).
- **Library-API touch-points to confirm against installed types (isolated, one place each):** `tree.getSelectedItems()`, `tree.getFocusedItem()`, `tree.getItemInstance(id).startRenaming()`, `tree.collapseAll()`, `item.isDragTarget()`, and the `hotkeys` token syntax `metaorcontrol+KeyX` (verified in the bundle: `specialKeys.metaorcontrol` + code-name letters). The only likely typecheck fix is the `typeof tree` self-reference in `targetsFrom`/`destFolderFrom` → swap for the concrete `TreeInstance<TreeItemData>` type (T10 Step 2).
- **Placeholder scan:** none — every step carries the real code or the exact command + expected output.
