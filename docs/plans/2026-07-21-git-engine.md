# Git Engine Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `apps/desktop/src/main/git.ts` — clone, status, commit, pull-merge, push and log over the **system `git` binary**, so onboarding can clone a vault and the sync engine can keep it in step.

**Architecture:** One module, one small interface, deep implementation. Everything shells out to `git` via `execFile` (never a shell, so no argument injection). **Only plumbing and `--porcelain=v2` output is parsed** — human-readable porcelain is explicitly not a stable interface (`prd/vaults-sync.md` §How git is run). Credentials reach git through `GIT_ASKPASS` + an env var, never through argv or a rewritten remote URL.

**Tech Stack:** Node `child_process.execFile`, the system `git`, Vitest. No new dependencies.

**PRD:** [`docs/prd/vaults-sync.md`](../prd/vaults-sync.md) — FR-1/2 (clone, default branch), FR-4/5/7 (committing), FR-9/10/12 (pull, merge-never-rebase, abort on conflict), FR-13/14/16 (publish), FR-20 (abandon), and §History (`git log --follow`).

---

## Why this is testable without a network

Every test creates a **bare repo in a tmpdir and clones it**. That is a real remote to a real `git` — fetch, merge, push and conflict all behave exactly as they will against GitHub, with no network and no credentials. A second clone of the same bare repo plays "the teammate".

Do **not** mock `execFile`. The entire reason for shelling out is that the system binary's merge behaviour is the load-bearing property; a mock would test the plan's idea of git rather than git.

---

## File structure

| File | Responsibility |
|---|---|
| `apps/desktop/src/main/git.ts` | The whole engine. One `runGit` primitive, one `GitRepo` interface over a clone, one standalone `cloneRepo`. |
| `apps/desktop/src/main/git-askpass.mjs` | Three lines. Prints the token from the environment so git never prompts and the token never enters argv. |
| `apps/desktop/test/git.test.ts` | Behaviour tests against real temp repos. |

`git.ts` stays one file: `runGit` and the operations built on it change together, and splitting them would mean exporting the primitive purely to re-import it.

---

## Contracts

```ts
/** A conflict names paths, because the reconcile prompt is built from them. */
export type PullResult =
  | { kind: 'up-to-date' }
  | { kind: 'merged'; commits: number }
  | { kind: 'conflict'; paths: string[] }

export type PushResult =
  | { kind: 'pushed'; commits: number }
  | { kind: 'nothing-to-push' }
  | { kind: 'rejected'; reason: 'permission' | 'non-fast-forward' }

export interface RepoStatus {
  branch: string
  /** `origin/HEAD`'s target. FR-2: Holi syncs this branch and no other. */
  defaultBranch: string | null
  ahead: number
  behind: number
  dirty: boolean
  /** MERGE_HEAD exists — a merge is in progress, so a reconcile is live. */
  merging: boolean
  detached: boolean
  /** A repo with no commits yet. A freshly created GitHub repo is one, and
   *  onboarding's "New vault" walks straight into it. */
  unborn: boolean
}

export interface Commit {
  sha: string
  subject: string
  /** ISO 8601, author date. */
  date: string
  author: string
}

export interface GitRepo {
  status(): Promise<RepoStatus>
  /** Stage everything and commit. Returns the sha, or null when the tree was
   *  already clean — "nothing to commit" is the normal case on an idle timer,
   *  not an error. */
  commitAll(message: string): Promise<string | null>
  pull(): Promise<PullResult>
  push(): Promise<PushResult>
  /** FR-14: pull, then push. A non-fast-forward rejection is not worth showing
   *  a user when the fix is the pull that was going to happen anyway — so the
   *  rule lives here, in one place, rather than in each caller. A conflicting
   *  pre-publish pull returns the PullResult and pushes nothing (FR-15): the
   *  user's work stays local and intact. */
  publish(): Promise<PullResult | PushResult>
  log(opts?: { path?: string; limit?: number }): Promise<Commit[]>
  /** FR-20. Safe to call when no merge is in progress. */
  abortMerge(): Promise<void>
  readonly root: string
}

export function openRepo(root: string, deps?: GitDeps): GitRepo
export function cloneRepo(
  args: { remote: string; dest: string },  // remote is `owner/repo`
  deps?: GitDeps,
): Promise<GitRepo>

export interface GitDeps {
  /** The GitHub token, read lazily so a sign-out takes effect immediately. */
  token?: () => string | null
  /** Identity for commits, so a machine with no global git config still works. */
  identity?: { name: string; email: string }
}

export class GitError extends Error {
  code: number
  stderr: string
}
/** `git` is not installed. Deserves its own type: the message is advice, not a trace. */
export class GitMissingError extends Error {}
```

---

## Gotchas — read before writing code

- **`GIT_TERMINAL_PROMPT=0` on every invocation.** Without it, an auth failure makes git block forever on a terminal prompt that no one can answer, and the test suite hangs rather than fails.
- **The token must not enter argv.** `-c http.extraheader=...` is visible in `ps` to every process on the machine. Use `GIT_ASKPASS` pointing at `git-askpass.mjs` with the token in the child's env instead. The script gets the prompt text as `argv[2]`: print `x-access-token` when it mentions `Username`, the token otherwise.
- **`user.name`/`user.email` may be unset.** A commit then fails with a message about identity. Pass `-c user.name=… -c user.email=…` on the commit invocation so Holi works on a machine that has never configured git.
- **`git merge --abort` fails when no merge is in progress**, so check `MERGE_HEAD` (or tolerate the failure) rather than assuming.
- **An unborn repo has no `HEAD`.** `status`, `log` and `push` must all survive it — a repo created by "New vault" has zero commits until the seed lands.
- **`# branch.ab +N -M` only appears** in `--porcelain=v2 --branch` output when the branch has an upstream. No upstream → no line → `ahead`/`behind` stay 0, which is correct, not a parse failure.
- **Porcelain v2 paths are escaped and quoted when they contain unusual bytes**, and `-z` changes the record separator to NUL. Use `-z` and split on NUL; do not split on newline, or a filename with a newline in it corrupts the parse.
- **A conflicted merge writes `<<<<<<<` markers into files.** FR-12 aborts *immediately* so autosave can never commit them. Abort before returning the conflict, not after the caller asks.
- **`execFile` has a default `maxBuffer`.** A large `git log` can exceed it; set it explicitly.
- **Two Holi instances on one clone would race** (PRD §Edge cases). Out of scope here — note it, do not build a lock in this plan.

---

## Task 1: The `runGit` primitive

**Files:**
- Create: `apps/desktop/src/main/git.ts`
- Create: `apps/desktop/src/main/git-askpass.mjs`
- Create: `apps/desktop/test/git.test.ts`

- [x] **Step 1: Write failing tests for the primitive's contract**

In `git.test.ts`, a `describe('runGit')` covering:
- `runs a command in the given cwd and returns stdout` — `git rev-parse --is-inside-work-tree` in a temp repo returns `true`.
- `throws GitError carrying the exit code and stderr` — `git cat-file -p deadbeef` in a repo fails; assert `err.code` is non-zero and `err.stderr` is non-empty.
- `throws GitMissingError when the binary is absent` — inject a `gitPath` of `definitely-not-git` and assert the type. (Take the binary path as an internal option so this is testable without touching PATH.)

Helper for the whole file — write it now, every later task uses it:

```ts
// makeRemote(): a bare repo in a tmpdir, seeded with one commit on the default
// branch, returned as a file:// URL. makeClone(remote): a working clone of it.
// Both register their tmpdir for afterAll cleanup.
```

Seed the bare repo by cloning it, committing a `README.md`, and pushing — a truly empty bare repo has no default branch, and every later test wants one.

- [x] **Step 2: Run the tests and watch them fail**

Run: `cd apps/desktop && pnpm exec vitest run test/git.test.ts`
Expected: FAIL — `runGit is not a function`.

- [x] **Step 3: Implement `runGit`, `GitError`, `GitMissingError`**

`execFile` with `env: {...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_ASKPASS: <askpass path>, HOLI_GIT_TOKEN: token() ?? ''}`, an explicit `maxBuffer`, and `ENOENT` mapped to `GitMissingError`.

Write `git-askpass.mjs` in the same step — it is part of this contract, not a later one.

- [x] **Step 4: Run the tests and watch them pass**

- [x] **Step 5: Commit**

```bash
git add apps/desktop/src/main/git.ts apps/desktop/src/main/git-askpass.mjs apps/desktop/test/git.test.ts
git commit -m "feat(desktop): shell out to git, without putting the token in argv"
```

---

## Task 2: `status` — parsing `--porcelain=v2`

**Files:**
- Modify: `apps/desktop/src/main/git.ts`
- Modify: `apps/desktop/test/git.test.ts`

- [x] **Step 1: Write failing tests**

`describe('status')`:
- `reports a clean clone as clean, with no divergence` — `dirty: false`, `ahead: 0`, `behind: 0`, `merging: false`, `detached: false`, `unborn: false`.
- `reports an edited file as dirty` — write a file, expect `dirty: true`.
- `reports an untracked file as dirty` — an autosave commit must pick these up, so they count.
- `counts commits ahead of the upstream` — commit twice locally, expect `ahead: 2`.
- `counts commits behind` — push from a second clone, `git fetch`, expect `behind: 1`.
- `names the default branch from origin/HEAD`.
- `survives a repo with no commits` — `unborn: true`, and nothing throws.
- `reports a detached HEAD` — FR-2 refuses to sync one, so it must be detectable.

- [x] **Step 2: Run and watch fail**

- [x] **Step 3: Implement `status`**

`git status --porcelain=v2 --branch --untracked-files=all -z`. Parse the `# branch.*` headers and count entry lines. `defaultBranch` from `git symbolic-ref --short refs/remotes/origin/HEAD` (tolerate absence → `null`). `merging` from the existence of `.git/MERGE_HEAD`.

- [x] **Step 4: Run and watch pass**

- [x] **Step 5: Commit** — `feat(desktop): read repo state from porcelain v2 only`

---

## Task 3: `commitAll`

**Files:** modify `git.ts`, `git.test.ts`

- [x] **Step 1: Write failing tests**

`describe('commitAll')`:
- `commits every change as one commit` — change three files, expect one new commit and a clean tree after (FR-5: a board drag is one commit, not three).
- `includes untracked files` — a new note must land in the commit.
- `returns null when there is nothing to commit` — the idle timer fires constantly on an untouched vault; this is the normal path, not an error.
- `commits on a machine with no git identity configured` — run with `-c user.useConfigOnly=true` in the env or an empty `HOME`, and assert the commit still succeeds via the injected identity.
- `leaves the tree clean` — `status().dirty` is false afterwards (FR-7).

- [x] **Step 2: Run and watch fail**
- [x] **Step 3: Implement** — `git add -A` then `git -c user.name=… -c user.email=… commit -m …`; check `status().dirty` first and return `null` when clean.
- [x] **Step 4: Run and watch pass**
- [x] **Step 5: Commit** — `feat(desktop): an edit becomes one local commit`

---

## Task 4: `pull` — merge, never rebase

**Files:** modify `git.ts`, `git.test.ts`

This is the load-bearing task. FR-10 and FR-12 both live here.

- [x] **Step 1: Write failing tests**

`describe('pull')`:
- `is up-to-date when the remote has not moved`.
- `merges a clean incoming change` — teammate clone commits and pushes a *different* file; pull returns `merged` and the file appears locally.
- `merges when both sides changed different files` — the ordinary shared-vault case; both survive.
- `merges when both sides changed different lines of the same file` — git merges frontmatter line-by-line; both edits survive. (`prd/tasks.md` §Concurrency promises this explicitly.)
- `reports a conflict and leaves the tree CLEAN` — both sides change the same line. Assert `kind: 'conflict'`, the path is named, **and `status()` afterwards is `dirty: false, merging: false`**. This is FR-12 and it is the most important assertion in the file: if the abort does not run, autosave commits conflict markers.
- `never rebases` — after a merge, assert the local commit that existed before the pull still has its original sha (a rebase would rewrite it).

- [x] **Step 2: Run and watch fail**
- [x] **Step 3: Implement**

`git fetch origin`, then `git merge --no-edit origin/<defaultBranch>`. **Not `--no-rebase`** — that is a `git pull` option and `git merge` rejects it with a usage error; an explicit fetch-then-merge is inherently a merge, which is also why it is two observable steps rather than a `pull`. On non-zero exit, read conflicted paths from `git diff --name-only --diff-filter=U -z`, run `git merge --abort`, and return them. Count merged commits with `git rev-list --count HEAD@{1}..HEAD` or by comparing before/after shas.

- [x] **Step 4: Run and watch pass**
- [x] **Step 5: Commit** — `feat(desktop): pull merges, and a conflict aborts before it can be committed`

---

## Task 5: `push`

**Files:** modify `git.ts`, `git.test.ts`

- [x] **Step 1: Write failing tests**

`describe('push')`:
- `pushes local commits to the default branch` — the bare remote's HEAD advances.
- `reports nothing-to-push when already in step`.
- `reports a non-fast-forward rejection distinctly` — teammate pushes, we commit without pulling, push is rejected; assert `reason: 'non-fast-forward'` rather than a generic failure (FR-14 hands this to the pull that was going to happen anyway).
- `reports a permission rejection distinctly` — simulate by making the bare repo read-only (`chmod -R a-w`) and asserting `reason: 'permission'`. FR-16: this must never be reported as a network or merge failure.

Skip the permission test on Windows via `it.skipIf(process.platform === 'win32')` — the chmod trick does not hold there.

- [x] **Step 2: Run and watch fail**
- [x] **Step 3: Implement** — `git push origin HEAD:<defaultBranch>`; classify stderr on failure by matching git's stable rejection reasons, falling back to a plain `GitError`.
- [x] **Step 4: Run and watch pass**
- [x] **Step 5: Commit** — `feat(desktop): publish, and say why a push was refused`

- [x] **Step 6: Write failing tests for `publish` (FR-14/15)**

`describe('publish')`:
- `pulls before pushing, so a moved remote is not an error` — teammate pushes a different file, we commit, `publish()` succeeds and the remote holds both. Without the pull-first rule this is the non-fast-forward rejection from Step 1.
- `stops and reports the conflict without pushing` — teammate and we change the same line; `publish()` returns the `conflict` PullResult, the remote is unchanged, and the local tree is clean (the abort still ran).

- [x] **Step 7: Implement `publish`** — `pull()`, return its result immediately if `kind === 'conflict'`, otherwise `push()`.

- [x] **Step 8: Run, watch pass, commit** — `feat(desktop): publish pulls first`

---

## Task 6: `log` and `abortMerge`

**Files:** modify `git.ts`, `git.test.ts`

- [x] **Step 1: Write failing tests**

`describe('log')`:
- `returns commits newest first, with sha, subject, date and author`.
- `follows a file through a rename` — `--follow`; the history PRD promises the open file's timeline survives a rename.
- `respects the limit`.
- `returns an empty list for a repo with no commits` — not a throw.

`describe('abortMerge')`:
- `restores a clean tree mid-merge` — start a conflicting merge by hand, abort, assert clean.
- `is a no-op when no merge is in progress` — FR-20's control can be pressed twice.

- [x] **Step 2: Run and watch fail**
- [x] **Step 3: Implement** — `git log -z --format=%H%x1f%s%x1f%aI%x1f%an` (unit separators, NUL records — never `--pretty` text we would have to guess the shape of), plus `--follow -- <path>` and `-n <limit>`.
- [x] **Step 4: Run and watch pass**
- [x] **Step 5: Commit** — `feat(desktop): history is git history`

---

## Task 7: `cloneRepo`

**Files:** modify `git.ts`, `git.test.ts`

- [x] **Step 1: Write failing tests**

`describe('cloneRepo')`:
- `clones a remote into the given directory and returns a usable repo` — `status()` on the result is clean and names the default branch.
- `refuses a destination that already exists and is not empty` — clobbering a directory that may hold unpublished commits is never acceptable (the same rule `vaults.remove` and `notes.create` follow).
- `creates parent directories on the way`.
- `surfaces a clone failure as GitError with stderr` — clone a remote that does not exist.

- [x] **Step 2: Run and watch fail**
- [x] **Step 3: Implement** — build the HTTPS URL from `owner/repo`, `git clone <url> <dest>`, return `openRepo(dest)`. Take the remote as `owner/repo` and let the module own URL construction, so no caller ever hand-builds one with a token in it.
- [x] **Step 4: Run and watch pass**
- [x] **Step 5: Commit** — `feat(desktop): a vault is a clone`

---

## Task 8: ~~Wire the askpass path for both dev and packaged builds~~ — REMOVED

**Not needed.** The premise was a shipped `git-askpass.mjs` resolved via
`import.meta.url`, and two things kill it: `electron-vite` bundles main to CJS
(no `"type": "module"`), so `import.meta.url` does not survive the build; and a
`#!/usr/bin/env node` shebang assumes a working `node` on PATH. The script is
materialized at first use instead — a POSIX `sh` (or `.bat`) file in a `mkdtemp`
directory — which behaves identically under vitest, `electron-vite dev` and a
packaged build, and needs no build-config change at all.

<details><summary>Original task</summary>

**Files:** modify `git.ts`, possibly `apps/desktop/electron.vite.config.*`

- [x] **Step 1: Confirm the failure**

`git-askpass.mjs` must exist *on disk next to the built main bundle* at runtime. Under `electron-vite` the main process is bundled into `out/main/`, and a stray `.mjs` beside the source is not copied. Check `apps/desktop/electron.vite.config.*` for how main is built, then verify by building: `pnpm --filter @holi/desktop build` and looking for the file in `out/main/`.

- [x] **Step 2: Make it resolve in both modes**

Resolve the path relative to `__dirname` with a dev fallback to the source location, and add whatever copy step the config needs. Assert the resolved path exists at module load and throw a clear error naming it if not — a missing askpass means every authenticated git operation hangs, and that is a terrible thing to debug at runtime.

- [ ] **Step 3: Commit** — `fix(desktop): the askpass helper ships with the main bundle`

</details>

---

## Outcome — completed 2026-07-21

**48 tests, all green**, in `apps/desktop/test/git.test.ts`. Every invariant below verified.

Three things the plan got wrong, corrected in place:

1. **`git merge --no-rebase` does not exist** — `--no-rebase` is a `git pull` option; merge rejects it with a usage error. An explicit fetch-then-merge is inherently a merge.
2. **The chmod permission test simulated the wrong failure.** A read-only local bare repo fails at the object-write layer (`unpacker error`), not at auth. GitHub's real refusal is `remote: Permission to … denied` plus a 403. The classifier is now unit-tested against verbatim output, and returns **null** when it cannot tell — because telling someone they lost write access when their disk is full is the same class of misreport FR-16 forbids.
3. **Task 8 was unnecessary** (see above).

One finding that outlives this plan: **git conflicts on adjacent line edits.** `prd/tasks.md` §Concurrency promises that two people editing different fields of one task both survive; that holds only when the fields are not neighbours, and `status`/`due` are adjacent in the PRD's own example format. Both behaviours are pinned by tests. **The PRD text needs a correction — Nicolai's call.**

## Definition of done

- `pnpm --filter @holi/desktop test` green, with `git.test.ts` covering every behaviour above.
- `pnpm -r typecheck` shows **no new errors** — `git.ts` is a new file with no dependents yet, so it should typecheck clean on its own.
- No test mocks `execFile`.
- No parse of any non-porcelain, non-plumbing git output.
- The token appears in no argv anywhere in the module.

## Not in this plan

- **The autosave timer, the pull interval, and window-focus triggers.** This plan builds the operations; scheduling them is the orchestrator's job (plan 4), and the debounce values are open questions in the PRD.
- **The reconcile flow** (banner, agent hand-off, read-only editors) — needs the agent drawer and the renderer.
- **A lock against two Holi instances on one clone** — real (PRD §Edge cases), but it belongs with the orchestrator that would take it.
- **Squash on publish** — open question 3 in the PRD; leaning no.
