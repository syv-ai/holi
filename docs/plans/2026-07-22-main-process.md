# The Main Process Returns — Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Holi window opens, clones or adopts a vault, watches it, commits it on idle, pulls it on a timer, and publishes it on demand — driven end to end through the real IPC seam.

**Architecture:** One `ActiveVault` in the main process owns the open vault: its `GitRepo`, a chokidar watcher, a cached `VaultSnapshot`, and the sync loop. A `VaultHost` owns *which* `ActiveVault` is current. Both push to the renderer over two channels; everything else stays request/response over tRPC. The renderer for this plan is a deliberately throwaway instrument panel.

**Tech Stack:** Electron 43, chokidar 5, tRPC 11, Vitest 4.

**PRDs:** [`vaults-sync.md`](../prd/vaults-sync.md) (the whole sync engine), [`auth-identity.md`](../prd/auth-identity.md) FR-7/FR-8 (add and create a vault), [`notes-editor.md`](../prd/notes-editor.md) §External writes + §Open question 2 (which this plan closes).

**Builds on:** plan 1 (`main/git.ts`), plan 2 (`main/github/`), plan 3 (`merge3`). All three are green and typecheck clean.

---

## The rule that makes this plan runnable

`apps/desktop` has 106 typecheck errors and will still have ~70 when this plan is done. That is fine, because **vite does not typecheck — it resolves**. The app boots as long as no module on the boot path transitively imports a deleted one.

> **The boot path is: `main/index.ts` → `ipc.ts` → `router.ts` → `vault/*` → `preload/index.ts` → `renderer/src/main.tsx` → `panel/Panel.tsx`. Nothing on it may import a module that does not exist.**

Everything else stays quarantined and broken on purpose:

| Quarantined | Why it stays broken |
|---|---|
| `renderer/components/{Shell,EditorPane,VaultSettings,FileTree,BoardView,…}.tsx` | Plan 5. `EditorPane` imports `yjs` and `y-codemirror.next`, which are not even dependencies. |
| `renderer/state/{daily,history,vaults,view}.ts` | Plan 5. |
| `main/agent/{agent-manager,context-snapshot}.ts` | 5 errors: dead imports of `../server-client` and `../vault/vault-mirror`, plus `Task.id`/`Task.related` which D60 deleted. The agent drawer is plan 5, so **`index.ts` must not wire the agent** — an unresolvable import on the boot path is the one thing that stops the window opening. |

`main/vault/vault-manager.ts` is **deleted**, not repaired. So are `main/ipc.ts`'s and `main/index.ts`'s contents.

Expected typecheck at the end: **~70 errors, all under `src/renderer/` and `src/main/agent/`. Zero under `src/main/vault/`, `src/main/ipc.ts`, `src/main/index.ts`.**

---

## Decisions this plan takes

All eleven came out of a grilling session; none is in a PRD. Stated here so they are cheap to reverse.

### 1. Plan 4 owns the sync loop

The autosave-commit debounce, the pull interval and focus triggers land here, not in plan 5. They are main-process code with no UI, and putting them in a renderer-focused plan means plan 5 straddles the IPC seam. Plan 5 becomes purely renderer.

### 2. One `ActiveVault` at a time

A single object, created on open, torn down on switch and quit. Exactly one watcher and one set of timers exist at any moment. **Not called a "vault session"** — `GitHubSession` owns that word, and it outlives every vault.

The cost, stated plainly: a background vault does not pull and shows no sync state until you switch to it. Reminders (which must fire for vaults you do not have open) will eventually want the N-vault shape. That is a later problem and this is not a one-way door — `VaultHost` is where it would change.

### 3. The renderer for this plan is a throwaway instrument panel

See §The rule above: the real Shell cannot boot. A diagnostic surface — vault list, add/create, file tree, sync state, Publish, one raw text box — exercises the whole main-side stack through the real seam and is drivable headlessly over CDP. It is a tracer bullet; plan 5 deletes it.

### 4. `~/Holi/<owner>/<repo>`, fixed

`os.homedir()`, **not** `app.getPath('home')` — `registry.ts` is reached by tests and must stay free of Electron imports (see Gotchas). No user-facing setting in v1.

`HOLI_VAULT_ROOT` overrides it. This is not a feature, it is a necessity: without it every `electron-vite dev` run and every headless CDP run clones into your real `~/Holi` next to real vaults.

### 5. An occupied clone path is re-adopted if its origin matches, refused otherwise, never deleted

`vaults.remove` deliberately leaves the clone on disk, possibly holding unpublished commits — so an occupied path is a normal state, not a corrupt one, and a re-clone is exactly what destroys the work. FR-1's "never adopt a user-maintained checkout" is about adopting a path *the user* chose; this is re-adopting a path Holi itself chose.

**This decision is also what makes the plan testable with no GitHub OAuth app** (see §Acceptance, and §7 of the handoff — the client id is still a placeholder).

### 6. One push channel carrying the whole snapshot

The watcher debounces, `scanVault` runs, and the full `VaultSnapshot` goes over `vault:snapshot`. **No per-path events.** A dropped fsevent is survivable by construction, because the self-heal rescan pushes the same shape.

### 7. No write attribution, anywhere

This closes `notes-editor.md` §Open question 2 and the bug predicted in three consecutive handoffs.

The editor holds `base` = the text it last **loaded or saved**. On any snapshot push it re-reads its file: `disk === base` means nothing happened that concerns it, *whoever* did the writing. Only `disk !== base` runs the clean-reload / 3-way-merge path.

Correct under every interleaving: more typing between save and signal does not matter, because the comparison is disk-vs-**base**, not disk-vs-buffer. A foreign write landing in the same window is still caught. And it is the only candidate that handles a foreign write reproducing our exact bytes — which genuinely *is* a no-op.

The two rejected candidates, for the record: **path+mtime bookkeeping** races because `writeAtomic` is tmp+rename, so the mtime recorded is not reliably the one read back; **pausing the watcher across the write** is a deliberate blindness window that drops any pull or agent write landing inside it.

The editor half is plan 5. What plan 4 owes it is decision 6's coarse, over-eager signal — which is safe *only* because of this decision.

### 8. `git status` drives the commit; the watcher only hurries it

The commit loop asks `repo.status()`; dirty means commit. A watcher event does not commit — it schedules the check sooner. A dropped fsevent therefore delays a commit by one tick instead of losing it, which matters because an uncommitted file breaks FR-7's "clean between commits by construction", and a tree that is not clean is a tree the next pull cannot merge.

Starting package, all tunable, all in one exported constants object:

| | Value | Why |
|---|---|---|
| rescan debounce | 200 ms | the tree must feel live |
| commit quiet | 3 s | `prd/vaults-sync.md` §Open question 1 says "start around 2–3 seconds" |
| self-heal tick | 30 s | rescans **and** commits-if-dirty; the fsevents backstop |
| pull interval | 3 min | FR-9 |
| focus pull throttle | 30 s | so alt-tabbing does not fetch in a loop |
| ⌘S | immediate | FR-4 — "a real save and a real commit point, not a placebo" |

### 9. `app.requestSingleInstanceLock()`, no per-clone lockfile

`vaults-sync.md` §Edge cases says "take a lock on the clone", but under decision 2 one process owns every vault — so excluding a second *app* is exactly excluding a second writer on every clone, and it covers vaults that are not open, which a per-clone lock cannot. A lockfile's stale-lock handling would lock a user out of their own vault after one crash, which is worse than the race it prevents.

### 10. Seed on every open; `.gitignore` enforced by line

`commitAll` runs `git add -A`, and `isLocalOnlyPath` (`USER.md`, `*.local.*`) is enforced only in the vault *store* — **git knows nothing about it**. So `.gitignore` is the single thing standing between `USER.md` and a commit published to the whole team.

Create-if-missing is right for `CLAUDE.md` / `AGENTS.md` / `MEMORY.md` / `.claude/` — the first person to open seeds them, everyone else no-ops, and a member who edits `AGENTS.md` keeps their edit forever. It is a **hole** for `.gitignore`, because an adopted repo usually already has one and ours would then never be written. So `.gitignore` gets missing lines appended, derived from the same constant `isLocalOnlyPath` is written against, so the two cannot drift.

Seeding runs on **every** vault open, not just at New-vault creation, so an adopted repo that was never a Holi vault is protected too.

### 11. An off-branch vault opens fully; only sync pauses

FR-2 constrains *sync*, not *open*. Every Holi user is a developer, so a detached HEAD or a `spike/foo` checkout is a Tuesday — and "mid-operation" includes a merge the user is resolving in a terminal, which is the moment they would most want to read their notes. The tree is live, files are editable; the commit and pull loops are off and the sync state says why.

`unborn` is **not** a refusal — it is the normal state of a repo `github.createRepo` just made, before its first commit.

---

## File structure

| File | Responsibility |
|---|---|
| `packages/shared/src/path-safety.ts` (modify) | `LOCAL_ONLY_IGNORE_LINES`, next to `isLocalOnlyPath` so they cannot drift. |
| `apps/desktop/src/main/git.ts` (modify) | `RepoStatus.dirtyPaths` — the commit message needs the path FR-4 asks for. |
| `apps/desktop/src/main/vault/registry.ts` (modify) | `vaultRoot()`. |
| `apps/desktop/src/main/vault/clone.ts` (create) | Getting a clone: clone it, or re-adopt what is already there. |
| `apps/desktop/src/main/vault/watcher.ts` (create) | A debounced, coalescing chokidar wrapper that says only *when*. |
| `apps/desktop/src/main/vault/active-vault.ts` (create) | The open vault and its sync loop; plus `VaultHost`, which owns the swap. |
| `apps/desktop/src/main/agent/seed-content.ts` (rewrite) | The seed set, D60-correct, `.gitignore` included. |
| `apps/desktop/src/main/router.ts` (modify) | `vaults.add`/`create`, `sync.*`; `RouterDeps` gains `host`. |
| `apps/desktop/src/main/ipc.ts` (rewrite) | The tRPC bridge and the two push channels. Nothing else. |
| `apps/desktop/src/main/index.ts` (rewrite) | App lifecycle: single-instance lock, window, wiring, quit flush. |
| `apps/desktop/src/preload/index.ts` (rewrite) | Keep `pushChannel`; replace every channel it feeds. |
| `apps/desktop/src/renderer/src/global.d.ts` (rewrite) | The `window.holi` type, matching the new preload. |
| `apps/desktop/src/renderer/src/panel/Panel.tsx` (create) | The throwaway instrument panel. |
| `apps/desktop/src/renderer/src/main.tsx` (modify) | Render `Panel` instead of `App`. |
| `apps/desktop/src/main/vault/vault-manager.ts` | **Delete.** |

Tests: `test/vault-clone.test.ts`, `test/vault-watcher.test.ts`, `test/active-vault.test.ts`, `test/seed-content.test.ts` (rewrite), `test/registry.test.ts` (extend), `test/git.test.ts` (extend), `test/router.test.ts` (extend).

---

## Contracts

```ts
// packages/shared/src/path-safety.ts
/**
 * The .gitignore lines that correspond, exactly, to isLocalOnlyPath.
 *
 * Lives here rather than in the seed so the two are edited together: git does
 * not know about isLocalOnlyPath, and `commitAll` runs `git add -A`, so a line
 * missing here publishes a machine-local file to every collaborator.
 */
export const LOCAL_ONLY_IGNORE_LINES: readonly string[]   // ['USER.md', '*.local.*']

// apps/desktop/src/main/git.ts
export interface RepoStatus {
  /* …unchanged… */
  /** Vault-relative paths of everything changed, untracked or unmerged.
   *  Empty exactly when `dirty` is false. FR-4's commit message is built from it. */
  dirtyPaths: string[]
}

// apps/desktop/src/main/vault/registry.ts
/** `$HOLI_VAULT_ROOT`, else `~/Holi`. os.homedir(), NOT electron's app. */
export function vaultRoot(): string

// apps/desktop/src/main/vault/clone.ts
export type CloneOutcome = { kind: 'cloned' } | { kind: 'adopted' } | { kind: 'reused' }

/**
 * The clone for `remote` at `clonePathFor(root, remote)`, however it has to get
 * there. Never deletes anything.
 *
 *  - path absent            → `cloneRepo` (`cloned`)
 *  - path holds a repo whose origin is this remote → `adopted`
 *  - path is not a repo, or origin points elsewhere → throws `ClonePathInUse`
 *
 * Decision 5. The `adopted` case is what lets this whole plan be exercised
 * against a local bare repo with no GitHub token.
 */
export function ensureClone(args: {
  root: string
  remote: string
  gitDeps?: GitDeps
}): Promise<{ repo: GitRepo; outcome: CloneOutcome }>

export class ClonePathInUse extends Error {
  constructor(readonly path: string, readonly foundRemote: string | null)
}

// apps/desktop/src/main/vault/watcher.ts
export interface VaultWatcher {
  close(): Promise<void>
}

/**
 * Calls `onChange` after `debounceMs` of quiet. Coalescing, unaddressed: it
 * says *when*, never *what* (decision 6). Ignores via `isIgnoredPath`, which
 * prunes `.git` — without which every commit Holi makes re-fires the watcher.
 */
export function watchVault(args: {
  root: string
  onChange: () => void
  debounceMs?: number
}): Promise<VaultWatcher>

// apps/desktop/src/main/vault/active-vault.ts

/** FR-21's six display states, plus two this plan adds:
 *  `publishing` (a publish is a pull AND a push; calling it `pulling` would lie)
 *  and `paused` (decision 11 — the vault is open but sync is off, and why). */
export type SyncState =
  | { kind: 'up-to-date' }
  | { kind: 'ahead'; count: number }
  | { kind: 'pulling' }
  | { kind: 'publishing' }
  | { kind: 'offline' }
  | { kind: 'conflict'; paths: string[] }
  | { kind: 'reconciling' }
  | { kind: 'paused'; reason: string }

/** All eight in one object so tuning is one edit and tests can shrink them. */
export interface SyncTimings {
  rescanDebounceMs: number   // 200
  commitQuietMs: number      // 3_000
  healIntervalMs: number     // 30_000
  pullIntervalMs: number     // 180_000
  focusThrottleMs: number    // 30_000
}
export const DEFAULT_TIMINGS: SyncTimings

export interface ActiveVault {
  readonly remote: string
  readonly root: string
  readonly repo: GitRepo
  /** The cache. Never touches the disk — the watcher and the heal tick own that. */
  snapshot(): VaultSnapshot
  syncState(): SyncState
  /** Rescan now and push. */
  refresh(): Promise<void>
  /** Commit whatever is dirty, now. ⌘S, vault switch, and quit. */
  commitNow(): Promise<string | null>
  /** FR-13/FR-14. Pull, then push. */
  publish(): Promise<PullResult | PushResult>
  /** Window focus (FR-9), internally throttled. */
  onFocus(): void
  /** FR-8/FR-18: a reconcile stops both loops. */
  pause(reason: string): void
  resume(): void
  close(): Promise<void>
}

export function openActiveVault(args: {
  remote: string
  repo: GitRepo
  onSnapshot: (snapshot: VaultSnapshot) => void
  onSyncState: (state: SyncState) => void
  timings?: Partial<SyncTimings>
}): Promise<ActiveVault>

/** Owns *which* ActiveVault is current — decision 2's "one at a time" lives here,
 *  and it is the seam where an N-vault future would change. */
export interface VaultHost {
  active(): ActiveVault | null
  /** Tears down the current one first. Idempotent for the same remote. */
  open(remote: string): Promise<ActiveVault>
  close(): Promise<void>
}

export function createVaultHost(args: {
  registry: VaultRegistry
  gitDeps?: GitDeps
  onSnapshot: (snapshot: VaultSnapshot) => void
  onSyncState: (state: SyncState) => void
  timings?: Partial<SyncTimings>
}): VaultHost

// apps/desktop/src/main/agent/seed-content.ts
/** Create-if-missing for everything except `.gitignore`, whose missing lines are
 *  appended (decision 10). Returns the paths actually touched. Idempotent. */
export function ensureSeeded(root: string): Promise<string[]>

// apps/desktop/src/main/router.ts — RouterDeps gains one required dep
export interface RouterDeps {
  /* …registry, session, openExternal, now, today… */
  host: VaultHost
}
```

**New router procedures:**

| Procedure | Shape |
|---|---|
| `vaults.add` | `{ remote }` → `ensureClone`, seed, register, `host.open` → `VaultSnapshot` |
| `vaults.create` | `{ name, owner? }` → `github.createRepo`, `ensureClone`, seed, commit, push, register, `host.open` |
| `vaults.open` | now activates the host; returns the snapshot from the cache |
| `vaults.snapshot` | cache when active, `scanVault` otherwise |
| `sync.state` | `SyncState` — the pull for the push channel's initial value |
| `sync.commitNow` | `{ remote }` → `commitNow()` |
| `sync.publish` | `{ remote }` → `publish()`, mapped honestly (FR-16) |

**IPC surface (preload → `window.holi`):**

| | |
|---|---|
| `trpc(op)` | `holi:trpc` — unchanged, the one request/response seam |
| `onSnapshot(cb)` | `vault:snapshot` — full `VaultSnapshot` |
| `onSyncState(cb)` | `vault:sync` — `SyncState` |
| `openExternal(url)` | `holi:openExternal` |

Everything else the old preload exposed — `collab.*`, `docs.onEvent`, `tasks.onEvent`, `tasks.onPresence`, `vaults.onEvent`, `stream.onResync`, `reminders.onOpen`, `auth.*`, `agent.*` — is **deleted**. `auth.*` moved to the tRPC router in plan 2; the rest rode the SSE connection that no longer exists.

---

## Gotchas — read before writing code

**Electron and the test suite**

- **A static `import … from 'electron'` in a module the suite loads will *pass*** — Electron's Node entry resolves and exports a path string, so `app` comes back `undefined` and nothing calls it. That is luck, not isolation. `registry.ts`, `clone.ts`, `watcher.ts`, `active-vault.ts` and `seed-content.ts` are all test-reached and must import **zero** Electron. This is why `vaultRoot()` uses `os.homedir()`. `main/github/electron.ts` exists as the precedent.
- **`pkill` must be scoped.** Dash itself is Electron; a bare `pkill -f electron` kills your own session. This matters far more in this plan than in 1–3.
- **Bare `node`/`npx` are broken on this machine — use `pnpm exec`.** This also means the seeded hook's `node "$CLAUDE_PROJECT_DIR/…"` command will fail here. Seed it anyway (it is correct for a normal machine) but do not treat a hook failure during manual testing as a bug in this plan.
- **Vitest 4 silently ignores `poolOptions.forks.singleFork`.** `fileParallelism: false` is the lever and it is already set — do not "clean it up". The watcher suites this plan adds are precisely the ones its comment predicts.

**chokidar 5**

- **`ignored` must be a function, not a glob.** chokidar 4 dropped anymatch glob support. It receives an **absolute** path, so the predicate is `toVaultRel(root, abs)` then `isIgnoredPath` — and `toVaultRel` returning `null` (outside the root) must count as ignored.
- **`ignored` is called for directories too, and returning `true` prunes the subtree.** That is what keeps `.git` from being walked; get it wrong and you watch the whole object store and re-fire on every commit Holi makes.
- **`ignoreInitial: true`**, or `openActiveVault` fires a rescan for every file in the vault at startup.
- **Do not reach for `awaitWriteFinish`.** It buys latency for a problem we do not have — `writeAtomic` is tmp+rename, so no reader ever sees a partial file.
- **A file that lives for milliseconds is delivered as nothing at all** (measured, `4b023b4`), and `usePolling` makes it worse. Do not "fix" a flake by widening a wait, and do not fix one by polling. The heal tick is the answer.

**git**

- **`--porcelain=v2 -z` rename records consume two fields.** A `2 ` record is `…<path>\0<origPath>`, so a naive `split('\0')` walk treats the original path as its own record. Harmless today because `status()` only sets `dirty = true`; it emits a **phantom path** the moment `dirtyPaths` exists. `1 ` and `?` records take the rest of the field after the last space; `2 ` takes one extra field.
- **`--untracked-files=all` is already passed** — verified. A brand-new note counts as dirty, so no plan-1 bug lurks here.
- **`commitAll` returns `null` when the tree was already clean.** That is the *normal* outcome of an idle tick, not an error, and it must not be logged as one or the console fills at 2 lines a minute.
- **`GitDeps.token` is a getter**, read lazily. Hand `host` a closure over `session.token()`, never a string, or a sign-out takes effect on the next restart instead of the next operation.
- **A pull writes many files and fires the watcher**, which schedules a commit check, which finds a clean tree and commits nothing. Correct, but make sure the "nothing to commit" path is silent.

**The loop**

- **Every timer must be cleared in `close()`.** A leaked interval on a torn-down vault keeps a `GitRepo` alive over a directory a test has already deleted, and the failure surfaces in an unrelated file three tests later.
- **The loops must not overlap themselves.** A pull that takes longer than `pullIntervalMs`, or a commit slower than the heal tick, must not start a second one — guard with an in-flight flag, not by trusting the interval.
- **FR-12: a conflicting pull pauses auto-pull for that vault**, or it retries and re-aborts in a loop forever.
- **Seed the `.gitignore` before anything else writes, and before the watcher starts.** Not a decision, an ordering constraint: any window where `commitAll` could stage a local-only file is a window where `USER.md` reaches the shared history.

**Electron lifecycle**

- **`electron-vite` bundles main to CJS.** `import.meta.url` does not survive the build — this is why `git.ts` materialises its askpass script at runtime. Do not introduce a new one.
- **`before-quit` is synchronous.** Fire the flush unawaited and the app exits before it finishes, losing the last commit. Veto the first quit, flush, then quit for real, with a `quitting` flag so the second pass falls through — the existing `index.ts` gets this right and its comment is worth keeping.
- **`requestSingleInstanceLock()` must be called before `whenReady()`** and the loser must `app.quit()` immediately; the winner listens for `second-instance` to focus its window.

---

## Task 1: `dirtyPaths`, and where vaults live

**Files:**
- Modify: `apps/desktop/src/main/git.ts` (`RepoStatus`, `status()`)
- Modify: `apps/desktop/src/main/vault/registry.ts`
- Modify: `apps/desktop/test/git.test.ts`, `apps/desktop/test/registry.test.ts`

- [ ] **Step 1: Write the failing tests**

In `git.test.ts`, against real repos in tmpdirs as the rest of the file does:
- `reports no dirty paths in a clean tree` — `dirtyPaths` is `[]` exactly when `dirty` is false.
- `reports a modified tracked file`.
- `reports an untracked file` — the common case, a new note.
- `reports a file inside a new directory`.
- `reports a renamed file once, not twice` — **the porcelain-v2 `-z` trap.** Stage a rename (`git mv`), assert exactly one path and that the *original* path is not among them.
- `reports a path containing a space`.
- `reports both sides of an unmerged file as one path` — build a conflict the way the existing pull tests do.

In `registry.test.ts`:
- `defaults to ~/Holi` — assert against `os.homedir()`, not a literal.
- `honours HOLI_VAULT_ROOT` — set and restore it in the test.
- `composes with clonePathFor` — `vaultRoot()` + `syv/notes` lands at `<root>/syv/notes`.

- [ ] **Step 2: Run and watch fail**

Run: `pnpm exec vitest run test/git.test.ts test/registry.test.ts`
Expected: FAIL — `dirtyPaths` undefined, `vaultRoot is not a function`.

- [ ] **Step 3: Implement**

Extend the existing `-z` record walk in `status()` to collect paths, handling `1 `/`?`/`u ` (path is the remainder after the last space) and `2 ` (path is the remainder, and the *next* record is the original path and must be consumed, not parsed). `vaultRoot()` reads `process.env.HOLI_VAULT_ROOT` then `join(homedir(), 'Holi')`.

- [ ] **Step 4: Run and watch pass**

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/git.ts apps/desktop/src/main/vault/registry.ts apps/desktop/test/git.test.ts apps/desktop/test/registry.test.ts
git commit -m "feat(main): ~/Holi is where vaults live, and status names what changed"
```

---

## Task 2: Getting a clone

**Files:**
- Create: `apps/desktop/src/main/vault/clone.ts`, `apps/desktop/test/vault-clone.test.ts`

Everything here is tested against **local bare repos in tmpdirs**, exactly as `git.test.ts` does. Nothing mocks `execFile`, and nothing needs a token.

- [ ] **Step 1: Write the failing tests**

`describe('ensureClone')`:
- `clones when the path is empty` — outcome `cloned`, and the working tree has the bare repo's file in it.
- `adopts an existing clone of the same remote` — clone it yourself first, then `ensureClone`; outcome `adopted`, and **a local commit made before the call is still there afterwards**. This is the assertion decision 5 exists for.
- `refuses a directory that is not a repo` — `ClonePathInUse`, `foundRemote` is `null`, and the directory's contents are untouched.
- `refuses a clone of a different remote` — `ClonePathInUse`, `foundRemote` names what it found.
- `adopts a clone whose origin is not GitHub-shaped` — a `file:///` origin, which is exactly Task 12's fixture.
- `refuses a repo with no origin`.
- `creates parent directories` — `<root>/owner/repo` where `<root>/owner` does not exist.
- `refuses a remote that is not owner/repo` — reuses `isRemote`; a path traversal must not reach the filesystem.

- [ ] **Step 2: Run and watch fail**

Run: `pnpm exec vitest run test/vault-clone.test.ts`

- [ ] **Step 3: Implement**

`clonePathFor` for the destination; probe with `openRepo(...)` and read `origin` inside a try/catch to distinguish "not a repo" from "wrong remote".

**The comparison rule, decided:** an origin URL is *GitHub-shaped* if it matches `https://github.com/<owner>/<repo>(.git)?` or `git@github.com:<owner>/<repo>(.git)?`. Then:

| Path holds | origin | Result |
|---|---|---|
| nothing | — | `cloned` |
| a repo | GitHub-shaped **and** `owner/repo` equals the requested remote | `adopted` |
| a repo | GitHub-shaped and names a **different** `owner/repo` | `ClonePathInUse(foundRemote)` |
| a repo | not GitHub-shaped (e.g. `file:///…`) | `adopted` |
| a repo | none | `ClonePathInUse(null)` |
| not a repo | — | `ClonePathInUse(null)` |

The fourth row is the one that carries weight: a non-GitHub origin cannot be compared to an `owner/repo`, and the directory is under the managed root at the path Holi itself computes, so it is Holi's clone by construction. It is also what makes Task 12 possible with no OAuth app.

- [ ] **Step 4: Run and watch pass**

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/vault/clone.ts apps/desktop/test/vault-clone.test.ts
git commit -m "feat(main): clone it, or adopt what is already there"
```

---

## Task 3: A watcher that only says when

**Files:**
- Create: `apps/desktop/src/main/vault/watcher.ts`, `apps/desktop/test/vault-watcher.test.ts`

- [ ] **Step 1: Write the failing tests**

`describe('watchVault')`, with a short `debounceMs` (~30 ms) and a helper that waits for the next `onChange`:
- `fires when a file is added`.
- `fires when a file is changed`.
- `fires when a file is unlinked`.
- `coalesces a burst into one call` — write ten files in a tight loop; assert `onChange` fired **once**, not ten times. This is FR-5's "a board drag or an agent turn touching ten files is one commit".
- `does not fire for a write inside .git` — the load-bearing one. Write to `.git/holi-probe`, wait past the debounce, assert zero calls.
- `does not fire for an ignored path` — a `.holi-tmp-*` file, which is what every `writeAtomic` creates and deletes.
- `does not fire after close()`.
- `does not fire on startup for files that already exist` — `ignoreInitial`.

- [ ] **Step 2: Run and watch fail**

Run: `pnpm exec vitest run test/vault-watcher.test.ts`

- [ ] **Step 3: Implement**

`chokidar.watch(root, { ignoreInitial: true, ignored })` where `ignored` is `(abs) => { const rel = toVaultRel(root, abs); return rel === null || isIgnoredPath(rel) }`. One `setTimeout` handle, reset on every event; cleared in `close()`.

- [ ] **Step 4: Run and watch pass**

Expect this file to be the slowest new suite. If it flakes, **measure — do not widen the wait**; both chokidar theories in this repo that looked obvious were wrong.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/vault/watcher.ts apps/desktop/test/vault-watcher.test.ts
git commit -m "feat(main): a watcher that only says when"
```

---

## Task 4: `ActiveVault` — the snapshot half

**Files:**
- Create: `apps/desktop/src/main/vault/active-vault.ts`, `apps/desktop/test/active-vault.test.ts`

- [ ] **Step 1: Write the failing tests**

`describe('ActiveVault — snapshot')`, against a real clone of a local bare repo, with shrunken timings:
- `scans on open` — `snapshot()` holds the vault's docs before any event fires.
- `pushes a new snapshot when a file appears` — `onSnapshot` receives one containing the new doc.
- `pushes when a task file appears` — it lands in `tasks`, proving `scanVault` is doing the parsing.
- `pushes when a file is deleted`.
- `heals a dropped event` — do **not** try to make fsevents drop one. Construct the equivalent: write a file with the watcher already closed (or with `debounceMs` set absurdly high), then let the heal tick fire, and assert the snapshot catches up. This is the test that pins decision 6's whole justification.
- `does not push after close()`.
- `clears its timers on close` — assert no further `onSnapshot` after `close()` even past a heal interval.

- [ ] **Step 2: Run and watch fail**

Run: `pnpm exec vitest run test/active-vault.test.ts`

- [ ] **Step 3: Implement the snapshot half only**

`openActiveVault` scans once, starts `watchVault` with `rescanDebounceMs`, and starts the heal interval. Both call one internal `rescan()` that runs `scanVault`, caches, and calls `onSnapshot`. Guard `rescan()` with an in-flight flag. Leave commit, pull and publish unimplemented (throwing) for now.

- [ ] **Step 4: Run and watch pass**

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/vault/active-vault.ts apps/desktop/test/active-vault.test.ts
git commit -m "feat(main): the vault that is open, and what it sees"
```

---

## Task 5: `ActiveVault` — the commit loop

**Files:** modify `active-vault.ts`, `active-vault.test.ts`

- [ ] **Step 1: Write the failing tests**

`describe('ActiveVault — commit')`:
- `commits a dirty tree on the quiet timer` — write a file, wait, assert `repo.log()` grew by one and `status().dirty` is false.
- `commits nothing when the tree is clean` — assert the log did **not** grow after a tick, and that nothing threw.
- `coalesces a burst into one commit` — ten files, one commit. FR-5.
- `commits a file the watcher never reported` — the same construction as the heal test; decision 8's whole point is that `git status` is the truth. **This is the test that would fail under a watcher-driven loop.**
- `names a single changed file in the message` — FR-4, `Update <path>`, built from `dirtyPaths`.
- `names a count for a multi-file change` — FR-4.
- `commitNow() commits immediately` — ⌘S; no waiting for the timer.
- `pause() stops committing` and `resume() starts again` — FR-8.
- `does not commit when the repo is off the default branch` — decision 11. Check out a second branch, write a file, tick, assert no commit and `syncState()` is `paused`.
- `does not commit while a merge is in progress` — `status().merging`, same refusal.
- `commits in an unborn repo` — decision 11's exception; a fresh `createRepo` clone has no commits and its first autosave must land.

- [ ] **Step 2: Run and watch fail**
- [ ] **Step 3: Implement**

One `maybeCommit()`: read `status()`; if `detached || merging || (defaultBranch && branch !== defaultBranch)` set `paused` and return; if `!dirty` return silently; else `commitAll(message(dirtyPaths))`. Called by the watcher's quiet timer, the heal tick, and `commitNow()`. In-flight guard.

- [ ] **Step 4: Run and watch pass**
- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/vault/active-vault.ts apps/desktop/test/active-vault.test.ts
git commit -m "feat(main): git status decides when to commit"
```

---

## Task 6: `ActiveVault` — pull, publish, and the sync state

**Files:** modify `active-vault.ts`, `active-vault.test.ts`

- [ ] **Step 1: Write the failing tests**

`describe('ActiveVault — sync')`, with a second clone in the tmpdir playing the teammate, as `git.test.ts` does:
- `pulls on the interval` — teammate pushes, tick, assert the file arrived **and** a snapshot was pushed for it.
- `reports up-to-date when nothing changed`.
- `reports ahead with a count after a local commit` — FR-21's "N to publish".
- `pauses auto-pull after a conflicting pull` — FR-12. Assert the tree is clean afterwards (the merge aborted), the state is `conflict` with the paths, and **a second tick does not retry**.
- `publish pulls first` — FR-14; teammate pushes, we publish, both survive and the push succeeds.
- `publish stops on a conflicting pre-publish pull` — FR-15; nothing is pushed and local work is intact.
- `onFocus() pulls` — FR-9.
- `onFocus() is throttled` — two calls inside the window produce one fetch.
- `does not pull when off the default branch` — decision 11.
- `does not start a second pull while one is in flight`.

- [ ] **Step 2: Run and watch fail**
- [ ] **Step 3: Implement**

The pull interval, the focus throttle, `publish()`, and a single `setState()` that derives `SyncState` from the last `status()` plus the in-flight flags, calling `onSyncState` only when it actually changed (or the panel re-renders twice a second).

- [ ] **Step 4: Run and watch pass**
- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/vault/active-vault.ts apps/desktop/test/active-vault.test.ts
git commit -m "feat(main): pull on a timer, push only when asked"
```

---

## Task 7: `VaultHost`

**Files:** modify `active-vault.ts`, `active-vault.test.ts`

- [ ] **Step 1: Write the failing tests**

`describe('VaultHost')`:
- `opens a vault and makes it active`.
- `tears down the previous vault on switch` — assert the first vault's watcher no longer pushes, which is decision 2's entire content.
- `commits a dirty first vault before switching` — FR-6's vault-switch flush. A dirty tree left behind is one the next pull cannot merge.
- `is idempotent for the same remote` — opening the active vault twice does not restart the watcher.
- `close() leaves nothing running`.
- `throws for a remote that is not registered`.

- [ ] **Step 2: Run and watch fail**
- [ ] **Step 3: Implement** — ~40 lines over `openActiveVault`.
- [ ] **Step 4: Run and watch pass**
- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/vault/active-vault.ts apps/desktop/test/active-vault.test.ts
git commit -m "feat(main): one vault open at a time, and the seam that decides"
```

---

## Task 8: The seed, rewritten

**Files:**
- Modify: `packages/shared/src/path-safety.ts`, `packages/shared/test/path-safety.test.ts`
- Rewrite: `apps/desktop/src/main/agent/seed-content.ts`, `apps/desktop/test/seed-content.test.ts`
- Modify: `apps/desktop/src/main/agent/hooks/user-prompt-submit.mjs`

The existing `AGENTS.md` is **D60-stale prose, not a draft to extend**: it says "Edits sync live to every member. There is no commit step" (false — that is the whole product now), describes tasks as `tasks/<slug>-<id>.md` (false — `task.<name>.md` beside the note it is about), and instructs the agent to use `note_rename` / `task_set` / `task_list` ops that do not exist. Rewrite it against `docs/glossary.md`.

- [ ] **Step 1: Write the failing tests**

In `path-safety.test.ts`:
- `LOCAL_ONLY_IGNORE_LINES covers every path isLocalOnlyPath rejects` — assert `USER.md` and a `settings.local.json` are matched by the lines, so the constant cannot drift from the function.

In `seed-content.test.ts`:
- `writes the seed set into an empty vault`.
- `is idempotent` — a second call writes nothing and returns `[]`.
- `never overwrites an edited file` — change `AGENTS.md`, re-seed, assert the edit survives. FR: "a member who edits AGENTS.md keeps their edit forever."
- `creates .gitignore with the local-only lines`.
- **`appends missing lines to an existing .gitignore`** — seed into a vault that already has a `.gitignore` containing `node_modules`; assert `node_modules` survives **and** `USER.md` was added. This is decision 10's hole, and the test that closes it.
- `does not duplicate lines already present` — re-seeding twice leaves one `USER.md`.
- `preserves a .gitignore with no trailing newline` — append must not join onto the last line.
- `does not seed USER.md` — it is machine-local and the agent creates it.
- `a seeded vault commits nothing local-only` — the integration assertion: seed, write `USER.md` and `.holi/settings.local.json`, `commitAll`, assert neither is in `git show --name-only`. **This is the leak test and it is the reason this task exists.**

- [ ] **Step 2: Run and watch fail**

Run: `pnpm exec vitest run test/seed-content.test.ts && pnpm exec vitest run test/path-safety.test.ts --root packages/shared`

- [ ] **Step 3: Implement**

`ensureSeeded(root)`: `.gitignore` first (read, split, append absent lines from `LOCAL_ONLY_IGNORE_LINES`, write), then create-if-missing for the rest. Rewrite `AGENTS.md` and `MEMORY.md` against the glossary — notes are files, tasks are `task.<name>.md` beside the note they are about, wiki-links are paths, edits become autosave commits and leave the machine only on Publish. In the hook, replace `id=${t.id}` with the task's path; tasks have no ids.

- [ ] **Step 4: Run and watch pass**
- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/path-safety.ts packages/shared/test/path-safety.test.ts apps/desktop/src/main/agent/seed-content.ts apps/desktop/src/main/agent/hooks/user-prompt-submit.mjs apps/desktop/test/seed-content.test.ts
git commit -m "feat(main): seed the .gitignore that keeps USER.md out of the history"
```

---

## Task 9: The router grows a vault lifecycle

**Files:** modify `apps/desktop/src/main/router.ts`, `apps/desktop/test/router.test.ts`

- [ ] **Step 1: Write the failing tests**

Extend `rig()` to build a `VaultHost` over a tmpdir root. `describe('vaults.add')`:
- `clones, seeds, registers and opens` — assert the registry entry, `.gitignore` on disk, and a snapshot back.
- `adopts an existing clone` — decision 5, through the router.
- `refuses an occupied path that is not ours` — a `CONFLICT`, and the directory untouched.
- `refuses a malformed remote` — `BAD_REQUEST`.

`describe('vaults.create')`:
- `creates the repo, seeds, commits and pushes` — with a fake `session.api.createRepo` and a local bare repo as the target.
- `does not register the vault if the clone fails` — a half-registered vault is a vault the switcher can never open.

`describe('sync')`:
- `state returns the active vault's sync state`.
- `commitNow commits`.
- `publish reports a permission rejection as permission` — FR-16, the one the PRD names by number.
- `publish reports a conflicting pre-publish pull as a conflict, not a push failure` — FR-15.
- `refuses when no vault is active` — a clear error rather than a null dereference.

- [ ] **Step 2: Run and watch fail**
- [ ] **Step 3: Implement** — the seven procedures from §Contracts. `RouterDeps` gains `host`.
- [ ] **Step 4: Run and watch pass**
- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/router.ts apps/desktop/test/router.test.ts
git commit -m "feat(main): add a vault, make a vault, publish a vault"
```

---

## Task 10: The seam — ipc, preload, and the window

**Files:**
- Rewrite: `apps/desktop/src/main/ipc.ts`, `apps/desktop/src/main/index.ts`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/src/global.d.ts`
- Delete: `apps/desktop/src/main/vault/vault-manager.ts`

There is no unit test here — this is the Electron-only layer, and it is proven by Task 12. Keep it thin enough that that is honest: `ipc.ts` should be the tRPC handler, the `openExternal` handler, and a `send` helper, and nothing else.

- [ ] **Step 1: Delete the corpse and rewrite `ipc.ts`**

```bash
git rm apps/desktop/src/main/vault/vault-manager.ts
```

`registerIpc({ router, host, send })`: `ipcMain.handle('holi:trpc', …)` against the router, `ipcMain.handle('holi:openExternal', …)` → `shell.openExternal`. Nothing else survives.

- [ ] **Step 2: Rewrite the preload**

**Keep `pushChannel` verbatim** — one `ipcRenderer` listener per channel rather than per subscriber, and its comment explains why. Replace every channel it feeds with `vault:snapshot` and `vault:sync`. Rewrite `global.d.ts` to match; it currently declares `collab`, `PublicUser` and a `DocsEvent` it never imports.

- [ ] **Step 3: Rewrite `index.ts`**

In order: `requestSingleInstanceLock()` before `whenReady` (loser quits, winner focuses on `second-instance`); then `whenReady` → `createSession()` from `github/electron.ts` → `createVaultHost({ registry, gitDeps: { token: () => session.token() }, onSnapshot, onSyncState })` → `createRouter({ registry, session, openExternal, host })` → `registerIpc` → `createWindow`. `onFocus` on the window's `focus` event → `host.active()?.onFocus()`.

Quit: veto the first `before-quit`, `await host.close()` (which commits the dirty tree — FR-6), then `app.quit()`. **Do not import `agent-manager`** (§The rule).

- [ ] **Step 4: Typecheck**

Run: `pnpm exec tsc --noEmit 2>&1 | grep -c "^src/main/"`
Expected: **0** errors under `src/main/vault/`, `src/main/ipc.ts`, `src/main/index.ts`. The 5 under `src/main/agent/` remain, quarantined.

- [ ] **Step 5: Commit**

```bash
git add -A apps/desktop/src/main apps/desktop/src/preload apps/desktop/src/renderer/src/global.d.ts
git commit -m "feat(main): one seam, two push channels, and a window to hang them on"
```

> Watch `git add -A` around the deleted `vault-manager.ts` — it is a standing gotcha in this repo.

---

## Task 11: The instrument panel

**Files:**
- Create: `apps/desktop/src/renderer/src/panel/Panel.tsx`
- Modify: `apps/desktop/src/renderer/src/main.tsx`

Deliberately ugly and deliberately temporary (decision 3). Plan 5 deletes it. It must not import anything from `components/` or `state/` — those are quarantined, and reaching into them is how the boot path breaks.

- [ ] **Step 1: Build it**

One file, using the existing `lib/trpc.ts` client (which is sound) and `window.holi.onSnapshot` / `onSyncState`:

```
┌────────────────────────────────────────────────────┐
│ [vault ▾]  syv/notes    ● up to date   [Publish]   │  ← sync state, live
│ ─────────────────────────────────────────────────  │
│ add: [owner/repo____] [Add]  new: [name__] [Create]│
│ ─────────────────────────────────────────────────  │
│ docs (12)          │  path: notes/hello.md         │
│  notes/hello.md    │  ┌──────────────────────────┐ │
│  notes/deep/x.md   │  │ raw text, editable       │ │
│ tasks (3)          │  └──────────────────────────┘ │
│  task.ship-it.md   │  [Save]   [Commit now]        │
│ broken (0)         │                               │
└────────────────────────────────────────────────────┘
```

Flat lists, not a tree. `notes.read` / `notes.write` on the text box. No CodeMirror, no styling beyond what makes it legible.

- [ ] **Step 2: Point `main.tsx` at it**

Render `<Panel />` instead of `<App />`. Leave `App.tsx` on disk, unimported — plan 5 restores it.

- [ ] **Step 3: Verify it builds**

Run: `pnpm exec electron-vite build`
Expected: succeeds. A resolution failure here means something on the boot path still reaches a deleted module — find it and cut the import, do not repair the module.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/panel apps/desktop/src/renderer/src/main.tsx
git commit -m "feat(renderer): an instrument panel, to be thrown away"
```

---

## Task 12: Run it, against a bare repo, with no GitHub

**Files:** none — this is the acceptance run. Findings become fixes in the files above.

**This plan is not blocked on the GitHub OAuth app** (handoff §7: `CLIENT_ID` is still a placeholder and only Nicolai can register it). Decision 5 is why: a clone that is already on disk is *adopted*, and its `file:///` origin pushes and pulls with no token at all.

- [ ] **Step 1: Build the fixture**

```bash
export HOLI_VAULT_ROOT=/tmp/holi-dev
mkdir -p /tmp/holi-dev/local
git init --bare /tmp/holi-origin/notes.git
git clone /tmp/holi-origin/notes.git /tmp/holi-dev/local/notes
# seed one commit so the repo is not unborn, then push
```

- [ ] **Step 2: Launch and add the vault**

Run: `pnpm --filter @holi/desktop dev`
In the panel: add `local/notes`. Expect **adopted**, a registry entry, a `.gitignore` on disk, and a snapshot in the tree.

- [ ] **Step 3: Walk the loop, checking each against its requirement**

| Do | Expect | Requirement |
|---|---|---|
| Create a note in the panel | it appears in the tree within ~200 ms | FR-13 (editor PRD) |
| Create a file with `touch` in a terminal | it appears without a refetch | decision 6 |
| Type in the text box, save, wait 3 s | `git log` grows by one, tree is clean | FR-4, FR-7 |
| Touch ten files at once | **one** commit | FR-5 |
| Push from a second clone, wait | it arrives and the tree updates, silently | FR-9, FR-11 |
| Press Publish | commits reach the bare repo | FR-13 |
| Conflict the same line from both sides | banner state, tree stays **clean**, no `<<<<<<<` on disk | FR-12 |
| `git switch -c spike` in the clone | state reads paused, files still readable, no commits | decision 11 |
| Quit with an uncommitted change | it is committed before exit | FR-6 |
| Launch a second instance | it exits and focuses the first window | decision 9 |
| Write `USER.md`, wait for a commit | it is **not** in `git show --name-only` | decision 10 |

- [ ] **Step 4: Drive it headlessly**

`--remote-debugging-port` + `Runtime.evaluate` / `Input.insertText` — see the memory note on Electron e2e over CDP. Worth doing once here so plan 5 inherits a working rig.

- [ ] **Step 5: Record what was wrong**

Append an **Outcome** section to this document — what the plan got wrong, in the style of plans 1–3. The first run of an app that has never run is its own debugging session; budget for it and use `systematic-debugging` rather than guessing.

- [ ] **Step 6: Commit**

```bash
git add docs/plans/2026-07-22-main-process.md
git commit -m "docs: what the first run of Holi actually did"
```

---

## Definition of done

- `pnpm -r test` green.
- `pnpm exec tsc --noEmit` under `apps/desktop`: **zero** errors in `src/main/vault/`, `src/main/ipc.ts`, `src/main/index.ts`. The ~70 renderer errors and the 5 `src/main/agent/` errors remain, quarantined and expected.
- `pnpm exec electron-vite build` succeeds — the real proof that nothing on the boot path imports a deleted module.
- Every row of Task 12's table passes by hand.
- **A vault with a seeded `.gitignore` never commits `USER.md` or a `*.local.*` file.** If one thing in this plan is checked twice, it is this.

## Not in this plan

- **The editor's half of decision 7** — holding a base, calling `merge3`, the conflict banner. Plan 5. What plan 4 owes it is the coarse signal, and that debt is paid.
- **The real Shell, the file tree, the board, the daily note, history.** Plan 5, and the instrument panel is deleted when they land.
- **The agent drawer and the PTY.** `main/agent/` stays quarantined; `context-snapshot.ts` still reads `Task.id` and `Task.related`, which D60 deleted. Nothing writes `.holi/context.local.json` yet, so the seeded hook degrades to injecting `USER.md`/`MEMORY.md` — which is useful on its own and is why it is still seeded.
- **Reconcile.** `pause()`/`resume()` exist and the conflict state is reported; the *Ask Claude to reconcile* button re-runs the merge and seeds the drawer, which needs the drawer (FR-18).
- **Reminders.** They need N vaults live, which decision 2 explicitly does not build.
- **Onboarding.** Blocked on the OAuth app (handoff §7), and it is plan 5's ritual.
- **Squash on publish** (`vaults-sync.md` §Open question 3), **pausing auto-pull during an agent turn** (§Open question 5), **large-file warnings**, and **announcing a clean merge that touches the open file** (§Open question 4). All four want a measurement first.
