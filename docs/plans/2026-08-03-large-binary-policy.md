# Large-binary / vault-size policy Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep oversized files out of the vault's git history — held back from Holi's autosave commit and rejected by a seeded git pre-commit hook — so nothing large auto-publishes, with a callout to commit-anyway or keep-local.

**Architecture:** A pure `partitionBySize` splits the autosave's dirty paths into commit vs held-back at a configurable threshold; `commitAll` stages only the commit paths; the sync loop treats the tree as clean when only held-back files remain; a callout surfaces held-back files with per-file actions; a machine-local pre-commit hook (regenerated on vault open) covers the agent's direct commits.

**Tech Stack:** TypeScript, git (porcelain), Node `fs`, jotai + tRPC over the IPC link, Vitest (node project for main/pure logic in `apps/desktop/test/`, dom for the callout).

**Spec:** `docs/specs/2026-08-03-large-binary-policy-design.md`. Read it first.

---

## File map

- `apps/desktop/src/main/vault/large-files.ts` *(new)* — `partitionBySize` (pure) + `DEFAULT_MAX_COMMITTED_FILE_BYTES` + the pre-commit hook template + `installGitHook`.
- `apps/desktop/src/main/vault/vault-settings.ts` *(new)* — `readMaxCommittedFileBytes(root)`; minimal `.holi/settings.json` read (mirrors `reminders/delivered-log.ts`).
- `apps/desktop/src/main/git.ts` — `commitAll(message, paths)` takes an explicit pathspec.
- `apps/desktop/src/main/vault/active-vault.ts` — `maybeCommit` stats + partitions + commits real-dirty; holds the held-back set; pushes it; installs the hook on open.
- `apps/desktop/src/main/router.ts` — `vaults.commitFile` + `vaults.keepFileLocal`.
- `apps/desktop/src/main/index.ts` + `preload/index.ts` + `renderer/.../global.d.ts` — the `vault:heldback` push binding.
- `apps/desktop/src/renderer/src/state/vaults.ts` — `heldBackAtom`.
- `apps/desktop/src/renderer/src/components/Shell.tsx` — the held-back callout (reuse the config-conflict banner pattern already there).
- Tests: `apps/desktop/test/large-files.test.ts`, `vault-settings.test.ts` *(new)*; extend `router.test.ts`, `active-vault.test.ts`.

## Contracts

```ts
// large-files.ts
export const DEFAULT_MAX_COMMITTED_FILE_BYTES = 10 * 1024 * 1024 // 10 MB

export interface HeldBackFile { path: string; bytes: number }

/** Split dirty paths into what to commit vs what to hold back. `sizeOf` returns
 *  the working-tree byte size, or null for a path with no file (a deletion) —
 *  which always commits. Pure: the async stat happens in the caller. */
export function partitionBySize(
  dirtyPaths: string[],
  sizeOf: (path: string) => number | null,
  threshold: number,
): { commit: string[]; heldBack: HeldBackFile[] }

// vault-settings.ts
export function readMaxCommittedFileBytes(root: string): Promise<number>

// git.ts — CHANGED signature
commitAll(message: string, paths: string[]): Promise<string | null>
//   stages exactly `paths` (`git add -A -- <paths>`), commits if anything staged, else null.

// active-vault SyncState is unchanged; held-back rides a separate push:
// channel 'vault:heldback' → { remote: string; files: HeldBackFile[] }
```

## Gotchas (load-bearing)

1. **Sync-state must stay honest.** Held-back files remain untracked, so `status.dirty` stays true. `maybeCommit` must compute `realDirty = dirtyPaths − heldBack` and, when `realDirty` is empty, **return without committing and leave the state up-to-date** — otherwise the loop spins and the footer pegs "not up to date". `computeState` needs no new branch (it already never surfaces plain dirtiness); the fix is entirely in `maybeCommit`'s guard.
2. **Deletions always commit.** A deleted path has no working-tree file → `sizeOf` returns null → it goes in `commit`. Never hold back a deletion (it shrinks history, never grows it).
3. **`git add -A -- <paths>`**, not `git add -A`. The `-- <paths>` limits staging to the safe set; the oversized untracked file is simply never named, so it stays untracked.
4. **Hook lives in `.git/hooks/`, not the repo.** Not committed/synced — install it machine-locally on vault open, regenerated each time so a threshold change re-installs. The resolved byte limit is written into the script (no config read from inside the hook).
5. **Commit-anyway bypasses the hook** (`git commit --no-verify`) — the one deliberate override. Holi's ordinary selective-add never stages an oversized file, so it never needs `--no-verify`.
6. **Keep-local writes `.git/info/exclude`** (append the path), not `.gitignore` — machine-local, no shared-ignore pollution. After it, `git status` stops listing the file, so it leaves the held-back set naturally.
7. **Node-test locations** (memory `holi-node-tests-live-outside-src`): pure/main logic tests go in `apps/desktop/test/*.test.ts` (node project). Run the full node suite before done.

---

## Slice 1 — pure partition + threshold reader

### Task 1: `partitionBySize`

**Files:** Create `apps/desktop/src/main/vault/large-files.ts`; Test `apps/desktop/test/large-files.test.ts`.

- [ ] **Write failing tests** covering: a >threshold file → `heldBack` with its bytes; a ≤threshold file and a file exactly at threshold → `commit`; a null-size path (deletion) → `commit`; empty input → both empty.

```ts
import { partitionBySize, DEFAULT_MAX_COMMITTED_FILE_BYTES } from '../src/main/vault/large-files'

const sizes: Record<string, number | null> = {
  'big.mp4': 20_000_000, 'small.md': 100, 'exactly.bin': 10, 'gone.md': null,
}
const sizeOf = (p: string) => sizes[p] ?? null

it('holds back only files strictly over the threshold; deletions always commit', () => {
  const { commit, heldBack } = partitionBySize(['big.mp4', 'small.md', 'exactly.bin', 'gone.md'], sizeOf, 10)
  expect(commit.sort()).toEqual(['exactly.bin', 'gone.md', 'small.md'])
  expect(heldBack).toEqual([{ path: 'big.mp4', bytes: 20_000_000 }])
})
it('default threshold is 10 MB', () => {
  expect(DEFAULT_MAX_COMMITTED_FILE_BYTES).toBe(10 * 1024 * 1024)
})
```

- [ ] Run `pnpm exec vitest run --project node test/large-files.test.ts` → FAIL (module missing).
- [ ] **Implement** `partitionBySize`: iterate; `const b = sizeOf(p)`; `b !== null && b > threshold` → push `{path, bytes: b}` to heldBack, else push `p` to commit. Export `DEFAULT_MAX_COMMITTED_FILE_BYTES`.
- [ ] Run → PASS.
- [ ] Commit: `feat(vault): pure partitionBySize for the large-file gate`.

### Task 2: threshold reader

**Files:** Create `apps/desktop/src/main/vault/vault-settings.ts`; Test `apps/desktop/test/vault-settings.test.ts`. Pattern: `reminders/delivered-log.ts` reads `.holi/settings.local.json` — mirror its JSON read, but from `.holi/settings.json`.

- [ ] **Write failing tests** (real tmpdir): no file → default; `{ "maxCommittedFileBytes": 5242880 }` → 5 MB; malformed JSON or a non-number/negative value → default.
- [ ] Run → FAIL.
- [ ] **Implement** `readMaxCommittedFileBytes(root)`: read `join(root, '.holi', 'settings.json')`; `JSON.parse`; if `typeof v.maxCommittedFileBytes === 'number' && v.maxCommittedFileBytes > 0` return it, else `DEFAULT_MAX_COMMITTED_FILE_BYTES`; any throw → default.
- [ ] Run → PASS.
- [ ] Commit: `feat(vault): read maxCommittedFileBytes from .holi/settings.json`.

---

## Slice 2 — core hold-back (shippable on its own)

### Task 3: `commitAll` takes an explicit pathspec

**Files:** Modify `git.ts` (`commitAll` at ~558; interface at ~176). Update callers.

- [ ] **Update tests first** — any `commitAll(msg)` test call becomes `commitAll(msg, paths)`; add a case: `commitAll('m', ['a.md'])` with `a.md` and `b.md` both dirty commits only `a.md` (`changedFiles`/status shows `b.md` still dirty). Grep callers: `grep -rn "commitAll(" apps/desktop`.
- [ ] Run affected git tests → FAIL.
- [ ] **Implement:** signature `commitAll(message: string, paths: string[])`. Body: `if (paths.length === 0) return null`; `await runGit(root, ['add', '-A', '--', ...paths], opts)`; if nothing became staged (`git diff --cached --quiet` exits 0) return null; else commit + return HEAD. Keep the deletions-ride-along comment (now scoped to `paths`).
- [ ] Update the one production caller (`active-vault.ts:303`) provisionally to `commitAll(msg, status.dirtyPaths)` (Task 4 refines it).
- [ ] Run → PASS.
- [ ] Commit: `refactor(git): commitAll stages an explicit pathspec`.

### Task 4: hold back oversized files in the autosave loop

**Files:** Modify `active-vault.ts` (`maybeCommit` ~275–316; add held-back state + a `heldBack()` accessor and an `onHeldBack` push arg). Test `apps/desktop/test/active-vault.test.ts`.

- [ ] **Write failing tests** (the file's real-git rig): dropping a >threshold file plus editing a note commits the note, leaves the big file uncommitted, and reports sync state **up-to-date** (not perpetually dirty); a second tick does not create an empty commit. Assert `host`/vault exposes the held-back file (`{path, bytes}`).
- [ ] Run → FAIL.
- [ ] **Implement** in `maybeCommit`, after `const status = await args.repo.status()`:
  - stat each `status.dirtyPaths` (`Promise.all` of `stat(join(root, p)).then(s=>s.size).catch(()=>null)`) into a `Map`;
  - `const { commit, heldBack } = partitionBySize(status.dirtyPaths, p => map.get(p) ?? null, threshold)` where `threshold` is read once per open (cache it; re-read on open) via `readMaxCommittedFileBytes`;
  - store `heldBack` on the vault and fire the `onHeldBack` callback (even when empty, so the callout clears);
  - guard: `if (blockedReason(status) !== null || commit.length === 0) { setState(computeState(status)); return null }` — an all-held-back tree is clean;
  - `const sha = await args.repo.commitAll(commitMessage(commit), commit)`.
- [ ] Run → PASS.
- [ ] Commit: `feat(vault): hold oversized files out of the autosave commit (FR: large-binary)`.

---

## Slice 3 — held-back surface

### Task 5: push held-back to the renderer

**Files:** Modify `active-vault.ts` (wire `onHeldBack` through `createVaultHost` args like `onSyncState`); `index.ts` (`onHeldBack: (files) => send('vault:heldback', { remote, files })`); `preload/index.ts` (`onHeldBack` binding, mirror `onSyncState`); `renderer/.../global.d.ts`; `renderer/.../state/vaults.ts` (`heldBackAtom: atom<HeldBackFile[]>([])`, set from the push in the same effect that subscribes to `onSyncState`).

- [ ] **Implement** the plumbing (mirror the existing `vault:sync` / `onSyncState` wiring end-to-end). `HeldBackFile` type shared from `large-files.ts` (import type in the renderer, erased at compile — same pattern as `SyncState`).
- [ ] **Test** (`apps/desktop/test/`): a held-back file in the rig results in a `vault:heldback` send with the right `{remote, files}`. Typecheck: `pnpm exec node node_modules/typescript/bin/tsc --noEmit` → 0.
- [ ] Commit: `feat(vault): push the held-back set to the renderer`.

### Task 6: the callout + commit-anyway / keep-local

**Files:** Modify `router.ts` (two procedures); `Shell.tsx` (callout). Test `router.test.ts`.

- [ ] **Write failing router tests:** `vaults.commitFile({remote, path})` stages + commits that one path (even over-size — uses `--no-verify`), so it is no longer dirty; `vaults.keepFileLocal({remote, path})` appends the path to `.git/info/exclude` and the file stops showing in `status`.
- [ ] Run → FAIL.
- [ ] **Implement** procedures via `rootFor(remote)` + `safe(path)`:
  - `commitFile`: `openRepo(root).commitFileNoVerify(path)` — add a small git method `commitFileNoVerify(path)` = `git add -- <path>` then `git ... commit --no-verify -m "Add <path>"`; return HEAD.
  - `keepFileLocal`: append `\n<path>\n` to `join(root, '.git', 'info', 'exclude')` (create if absent).
- [ ] Run → PASS.
- [ ] **Add the callout** in `Shell.tsx` (above the footer, beside the config-conflict banner): when `heldBack.length > 0`, a destructive-toned row per file — `path` + humanized size + **Commit anyway** (`trpc.vaults.commitFile`) and **Keep local** (`trpc.vaults.keepFileLocal`). Wire `heldBackAtom`. Live-check note (UI ceiling).
- [ ] Typecheck + `pnpm exec vitest run --project dom` → green.
- [ ] Commit: `feat(vault): held-back callout with commit-anyway / keep-local (FR: large-binary)`.

---

## Slice 4 — agent coverage (pre-commit hook)

### Task 7: seed + install the pre-commit hook

**Files:** Modify `large-files.ts` (hook template + `installGitHook(root, threshold)`); `active-vault.ts` (call it in the vault-open path — `openActiveVault`, once, after `openRepo`). Test `apps/desktop/test/large-files.test.ts` (run the generated script against a real repo).

- [ ] **Write failing tests:** `installGitHook(root, 10)` writes an executable `.git/hooks/pre-commit`; staging an 11-byte file and running the hook exits non-zero with a message naming the file; staging a small file exits 0. (Init a real repo in a tmpdir; run the hook via `execFile('sh', [hookPath])` with the file staged.)
- [ ] Run → FAIL.
- [ ] **Implement** `installGitHook(root, threshold)`: write this script (with `<LIMIT>` replaced by `threshold`) to `.git/hooks/pre-commit`, `chmod 0o755`:

```sh
#!/bin/sh
# Holi large-file guard (auto-generated; set maxCommittedFileBytes in .holi/settings.json).
limit=<LIMIT>
offenders=$(git diff --cached --name-only --diff-filter=AM | while IFS= read -r f; do
  [ -f "$f" ] || continue
  size=$(wc -c < "$f" | tr -d ' ')
  [ "$size" -gt "$limit" ] && printf '  %s (%s bytes)\n' "$f" "$size"
done)
if [ -n "$offenders" ]; then
  echo "Holi: refusing to commit files over $limit bytes:" >&2
  echo "$offenders" >&2
  echo "Keep them local, set up Git LFS, or 'git commit --no-verify' to override." >&2
  exit 1
fi
```

  Note the line-based read is a backstop for the agent (a filename containing a newline is not handled — acceptable; Holi's own selective-add uses NUL). `--diff-filter=AM` skips deletions.
- [ ] Call `installGitHook(root, threshold)` in `openActiveVault` (regenerated every open, so a threshold change re-installs).
- [ ] Run → PASS.
- [ ] Commit: `feat(vault): seed a pre-commit hook so the agent hits the same large-file gate`.

---

## Slice 5 — verification

### Task 8: full sweep + docs

- [ ] `apps/desktop`: typecheck; dom; node (~120s, background it). `packages/shared`: `vitest run`. All green.
- [ ] Document `maxCommittedFileBytes` where vault config is documented (the agent theme `SKILL.md` sits near vault config; add a one-line mention wherever `.holi/settings.json` keys are listed — grep for an existing settings doc; if none, add a short `.holi/settings.json` note to `docs/prd/vaults-sync.md`).
- [ ] Hand the user the live-check list: drop a >10 MB file → callout appears, note still syncs, footer stays "up to date"; Commit-anyway syncs it; Keep-local stops it showing; agent `git commit` of a big file is rejected by the hook.

---

## Self-review

- **Spec coverage:** hold-back selective-add → T3/T4; threshold config → T2; pre-commit hook → T7; held-back callout + commit-anyway/keep-local → T6; sync-state honesty → T4 (Gotcha 1); `.git/info/exclude` keep-local → T6 (Gotcha 6). All spec sections mapped.
- **Type consistency:** `partitionBySize`/`HeldBackFile`/`commitAll(message, paths)`/`readMaxCommittedFileBytes`/`vault:heldback` used consistently T1→T7.
- **Out of scope (per spec):** Git-LFS auto-setup (hook only points at it), per-file tree badges, history scrubbing, round-tripping.
