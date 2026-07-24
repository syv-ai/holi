# Auto-push, drop Publish — Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove "publish" as a product concept — local commits push automatically on a coalescing timer plus the leave points — so there is no Publish button, no `publish()` op, no `N to publish`/`publishing` state.

**Architecture:** The commit loop is unchanged (D60). A new **push coalescer** in `active-vault.ts` fires a background `pushNow()` on a ~15s debounce, armed by every commit that lands a sha; explicit `pushNow()` fires on the points where a commit has already landed (⌘S, vault switch, quit, vault open, focus, clean merge). A non-fast-forward rejection recovers optimistically by pulling inline and retrying, funnelling a conflict into the **existing** conflict/reconcile path. Network failure surfaces as `offline — N waiting`; permission failure as `no write access` (FR-16 survives).

**Tech stack:** TypeScript, Electron main + preload + React renderer, tRPC-over-IPC, Vitest against real git repos (`test/helpers/git-fixtures`).

**Design source:** `docs/specs/2026-07-24-auto-push-drop-publish-design.md`, decision **D61** in `docs/decisions.md`.

**Baselines to hold:** desktop suite green (was 538), `electron-vite build` succeeds. Typecheck has 36 pre-existing errors in the unbuilt agent/history areas — this plan must not add to them (and removes none; history.ts is the next slice).

---

## Contracts (what changes shape)

### `SyncState` (`main/vault/active-vault.ts`)
**Before:** `up-to-date | ahead{count} | pulling | publishing | offline | conflict{paths} | reconciling | paused{reason}`
**After:**
```ts
export type SyncState =
  | { kind: 'up-to-date' }
  | { kind: 'pulling' }
  | { kind: 'offline'; count: number }   // count = commits waiting; only shown when a push is failing
  | { kind: 'no-access' }                // FR-16: push rejected for permission
  | { kind: 'conflict'; paths: string[] }
  | { kind: 'reconciling' }
  | { kind: 'paused'; reason: string }
```
Removed: `ahead`, `publishing`. `offline` gains `count`. `no-access` is new. Resting `ahead>0` is **not** a state — it reads `up-to-date` (the remote is current within seconds by design; the count is information only when sync is *failing*).

### `ActiveVault` interface (`main/vault/active-vault.ts`)
- **Remove:** `publish(): Promise<PullResult | PushResult>`.
- **Add:** `pushNow(): Promise<void>` — best-effort push with optimistic non-ff recovery; never rejects (catches internally), so it is safe to `Promise.race` against a timeout.

### `GitRepo` interface (`main/git.ts`)
- **Remove:** `publish(): Promise<PullResult | PushResult>` and its impl. `pull`, `push`, `classifyPushFailure`, `status`, `log`, `commitAll`, `abortMerge` stay.

### `SyncTimings` (`main/vault/active-vault.ts`)
Add:
- `pushQuietMs: number` — coalesce debounce. Default **15_000**.
- `pushBudgetMs: number` — race budget for quit / vault-switch pushes. Default **1_000**.

### Router (`main/router.ts`)
- **Remove** `sync.publish`.
- **Add** `sync.pushNow: mutation(() => activeOrThrow().pushNow())` returning `{ ok: true }` — the ⌘S immediate-push trigger.

---

## Gotchas (all found in this codebase, do not rediscover)

1. **`index.lock` contention.** `commit`, `status`, and `merge` all take `.git/index.lock`; `push` does not, but its optimistic-recovery *pull* does. The existing single-flight discipline is `pullInFlight` / `committing`, claimed **synchronously before the first await** (`maybePull` comment). `pushNow` adds `pushInFlight` with the same rule.
2. **The recovery pull must not deadlock against `pushInFlight`.** `pushNow` releases `pushInFlight` immediately before calling `maybePull()` — there is no `await` between the release and `maybePull`'s synchronous claim of `pullInFlight`, so no other push can slip in. Do **not** add `pushInFlight` to `maybePull`'s guard (it would deadlock the recovery); **do** add it to `maybeCommit`'s `!duringPull` guard.
3. **A conflict naming no paths is not a conflict.** `maybePull` already refuses to latch FR-12's sticky pause on `{kind:'conflict', paths:[]}` (a merge refused before it started). The recovery path inherits this for free by delegating to `maybePull` — do not re-classify push-rejection conflicts yourself.
4. **`offline` is a flag, not a state.** Set inside a `catch`, never in the `finally`, so the `finally`'s `refreshState()` cannot overwrite it. Same for `permissionDenied`. Both clear on a successful push; `offline` also clears on a successful pull (existing).
5. **`isIndexLockError` is not offline.** A five-retry index-lock failure is contention, not the network (`maybePull` catch). `pushNow` uses the same `if (!isIndexLockError(err)) offline = true`.
6. **`setState` only pushes on change** (JSON-compare). The open path already sends one unconditional `args.onSyncState(state)` because the renderer holds one state for the whole app — leave that line intact.
7. **electron-vite does not typecheck.** A main-process edit does **not** hot-restart the app (memory [[holi-ui-verification-ceiling]]); relaunch to verify main behaviour over CDP.
8. **Blur/tab-close flush to disk but do not commit synchronously** (`EditorPane` `onBlur = () => void flush()`; unmount flushes). Their commit lands via the loop afterward, so they are covered by the coalescer (armed on sha), **not** an immediate push. ⌘S is different: the renderer `await`s `save()` then `commitNow`, so the commit has landed and an immediate `pushNow` includes it.

---

## Task 1: Remove `GitRepo.publish`

**Files:**
- Modify: `src/main/git.ts` (interface `GitRepo`, the `publish` impl ~line 468, the return object ~line 598)
- Test: `test/git.test.ts` (`describe('publish')` ~line 448)

- [ ] **Step 1 — Delete the `publish` test block.** Remove `describe('publish', …)` in `test/git.test.ts` (the two tests: pushes when clean-ahead; returns conflict on divergence). `push` and `pull` describe blocks stay and already cover both underlying ops.

- [ ] **Step 2 — Run the suite to confirm it still references nothing removed.**
Run: `pnpm exec vitest run git` in `apps/desktop`
Expected: PASS (publish tests gone, push/pull green).

- [ ] **Step 3 — Remove `publish` from `git.ts`:** the `publish(): Promise<PullResult | PushResult>` line in the `GitRepo` interface, the `async function publish()` impl, and `publish` from the final `return { … }`. Leave `PullResult`/`PushResult` types (still used by `pull`/`push`).

- [ ] **Step 4 — Run git tests + typecheck-scan the file.**
Run: `pnpm exec vitest run git` then `pnpm exec tsc --noEmit 2>&1 | grep git.ts`
Expected: git tests PASS; no new `git.ts` typecheck errors (callers still compile because `active-vault.publish` is removed in Task 4 — until then it errors; acceptable *only if* Task 4 follows before final verify. To keep this commit green, do Step 5 note).

- [ ] **Step 5 — Keep the tree green:** because `active-vault.ts`'s `publish()` still calls `args.repo.publish()`, this task's commit would break typecheck. **Do Task 1 and Task 4's `active-vault.publish` removal in the same commit** if you want each commit green; otherwise sequence Task 4 immediately after and commit once. Recommended: commit Tasks 1+4 together (see Task 4 Step 6).

---

## Task 2: The push coalescer + `pushNow` (additive)

Add the new push machinery *alongside* the existing `publish()` so tests stay green while it lands. `publish()` is removed in Task 4.

**Files:**
- Modify: `src/main/vault/active-vault.ts`
- Test: `test/active-vault.test.ts` (new `describe('ActiveVault — auto-push')`)

- [ ] **Step 1 — Add timings.** In `SyncTimings` add `pushQuietMs` and `pushBudgetMs`; in `DEFAULT_TIMINGS` set `pushQuietMs: 15_000, pushBudgetMs: 1_000`.

- [ ] **Step 2 — Write the first failing test: a landed commit pushes within the coalesce window.** In `test/active-vault.test.ts`, in the `ActiveVault — sync` area, use the `withTeammate` helper (bare origin + a teammate clone). Open the vault with `{ pushQuietMs: 150, pullIntervalMs: 60_000, healIntervalMs: 60_000, commitQuietMs: 60 }`. Write a note, wait for the local commit, then assert the **origin** (or teammate after fetch) receives it:
```ts
it('pushes a landed commit to the remote on the coalesce timer', async () => {
  const { active, dir, teammate } = await withTeammate({ pushQuietMs: 120, commitQuietMs: 60 })
  await writeFile(join(dir, 'mine.md'), 'auto-pushed\n', 'utf8')
  await waitFor('the commit to reach origin', async () => {
    await plainGit(teammate, ['fetch', 'origin'])
    return (await plainGit(teammate, ['log', 'origin/main', '--oneline']).catch(() => '')).includes('mine.md')
  })
})
```
Run: `pnpm exec vitest run active-vault -t "coalesce timer"` → FAIL (no push happens yet).

- [ ] **Step 3 — Implement `pushInFlight`, `permissionDenied`, `pushNow`, `schedulePush`.** In `openActiveVault`:
  - Declare `let pushInFlight = false`, `let permissionDenied = false`, `let pushTimer: NodeJS.Timeout | null = null`.
  - `pushNow()` per the contract and gotchas 1–5: guard `if (closed || manualPause !== null || conflictPaths !== null) return; if (pushInFlight || pullInFlight || committing) return;` then claim `pushInFlight = true`, `try { let result = await args.repo.push(); if (rejected && non-fast-forward) { pushInFlight = false; const pulled = await maybePull(); if (pulled?.kind !== 'merged') return; pushInFlight = true; result = await args.repo.push() } if (pushed || nothing-to-push) { offline = false; permissionDenied = false } else if (rejected && permission) { permissionDenied = true } } catch (err) { console.error('[vault] push failed:', err); if (!isIndexLockError(err)) offline = true } finally { pushInFlight = false; await refreshState() }`.
  - `schedulePush()`: `if (closed) return; if (pushTimer) clearTimeout(pushTimer); pushTimer = setTimeout(() => { pushTimer = null; void pushNow() }, timings.pushQuietMs)`.
  - In `maybeCommit`, after a successful `commitAll` returns a non-null `sha`, call `schedulePush()` before `return sha`.
  - Add `pushInFlight` to `maybeCommit`'s guard: `if ((pullInFlight || pushInFlight) && !duringPull) return null`.

- [ ] **Step 4 — Run the test.**
Run: `pnpm exec vitest run active-vault -t "coalesce timer"` → PASS.

- [ ] **Step 5 — Write the failing test: optimistic recovery from a non-fast-forward push.** Teammate publishes a commit; locally make and commit a change; call `pushNow()`; assert it pulled-then-pushed and both survive, ending clean and up to date:
```ts
it('recovers from a non-fast-forward push by pulling then retrying', async () => {
  const { active, dir, teammate } = await withTeammate({ pushQuietMs: 60_000 })
  await theyPublish(teammate, 'theirs.md', 'theirs\n')       // remote moves
  await writeFile(join(dir, 'mine.md'), 'mine\n', 'utf8')
  await active.commitNow()                                   // local commit, diverged
  await active.pushNow()
  await plainGit(teammate, ['fetch', 'origin'])
  const log = await plainGit(teammate, ['log', 'origin/main', '--oneline'])
  expect(log).toContain('mine.md'); expect(log).toContain('theirs.md')
  expect(active.syncState().kind).toBe('up-to-date')
})
```
Run: `-t "non-fast-forward"` → FAIL first (unimplemented) — but Step 3 already implements recovery, so this may pass immediately; if so, keep it as a regression guard and note it verified the recovery branch.

- [ ] **Step 6 — Write the failing test: a diverged push whose pull conflicts routes to the conflict state, pushing nothing.** Both sides touch the same file:
```ts
it('routes a conflicting recovery pull into the conflict state and pushes nothing', async () => {
  const { active, dir, teammate } = await withTeammate({ pushQuietMs: 60_000 })
  await theyPublish(teammate, 'README.md', '# Theirs\n')
  await writeFile(join(dir, 'README.md'), '# Mine\n', 'utf8')
  await active.commitNow()
  await active.pushNow()
  expect(active.syncState()).toMatchObject({ kind: 'conflict', paths: ['README.md'] })
  await plainGit(teammate, ['fetch', 'origin'])
  expect(await plainGit(teammate, ['log', 'origin/main', '--oneline'])).not.toContain('Mine')
})
```
Run: `-t "conflicting recovery"` → PASS (delegates to `maybePull`, which sets `conflictPaths`).

- [ ] **Step 7 — Write the failing test: network failure shows `offline` with the waiting count.** Use a fake repo whose `push` throws a non-lock error and whose `status` reports `ahead`:
```ts
it('shows offline with the waiting count when a push cannot reach the remote', async () => {
  const { active } = await withFakeRepo({
    status: async () => ({ ...cleanStatus, ahead: 2 }),
    push: async () => { throw new Error('could not resolve host: github.com') },
  })
  await active.pushNow()
  expect(active.syncState()).toEqual({ kind: 'offline', count: 2 })
})
```
(Model the fake on the existing `{ ...real, publish: … }` override at test line ~779.)
Run: `-t "offline with the waiting count"` → FAIL until Task 3's `computeState` change; see Task 3.

- [ ] **Step 8 — Write the failing test: permission rejection → `no-access`, never offline.**
```ts
it('reports a permission rejection as no-access, not offline', async () => {
  const { active } = await withFakeRepo({
    status: async () => ({ ...cleanStatus, ahead: 1 }),
    push: async () => ({ kind: 'rejected', reason: 'permission' }),
  })
  await active.pushNow()
  expect(active.syncState().kind).toBe('no-access')
})
```
Run: `-t "no-access"` → FAIL until Task 3's `computeState`.

- [ ] **Step 9 — Commit the additive push machinery.**
```bash
git add apps/desktop/src/main/vault/active-vault.ts apps/desktop/test/active-vault.test.ts
git commit -m "feat(sync): background push coalescer with optimistic non-ff recovery"
```
(Tests 7/8 stay red until Task 3 flips `computeState` — either fold Task 3 into this commit, or mark them `it.skip` with a `// unskipped in Task 3` note and unskip there. Recommended: fold Task 3 in, one commit.)

---

## Task 3: Flip `SyncState` + `computeState` + `sync-label`

The breaking change. Bundle the type, `computeState`, `sync-label`, and every test/consumer referencing `ahead`/`publishing` into one green commit.

**Files:**
- Modify: `src/main/vault/active-vault.ts` (`SyncState`, `computeState`, `let syncing`)
- Modify: `src/renderer/src/lib/sync-label.ts`
- Test: `test/sync-label.test.ts`, `test/active-vault.test.ts`

- [ ] **Step 1 — Update `test/sync-label.test.ts`** for the new vocabulary: `offline` with a count → `offline — 2 waiting`; `offline` count 0 → `offline`; `no-access` → `no write access` (warn); remove `ahead`/`publishing` cases. Run → FAIL.

- [ ] **Step 2 — Rewrite `sync-label.ts`:** delete the `ahead` and `publishing` cases; `offline` → `{ text: state.count > 0 ? `offline — ${state.count} waiting` : 'offline', tone: 'warn' }`; add `no-access` → `{ text: 'no write access', tone: 'warn' }`. Run `pnpm exec vitest run sync-label` → PASS.

- [ ] **Step 3 — Flip `SyncState` and `computeState` in `active-vault.ts`:**
  - Replace the `SyncState` union per the contract.
  - `let syncing: 'pulling' | 'publishing' | null` → `let syncing: 'pulling' | null`.
  - `computeState`: after the `conflictPaths` check —
    ```ts
    if (syncing !== null) return { kind: 'pulling' }
    if (permissionDenied) return { kind: 'no-access' }
    if (offline) return { kind: 'offline', count: status.ahead }
    return { kind: 'up-to-date' }
    ```
    (The resting `status.ahead > 0 ? ahead : up-to-date` line is gone.)

- [ ] **Step 4 — Fix the `ActiveVault — sync` tests that asserted the old states.** The test `reports how many commits are waiting to publish` (FR-21 `ahead`) must become: a diverged-but-online vault reads `up-to-date` after its push drains; and the offline case (Task 2 Step 7) reads `offline{count}`. Delete/rewrite any `toMatchObject({ kind: 'ahead' })` / `'publishing'` assertions. Unskip Task 2 Steps 7–8 if they were skipped.

- [ ] **Step 5 — Run the full main+label suites.**
Run: `pnpm exec vitest run active-vault sync-label`
Expected: PASS.

- [ ] **Step 6 — Commit.**
```bash
git add apps/desktop/src/main/vault/active-vault.ts apps/desktop/src/renderer/src/lib/sync-label.ts apps/desktop/test/active-vault.test.ts apps/desktop/test/sync-label.test.ts
git commit -m "feat(sync): SyncState drops publishing/ahead, gains offline count + no-access"
```

---

## Task 4: Remove `publish()` end-to-end + wire the immediate-push triggers

**Files:**
- Modify: `src/main/vault/active-vault.ts` (`ActiveVault.publish`, `closeCurrent`, open-drain, `onFocus`, merged-pull)
- Modify: `src/main/router.ts` (`sync.publish` → `sync.pushNow`)
- Test: `test/active-vault.test.ts`, `test/router.test.ts`

- [ ] **Step 1 — Rewrite the router tests.** In `test/router.test.ts`: replace the two `sync.publish` tests (`publish sends local commits` ~972, `publish reports a conflicting pre-publish pull` ~987, and the no-vault-open guard ~1012) with `sync.pushNow` equivalents — `pushNow` drains to the remote; a conflicting recovery leaves `sync.state` a conflict; `pushNow` with no vault open rejects `/no vault is open/`. The `createRepo … commits and publishes` test (~922) asserts the *seed* commit exists on the remote — keep it, but it now relies on the open-drain push (Step 4) rather than an explicit publish; assert the seed reached origin after open. Run → FAIL.

- [ ] **Step 2 — Router:** delete the `sync.publish` procedure; add
```ts
pushNow: t.procedure.mutation(async () => { await activeOrThrow().pushNow(); return { ok: true as const } }),
```

- [ ] **Step 3 — Remove `ActiveVault.publish`.** Delete the whole `async publish() { … }` from the returned object and `publish` from the `ActiveVault` interface. `waitForIdlePull` stays (used by nothing now? — grep; if only `publish` used it, remove it too).

- [ ] **Step 4 — Wire the immediate/drain triggers in `active-vault.ts`:**
  - **Vault open drain:** after the existing `if (!closed) args.onSyncState(state)` on open, add `void pushNow()` (fire-and-forget; drains a killed-quit / offline backlog).
  - **Clean merge:** in `maybePull`, in the `result.kind === 'merged'` branch (after `rescan()`), add `schedulePush()` — a merge commit is a local commit the remote lacks.
  - **Focus:** in `onFocus`, after `void maybePull()`, chain a push: `void maybePull().then(() => pushNow())` — return-to-app drains the backlog. (Keep the throttle/in-flight guards as-is.)
  - **`pushNow` on the interface:** add `pushNow(): Promise<void>` to `ActiveVault` and expose the `pushNow` function in the returned object.

- [ ] **Step 5 — Vault-switch push in `closeCurrent` (the `VaultHost`).** Between `await vault.commitNow()` and `await vault.close()`:
```ts
await Promise.race([
  vault.pushNow().catch((err) => console.error('[vault] push on switch failed:', err)),
  new Promise((r) => setTimeout(r, /* pushBudgetMs */ 1_000)),
])
```
(The host has no `timings` handle for `pushBudgetMs` today — thread `args.timings?.pushBudgetMs ?? 1_000`, or hardcode 1_000 with a comment pointing at `DEFAULT_TIMINGS.pushBudgetMs`. Prefer threading it so tests can shrink it.)

- [ ] **Step 6 — Run main + router suites, then commit Tasks 1+4 together (green tree).**
Run: `pnpm exec vitest run active-vault router git`
Expected: PASS.
```bash
git add apps/desktop/src/main apps/desktop/test/active-vault.test.ts apps/desktop/test/router.test.ts apps/desktop/test/git.test.ts
git commit -m "feat(sync): delete publish() — push is automatic; add sync.pushNow + drain triggers"
```

---

## Task 5: Renderer — remove Publish UI, wire ⌘S push

**Files:**
- Modify: `src/renderer/src/components/Shell.tsx` (Push button, `push` handler)
- Modify: `src/renderer/src/components/EditorPane.tsx` (⌘S handler ~line 158)
- Modify: `src/renderer/src/panel/Panel.tsx` (diagnostic publish button ~line 117)

- [ ] **Step 1 — Shell:** delete the `push` const (lines ~105–117) and the `<button … Push</button>` in the footer (~239–245). Keep the `banner` state and the amber banner element — `EditorPane`'s `onConflict` still uses them. The footer now shows only the sync `label` and the vault/login line.

- [ ] **Step 2 — EditorPane ⌘S:** after `void save().then((ok) => { if (ok) void trpc.sync.commitNow.mutate() })`, chain the push so ⌘S = commit + push:
```ts
if (ok) await trpc.sync.commitNow.mutate(), void trpc.sync.pushNow.mutate()
```
Cleaner: `void save().then((ok) => { if (ok) return trpc.sync.commitNow.mutate().then(() => trpc.sync.pushNow.mutate()) })`. The commit must resolve before the push so the push includes it (gotcha 8).

- [ ] **Step 3 — Panel.tsx:** two edits. (a) Remove the `sync.publish` diagnostic button (~117) — optionally add a `sync.pushNow` button in the same shape (not required; Panel is deleted when the agent drawer lands, per its header). (b) Its local `describe(state)` (~37) has a `case 'ahead':` that no longer exists on `SyncState` — replace it with `case 'offline':` (show `state.count`) and drop any `publishing` handling, or the file will not typecheck once Task 3 lands. Minimum: no `trpc.sync.publish` reference and no `case 'ahead'`.

- [ ] **Step 4 — Grep for stragglers.**
Run: `grep -rn "sync.publish\|kind: 'publishing'\|kind: 'ahead'\|to publish\|Publish" apps/desktop/src`
Expected: no live references (docs/comments handled in Task 7).

- [ ] **Step 5 — Typecheck the renderer.**
Run: `pnpm exec tsc --noEmit 2>&1 | grep -E "Shell|EditorPane|Panel|sync-label"`
Expected: no new errors (the 36 pre-existing agent/history errors are unrelated).

- [ ] **Step 6 — Commit.**
```bash
git add apps/desktop/src/renderer
git commit -m "feat(sync): remove the Publish button; ⌘S commits and pushes"
```

---

## Task 6: Quit — best-effort push with a 1s budget

**Files:**
- Modify: `src/main/index.ts` (`before-quit` handler ~line 131)

- [ ] **Step 1 — Add the push between flush and close.** In the `before-quit` async body, after `await requestFlush(flushChannel(mainWindow))` and before `await host.close()`:
```ts
const vault = host.active()
if (vault) {
  await vault.commitNow().catch((err) => console.error('[quit] commit failed:', err))
  await Promise.race([
    vault.pushNow(),                                  // never rejects; catches internally
    new Promise((r) => setTimeout(r, 1_000)),         // pushBudgetMs — never hang quit
  ])
}
```
`host.close()` then commits again (clean, no-op) and lets go. Order is flush → commit → push → close (gotcha 8).

- [ ] **Step 2 — Verify no typecheck regression.**
Run: `pnpm exec tsc --noEmit 2>&1 | grep index.ts`
Expected: empty.

- [ ] **Step 3 — Commit.**
```bash
git add apps/desktop/src/main/index.ts
git commit -m "feat(sync): best-effort push on quit within a 1s budget"
```

---

## Task 7: Fold D61 into `prd/vaults-sync.md`; purge the inbox

**Files:**
- Modify: `docs/prd/vaults-sync.md` (§Committing, §Publishing, §State display, FR-13–16, FR-21, §Why these choices, `SyncState` mentions)
- Modify: `docs/decisions.md` (remove the D61 entry)

- [ ] **Step 1 — Rewrite `prd/vaults-sync.md` natively (no changelog framing, per `docs/README.md`):**
  - Rename **§Publishing → §Pushing**. New content: local commits push automatically on a coalescing timer (~15s) plus the leave points (⌘S, blur, tab close, vault switch, quit, vault open, focus, after a clean merge); a non-fast-forward rejection recovers optimistically (pull then retry) and a conflicting recovery pull routes to §Reconciling; a permission rejection is reported as exactly that (**FR-16 kept verbatim**); network failure surfaces as `offline — N waiting`.
  - **FR-13** → "Commits push automatically; there is no Publish step." **FR-14** → the optimistic non-ff recovery. **FR-15** → folds into the conflict path. **FR-16** → unchanged.
  - **§State display / FR-21** → new vocabulary: `up to date · pulling · offline — N waiting · no write access · conflict · reconciling · paused`. Remove `N to publish` and `publishing`.
  - **§Why these choices** — the "why local commits rather than staying dirty until publish" paragraph: keep the local-commit rationale, drop "until publish"; add one line on why push is automatic (freshness has no user value; churn, not rate limits, is the bound — from D61).
  - **§Open questions** — add the push debounce (~15s) and drop anything now settled.
  - Grep the PRD for "publish"/"Publish" and reconcile every mention.

- [ ] **Step 2 — Purge D61 from `docs/decisions.md`** (the entry says it stays "until the code matches" — it now does). Leave the `## Number allocation — next free is D62` and D60 intact. If D60 point 2's prose ("auto-pull, explicit push… your work leaves only when you Publish") is quoted anywhere as current, it is now superseded — D60 stays as the historical inbox entry until *its* own consolidation, so leave it, but do not let any **living doc** still say "explicit push".

- [ ] **Step 3 — Grep the whole `docs/` tree.**
Run: `grep -rn "to publish\|Publish\|explicit push\|publishing" docs/prd docs/architecture.md docs/glossary.md docs/vision.md`
Expected: only historical decision entries (D60/D61 context) — no *living-doc* claim that publish is a current concept.

- [ ] **Step 4 — Commit.**
```bash
git add docs/prd/vaults-sync.md docs/decisions.md
git commit -m "docs(sync): fold D61 into vaults-sync — push is automatic, no Publish"
```

---

## Task 8: Full verification + live CDP smoke

- [ ] **Step 1 — Delete the design/plan scratch** per `docs/README.md` (plans are executed then deleted; the spec in `docs/specs/` is kept only if it still holds something the PRD doesn't — here it does not, so remove both once folded):
```bash
git rm docs/plans/2026-07-24-auto-push-drop-publish.md docs/specs/2026-07-24-auto-push-drop-publish-design.md
```
(Do this last, after the PRD fold in Task 7 is confirmed complete.)

- [ ] **Step 2 — Full suite.**
Run: `pnpm exec vitest run` in `apps/desktop`
Expected: green (was 538; count shifts as publish tests become push tests — no failures).

- [ ] **Step 3 — Typecheck: no new errors.**
Run: `pnpm exec tsc --noEmit 2>&1 | grep -c error`
Expected: **36** (unchanged — the agent/history areas; this plan adds none).

- [ ] **Step 4 — Build.**
Run: `pnpm exec electron-vite build` in `apps/desktop`
Expected: succeeds.

- [ ] **Step 5 — Live CDP smoke (main-process behaviour is not unit-testable end-to-end here).** Relaunch the app against a fresh fixture (memory [[holi-electron-e2e-via-cdp]]); a main-process edit does **not** hot-restart (gotcha 7), so relaunch. Verify against a bare origin + clone:
  - Type in a note; within ~15s the origin has the commit (fetch the bare repo, check `origin/main`).
  - ⌘S pushes immediately (origin has it within a second).
  - Footer never shows "N to publish" or a Push button; a clean online vault reads "up to date".
  - Kill network (or point the remote at an unreachable URL), edit → footer reads `offline — N waiting`; restore → it drains and returns to `up to date`.

- [ ] **Step 6 — Final commit (verification only if anything changed) and stop for review.** Report the suite count delta, the typecheck count (must be 36), and the CDP observations explicitly (say which were CDP-verified vs unit-tested, per memory [[holi-ui-verification-ceiling]]).

---

## Self-review notes (checked against the spec)

- **Spec coverage:** cadence (Task 2/4), failure taxonomy (Task 2), state display (Task 3), removals (Tasks 1/4/5), quit budget (Task 6), docs fold (Task 7) — all mapped.
- **Type consistency:** `pushNow`, `schedulePush`, `pushInFlight`, `permissionDenied`, `pushQuietMs`, `pushBudgetMs`, `no-access`, `offline{count}` used identically across tasks.
- **Green-tree ordering:** Tasks 1+4 commit together (publish removal spans both); Tasks 2+3 may commit together (the offline/no-access tests need `computeState`). Both couplings are called out inline.
- **Open (non-blocking):** exact `pushQuietMs`/`pushBudgetMs` values are starting points to tune, same status as `commitQuietMs` (vaults-sync §Open questions).
