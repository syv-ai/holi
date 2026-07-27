# Vault agent — Slice 3 (merge resolver) Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an auto-pull hits a git conflict, the user clicks **"Ask Claude to reconcile"**; Holi re-runs the merge to put the conflict markers back in the working tree, opens the agent drawer, and starts the session **seeded** with the conflicted paths. The agent resolves and commits the merge in front of the user, and sync resumes on its own.

**Architecture:** Deliberately small. The conflict is already detected and surfaced as `syncState = {kind:'conflict', paths}` (`active-vault.ts`). Slice 3 adds: (1) a git `remerge()` that re-runs the merge **without aborting** (`pull()` aborts, leaving a clean tree — there is nothing to resolve until we re-materialise it); (2) a thin vault `reconcile()` that calls it; (3) a `prompt` field on agent `start`, appended as a **positional CLI arg** — `claude "<prompt>"` starts interactive and auto-submits it (verified live), so **no PTY-write into the TUI**; (4) a footer button that wires it together.

**The two things that would have made this hard don't exist here:**
- **No reconcile "hold", no completion detector, no coordination with Slice 2.** Once `remerge()` runs, `MERGE_HEAD` is present, and `blockedReason(status).merging` (`active-vault.ts:129-130`) **already suspends commit + pull + push**. Slice 2's per-turn `resume()` (and its safety-timer resume) are harmless mid-merge — every loop self-blocks on `merging`. When the agent commits the merge, `MERGE_HEAD` clears and the loops resume on the next tick; `conflictPaths` is cleared by the next `Stop`→`resume()` or the heal loop. **Completion and resume are automatic.**
- **No terminal-injection hack.** The seed is a spawn argument, not keystrokes written into a live TUI.

**Tech Stack:** `git.ts` (real-git integration, tested against the system binary), the sync engine (`active-vault.ts`), the agent manager + IPC/preload, tRPC (`router.ts`), React/jotai renderer, Vitest 4.

**PRD:** `docs/prd/agent.md` §"The agent as merge resolver", build order slice 3.

---

## Design decisions (settled, do not re-litigate)

- **Re-run the merge, don't un-abort.** `pull()` aborts on conflict by design (announce, don't inflict — `git.ts:366-372`), so the tree is clean with a sticky `conflictPaths` banner. Reconcile needs the markers back → a new `remerge()` that runs `git merge --no-edit origin/<default>` and **does not abort** on conflict. It re-fetches first, so it resolves the *current* conflict (the tree may have moved since the original abort).
- **Reuse the existing `merging`→paused state; do NOT wire the reserved `reconciling` kind.** After `remerge()`, `computeState` naturally reports `paused: "a merge is in progress — sync paused"` (and, while the agent's turn is open, `paused: "the assistant is working"` from Slice 2). Both are honest, and the amber drawer dot corroborates. Adding a `reconciling` flag would mean a new state checked above `blockedReason` — extra state for a cosmetic label. Keep it simple; the `reconciling` SyncState kind stays unused for now.
- **Positional-arg seed (verified).** `claude "<prompt>"` starts an interactive session and auto-submits the prompt as the first turn (probed live: seed echoed, response produced, `Stop` hook fired, returns to the input prompt). `buildAgentArgs` appends `prompt` as the last positional. Reconcile uses `prompt` **without** `resume`.
- **User-triggered only** (PRD): the button appears only when `syncState.kind === 'conflict'`. No unattended rewrites, no token spend without opt-in.
- **Reconcile always (re)starts a fresh seeded session.** `AgentManager.start` already has restart semantics (tears down any running session). A reconcile clicked while a session is live restarts it seeded — the merge instruction must be turn one.

## Known limitations (state them, don't hide them)

- **Trust gate on first agent use per vault.** A fresh `claude` spawn in a not-yet-trusted clone shows "trust this folder?" before any prompt (incl. the seed) is processed. Accepted as reasonable first-run practice (Nicolai) — not suppressed. Once trusted, the seed runs.
- **`remerge()` may find no conflict.** If the tree/remote moved so the merge now applies cleanly, `remerge()` returns `{kind:'merged'}`; `reconcile()` clears the banner and pushes, and the renderer does **not** open a seeded agent (nothing to resolve). Handle it, don't assume a conflict.
- **`resume()` clears `conflictPaths` mid-reconcile.** A per-turn `Stop` during the reconcile clears the sticky banner early. Benign: the tree is physically conflicted/merging, so every loop still self-blocks on `merging`, and the state shows "merge in progress" until the agent commits. No data risk.
- **The user can still type in the editor during a reconcile** (PRD open question: editor read-only for conflicted files, "leaning yes"). **Out of scope for this slice** — the pause already stops autosave; per-file read-only is a separate build. Note and defer.

---

## Conventions (read once)

- **Tooling:** bare `node`/`npx` broken — always `pnpm exec`. Desktop commands from `apps/desktop/`; shared from `packages/shared/`. **Absolute `cd` every Bash call** — cwd drifts (it has bitten `tsc` and `electron-vite build`, which only resolve from `apps/desktop`).
- **Typecheck gate:** from `apps/desktop`, `pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"`. Baseline **6** (pre-existing `state/history.ts`). Must not rise.
- **Test baselines:** desktop **628**, shared **179**. Confirm at start. Expected desktop after this slice ≈ **635** (git remerge + vault reconcile + buildAgentArgs prompt + spawn-arg tests).
- **Git tests use real git** (`test/git.test.ts` header): a temp repo via `plainGit`/`tryGit`; conflict fixtures already exist (`git.test.ts:116-127, 170-179`). `active-vault.test.ts` opens real repos (`openRepo(dir)`) and has a conflict fixture (`:363-381`) + a `withTeammate` helper (`:429`).
- **Build:** `cd apps/desktop && pnpm exec electron-vite build`.
- **Live app:** dev on CDP 9333; main edits need a relaunch — ask Nicolai. Renderer hot-reloads. Scoped teardown only: `pkill -f "better-holi-final/node_modules/.pnpm/electron@"`.
- **Commit trailer:** end every commit message with `Claude goes brr.. via Dash`.

## File Structure

- **Modify** `apps/desktop/src/main/git.ts` — add `remerge(): Promise<PullResult>` to `GitRepo` (re-run merge, no abort).
- **Modify** `apps/desktop/test/git.test.ts` — `remerge` leaves the tree merging with markers.
- **Modify** `apps/desktop/src/main/vault/active-vault.ts` — add `reconcile(): Promise<{paths: string[]}>` to `ActiveVault`.
- **Modify** `apps/desktop/test/active-vault.test.ts` — `reconcile` re-materialises the conflict / clears a now-clean one.
- **Modify** `apps/desktop/src/main/agent/agent-runtime.ts` — `buildAgentArgs({resume, prompt})` appends `prompt` positionally.
- **Modify** `apps/desktop/test/agent-runtime.test.ts` — the positional-seed case.
- **Modify** `apps/desktop/src/main/agent/agent-manager.ts` — `prompt?` on `start`, passed to `buildAgentArgs`.
- **Modify** `apps/desktop/test/agent-manager.test.ts` — spawn args carry the seed.
- **Modify** `apps/desktop/src/main/agent-ipc.ts`, `src/preload/index.ts`, `src/renderer/src/global.d.ts` — thread `prompt?: string` through the `agent-pty:start` args.
- **Modify** `apps/desktop/src/main/router.ts` — `sync.reconcile` mutation.
- **Modify** `apps/desktop/src/renderer/src/state/agent.ts` — `agentSeedPromptAtom`.
- **Modify** `apps/desktop/src/renderer/src/state/vaults.ts` — a `reconcile()` store action (mirrors the `commitNow` wrapper at `:221`).
- **Create** `apps/desktop/src/renderer/src/lib/reconcile-prompt.ts` — `buildReconcilePrompt(paths, branch)` (pure, unit-tested).
- **Modify** `apps/desktop/src/renderer/src/components/Shell.tsx` — the "Ask Claude to reconcile" button (footer, `conflict` only).
- **Modify** `apps/desktop/src/renderer/src/components/AgentPanel.tsx` — `startSession(resume, prompt?)`; consume `agentSeedPromptAtom` (restart seeded).

### Shared contracts (define once)

```ts
// git.ts — GitRepo addition
/** Re-run the merge WITHOUT aborting, leaving conflict markers + MERGE_HEAD in
 *  the tree for the reconcile flow. Re-fetches first. Contrast pull(), which
 *  aborts. */
remerge(): Promise<PullResult>            // reuses { kind:'up-to-date'|'merged'|'conflict' }

// active-vault.ts — ActiveVault addition
/** FR-18 reconcile: re-materialise the conflict (or clear it if it now merges
 *  clean) and return the currently-conflicted paths for the seed prompt. Does
 *  NOT hold anything — the resulting `merging` state suspends the loops, and a
 *  clean commit by the agent resumes them. */
reconcile(): Promise<{ paths: string[] }>

// agent start args (agent-ipc.ts / preload / global.d.ts / agent-manager.ts) — add:
prompt?: string   // seeds the interactive session's first turn (positional CLI arg)

// agent-runtime.ts
export function buildAgentArgs({ resume, prompt }: { resume?: boolean; prompt?: string }): string[]
// → [...(resume ? ['--resume'] : []), ...(prompt ? [prompt] : [])]

// renderer/src/lib/reconcile-prompt.ts
export function buildReconcilePrompt(paths: string[], branch: string): string

// renderer/src/state/agent.ts
export const agentSeedPromptAtom = atom<string | null>(null)
```

---

## Task 1: `remerge()` — re-run the merge without aborting

**Files:** Modify `git.ts`, `test/git.test.ts`.

- [ ] **Step 1: Failing test.** In `git.test.ts`, reuse the conflict fixture pattern (`:116-127`: two clones edit the same line, `ours` is behind). Test-intent:
  - After `openRepo(ours).remerge()` on a conflicting divergence: result `{kind:'conflict', paths:[<file>]}`, **and** the tree is left mid-merge — `(await openRepo(ours).status()).merging === true` and the file contains `<<<<<<<`. (Contrast the existing `pull()` test that leaves the tree clean.)
  - A second test: when `ours` and `origin` changed *different* files (mergeable), `remerge()` returns `{kind:'merged', …}` and `merging === false`.
- [ ] **Step 2: Run, verify fail** — `cd apps/desktop && pnpm exec vitest run test/git.test.ts`.
- [ ] **Step 3: Implement `remerge()`.** Add to the `GitRepo` interface (near `pull`/`abortMerge`, `git.ts:151-158`) and the returned object (near `pull`, `:372-393`). Body mirrors `pull()`'s fetch+merge but **omits the `abortMerge()` call** on conflict: `fetch`; `git merge --no-edit origin/<target>`; on `!merge.ok` collect `--diff-filter=U` paths and return `{kind:'conflict', paths}` **without aborting**; on ok return `{kind:'merged', commits}`; handle up-to-date. Factor the fetch+merge+classify shared with `pull()` only if trivial — otherwise a focused duplicate is fine (keep `pull()`'s contract pristine).
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Typecheck** → 6.
- [ ] **Step 6: Commit** — `feat(vault): git remerge() re-runs the merge without aborting (reconcile)`.

---

## Task 2: `reconcile()` on the active vault

**Files:** Modify `active-vault.ts`, `test/active-vault.test.ts`.

- [ ] **Step 1: Failing test.** Reuse the conflict fixture (`active-vault.test.ts:363-381` / `withTeammate` `:429`). Test-intent:
  - On a vault whose pull has conflicted (`conflictPaths` set, tree clean): `await active.reconcile()` returns `{paths:[<file>]}`, leaves the tree merging (`repo.status().merging === true`), and the working file has `<<<<<<<`.
  - On a divergence that now merges clean: `reconcile()` returns `{paths:[]}`, the conflict banner clears (`syncState().kind !== 'conflict'`), and `merging === false`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.** Add `reconcile` to the `ActiveVault` interface (`:89-114`) and the returned object (near `pause`/`resume`, `:585-604`):
  - `const result = await args.repo.remerge()`.
  - If `result.kind === 'conflict'`: `conflictPaths = result.paths` (refresh to the current set); `await refreshState()` (state becomes `merging`-paused naturally); return `{paths: result.paths}`.
  - If `result.kind === 'merged'`: `conflictPaths = null`; `await rescan()`; `schedulePush()`; `await refreshState()`; return `{paths: []}`.
  - If `result.kind === 'up-to-date'`: `conflictPaths = null`; `await refreshState()`; return `{paths: []}`.
  - Guard `if (closed) return {paths: []}` at the top.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Typecheck** → 6.
- [ ] **Step 6: Commit** — `feat(vault): reconcile() re-materialises a conflict for the agent`.

---

## Task 3: `prompt` seed through `buildAgentArgs` and the manager

**Files:** Modify `agent-runtime.ts`, `agent-manager.ts`, their tests.

- [ ] **Step 1: Failing tests.**
  - `agent-runtime.test.ts` (near the `buildAgentArgs` describe): `buildAgentArgs({ prompt: 'resolve it' })` → `['resolve it']`; `buildAgentArgs({ resume: true })` → `['--resume']`; `buildAgentArgs({})` → `[]`; still never contains `--append-system-prompt`.
  - `agent-manager.test.ts`: after `start({ vaultId: VAULT, prompt: 'seed msg' })`, the recorded spawn `args` includes `'seed msg'` (last positional).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.**
  - `agent-runtime.ts`: change `AgentArgs` to `{ resume?: boolean; prompt?: string }`; `buildAgentArgs` returns `[...(resume ? ['--resume'] : []), ...(prompt ? [prompt] : [])]`.
  - `agent-manager.ts`: add `prompt?: string` to the `start` args type (`:50-51` interface + `:102-114` destructure) and pass it: `buildAgentArgs({ resume, prompt })`.
- [ ] **Step 4: Run, verify pass** — manager + runtime suites.
- [ ] **Step 5: Typecheck** → 6.
- [ ] **Step 6: Commit** — `feat(agent): seed the interactive session via a positional prompt arg`.

---

## Task 4: Thread `prompt` through IPC/preload/types + the `sync.reconcile` tRPC

**Files:** Modify `agent-ipc.ts`, `preload/index.ts`, `renderer/src/global.d.ts`, `router.ts`.

- [ ] **Step 1: Add `prompt?: string`** to the `agent-pty:start` args in all three surfaces: `agent-ipc.ts:21`, `preload/index.ts:70`, `global.d.ts:53-60`. (No behaviour beyond forwarding — `agent-manager` already consumes it from Task 3.)
- [ ] **Step 2: Add the `sync.reconcile` mutation.** In `router.ts`, beside `sync.pause`/`sync.resume` (`:848-859`): `reconcile: publicProcedure.mutation(async () => host.active() ? host.active()!.reconcile() : { paths: [] })` (match the file's existing procedure style + how `host`/active vault is referenced there — see `sync.commitNow`).
- [ ] **Step 3: Typecheck** → 6 (tRPC output type flows to the renderer by inference).
- [ ] **Step 4: Commit** — `feat(agent): agent-pty:start carries a prompt; add sync.reconcile`.

---

## Task 5: Renderer — the reconcile button + seeded start

**Files:** Create `renderer/src/lib/reconcile-prompt.ts` (+ test); modify `state/agent.ts`, `state/vaults.ts`, `Shell.tsx`, `AgentPanel.tsx`.

- [ ] **Step 1: Failing test for the prompt builder.** `test/reconcile-prompt.test.ts` — `buildReconcilePrompt(['a.md','b/c.md'], 'main')` contains both paths and instructs: resolve the `<<<<<<<`/`=======`/`>>>>>>>` markers by meaning (prose + YAML, not positional), then `git add` + `git commit --no-edit` to finish the merge.
- [ ] **Step 2: Implement `buildReconcilePrompt`** (pure string builder). Run the test → pass.
- [ ] **Step 3: Add the atom + store action.**
  - `state/agent.ts`: `export const agentSeedPromptAtom = atom<string | null>(null)`.
  - `state/vaults.ts`: a `reconcile()` action mirroring the `commitNow` wrapper (`:221`) — `await trpc.sync.reconcile.mutate()`, returns `{paths}`.
- [ ] **Step 4: Wire the button.** In `Shell.tsx`, where `syncState` is read (`:52`, footer `:268-275`): when `syncState.kind === 'conflict'`, render a small button beside the label — **"Ask Claude to reconcile"**. onClick:
  - `const { paths } = await reconcile()` (store action).
  - if `paths.length === 0` → done (it merged clean); return.
  - `set(agentSeedPromptAtom, buildReconcilePrompt(paths, defaultBranch))` — use the vault's default branch if readily available, else the literal `'the default branch'` in the prompt text (don't add plumbing just for the name).
  - `setAgentOpen(true)` (`agentPanelOpenAtom`).
- [ ] **Step 5: Consume the seed in AgentPanel.** In `AgentPanel.tsx`:
  - `startSession(resume: boolean, prompt?: string)` — forward `prompt` to `window.holi.agent.start({ vaultId, resume, cols, rows, prompt })` (`:178`).
  - An effect on `agentSeedPromptAtom`: when non-null and the terminal exists, **restart** seeded — `await window.holi.agent.kill()`; `termRef.current?.reset()`; `await startSession(false, prompt)`; then `set(agentSeedPromptAtom, null)`. (Restart, because the seed must be turn one even if a session was already open. Mirror the existing `restart()` at `:240`.)
- [ ] **Step 6: Typecheck** → 6. Renderer behaviour is CDP/manual (Task 6); the pure builder is unit-tested.
- [ ] **Step 7: Commit** — `feat(agent): "Ask Claude to reconcile" button seeds the merge-resolution turn`.

---

## Task 6: Full gates + live verification

**Files:** none.

- [ ] **Step 1: Typecheck** → 6.
- [ ] **Step 2: Desktop suite** — `cd apps/desktop && pnpm exec vitest run 2>&1 | tail -6` (~635; confirm, no unexpected failures).
- [ ] **Step 3: Shared suite** — `cd packages/shared && pnpm exec vitest run 2>&1 | tail -3` → 179.
- [ ] **Step 4: Build** — `cd apps/desktop && pnpm exec electron-vite build 2>&1 | tail -3` → clean.
- [ ] **Step 5: Live (ask Nicolai to relaunch — main changed; CDP 9333).** Manufacture a real conflict: from a second clone of a test vault, edit a note's same line and push; locally edit the same line so the next auto-pull conflicts. Then:
  1. **Conflict surfaces** — footer shows the conflict label + an **"Ask Claude to reconcile"** button.
  2. **Click it** — the drawer opens, the agent session starts already working on the seeded turn (amber dot), footer reads paused (merge in progress / assistant working). The working tree has the conflict markers.
  3. **Agent resolves + commits** the merge in view; on completion the drawer dot goes green and the footer returns to up-to-date **on its own** (no manual resume) — the merge commit pushes.
  4. **Clean re-merge path** — if the conflict resolved itself before clicking, the button run clears the banner and does **not** open a seeded agent.
  5. **Autosave still works** afterwards; a subsequent normal pull merges cleanly.
  - Report what happened, especially #3 (does it auto-resume?).

---

## Final verification

- [ ] Typecheck **6**; desktop suite green (confirm count); shared **179**; build clean.
- [ ] Live: a conflict shows the reconcile button; clicking re-materialises the merge, opens the drawer seeded, the agent finishes the merge, and sync resumes automatically.

## Self-review (spec coverage)

- **Auto-pull conflict → "Ask Claude to reconcile"** (PRD §merge resolver step 1) → Task 5 button, gated on `conflict`.
- **Pause autosave + auto-pull for the whole reconcile** (step 1) → inherent: `remerge()` leaves `MERGE_HEAD`, and `blockedReason(merging)` suspends all loops (no new hold — see Architecture).
- **Re-run the merge for real, leaving the conflict in the tree** (step 2) → Task 1 `remerge()` + Task 2 `reconcile()`.
- **Open the drawer, seed the first message with the conflicted paths** (step 3) → Task 5 (`agentSeedPromptAtom` + `setAgentOpen`) + Tasks 3–4 (`prompt` positional arg); no PTY-write.
- **Agent resolves markers + finishes the merge in front of the user** (step 4) → the seeded prompt instructs exactly this; the agent has native tools + git (AGENTS.md, shipped slice 2).
- **On a clean tree, Holi resumes** (step 5) → automatic: agent's merge commit clears `MERGE_HEAD`; next `Stop`→`resume()`/heal tick clears `conflictPaths` and the loops run.
- **User-triggered only; recoverable** (PRD "why safe") → button-only; the worst case is `git merge --abort`, and a failed reconcile just re-shows the conflict on the next pull.
- **Deferred (correctly absent):** editor read-only for conflicted files during reconcile (PRD open question — noted); the `reconciling` SyncState label (kept unused; the `merging` state covers it); `$TYPST_BIN` + `md-to-pdf` (slice 4).
