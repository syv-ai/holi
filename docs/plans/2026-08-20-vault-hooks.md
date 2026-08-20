# Vault hooks — three managed transforms Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three vault-wide transforms run at the commit boundary — relink files moved outside Holi, archive done tasks, normalize markdown — with Holi shipping the code, the vault choosing which run, and a log the agent can read.

**Architecture:** A `pre-commit` hook seeded from the binary into `.holi/git-hooks/` (a D75-managed file), with `core.hooksPath` pointed there on vault open. The vault's committed settings say **which** transforms are enabled; they never say what a transform *is*, because `core.hooksPath` into the tracked tree would mean a teammate's push runs code on your laptop. Transforms rewrite and restage — they are active, not gates — and a failure logs, tells the agent, and lets the commit through, because Holi's auto-commit is the user's save.

**Tech Stack:** TypeScript, `simple-git-hooks`-shaped generated scripts (the pattern this repo already uses on itself), `git diff --cached -M` for rename detection, the existing `hook-server` for agent notification, Vitest (`node`).

**Spec/decisions:** `docs/decisions.md` **D76** (this plan implements it) and **D75** (managed files; this plan's hook scripts are one). **Depends on `2026-08-20-vault-apps-slice2.md`** — Tasks 4–5 there build the managed-file class and the ops routes this plan seeds into and reports through. Do that plan first.

---

## Scope

**In:** the seeded `pre-commit` runner and its `core.hooksPath` wiring; the enable list in `.holi/settings.json`; a machine-local run log; agent notification; a circuit breaker; and exactly three transforms — `relink`, `archive-done`, `normalize-md`. `.holi/git-hooks/` joins the agent surface.

**Out, and deliberately:** a general hook framework, user-authored hook scripts, any hook that can block a commit, `pre-push`/`post-merge`, and a fourth transform. Designing the config surface before a second hook has asked for one is the argument that killed `manifest.json` in D74.

## File map

- `apps/desktop/src/main/vault/hooks/runner.ts` *(new)* — reads the enable list, runs the enabled transforms over the staged set, restages, writes the log. Pure enough to test without git by taking its staged set as an argument.
- `apps/desktop/src/main/vault/hooks/staged.ts` *(new)* — `stagedChanges(root)`: `git diff --cached --name-status -M` parsed into adds/mods/renames.
- `apps/desktop/src/main/vault/hooks/relink.ts` *(new)*
- `apps/desktop/src/main/vault/hooks/archive-done.ts` *(new)*
- `apps/desktop/src/main/vault/hooks/normalize-md.ts` *(new)*
- `apps/desktop/src/main/vault/hooks/log.ts` *(new)* — append to `.holi/hooks.local.log`, capped.
- `apps/desktop/src/main/agent/hooks/pre-commit.mjs` *(new)* — the seeded script; a thin shim that calls back into Holi over the ops port, so the transform logic lives in TypeScript and is testable.
- `apps/desktop/src/main/agent/seed-content.ts` — `.holi/git-hooks/pre-commit` into `MANAGED_FILES`; `HOOKS` defaults into `.holi/settings.json`.
- `apps/desktop/src/main/vault/active-vault.ts` — set `core.hooksPath` on open.
- `packages/shared/src/path-safety.ts` — `.holi/git-hooks/` into `isAgentSurfacePath`.
- Tests: `packages/shared/test/path-safety.test.ts` (extend), `apps/desktop/test/{hook-staged,hook-runner,hook-relink,hook-archive-done,hook-normalize-md,hook-log}.test.ts`.

## Contracts

```ts
// apps/desktop/src/main/vault/hooks/staged.ts

/** What git says is about to be committed. **Renames come from git's own
 *  detection (`-M`) and this is the whole reason the transforms live at the
 *  commit boundary**: to Holi's watcher a move is a delete plus an add, so the
 *  from→to map simply does not exist anywhere else. */
export interface StagedChanges {
  added: string[]
  modified: string[]
  renamed: { from: string; to: string }[]
}
export async function stagedChanges(root: string): Promise<StagedChanges>
```

```ts
// apps/desktop/src/main/vault/hooks/runner.ts

export type TransformName = 'relink' | 'archive-done' | 'normalize-md'

/** A transform reads the staged set and returns the files it rewrote. It may
 *  NEVER throw to the caller as a veto: the runner catches, logs, notifies, and
 *  the commit proceeds. */
export interface Transform {
  name: TransformName
  run(root: string, staged: StagedChanges): Promise<{ changed: string[]; notes: string[] }>
}

export interface HookRun {
  changed: string[]                                  // restaged by the runner
  failed: { name: TransformName; error: string }[]
  disabled: TransformName[]                          // tripped the breaker
}
export async function runPreCommit(root: string, staged: StagedChanges): Promise<HookRun>
```

```jsonc
// .holi/settings.json — committed. Data, never code (D76).
{
  "hooks": { "relink": true, "archive-done": false, "normalize-md": true }
}
// Keys ARE the TransformName values, kebab and all. A camelCase settings key
// beside a kebab transform name is a mapping table that exists only to be got
// wrong once.
//
// `archive-done` defaults OFF: it moves task files, which changes what the board
// shows. A transform that rearranges someone's work is opt-in.
```

---

## Task 1: the agent surface grows a member

**Files:** Modify `packages/shared/src/path-safety.ts`; test `packages/shared/test/path-safety.test.ts`.

- [ ] **Write failing tests:** `isAgentSurfacePath('.holi/git-hooks/pre-commit')` → true; `.holi/git-hooks/anything` → true; `.holi/theme.json` still false; `.holi/apps/x/index.html` still false.
- [ ] Run `pnpm --filter @holi/shared exec vitest run path-safety` → FAIL.
- [ ] **Implement**, and put the reason in the doc comment: slice-1 apps cannot write at all, but writes are coming, and a `pre-commit` an app could write is the same escalation as the `google-send-gate.mjs` it is already barred from — one runs on the agent's behalf, the other on git's, and both run as the user.
- [ ] Run → PASS. Commit: `feat(shared): vault git hooks are part of the agent surface`.

## Task 2: reading the staged set

**Files:** Create `apps/desktop/src/main/vault/hooks/staged.ts`; test `apps/desktop/test/hook-staged.test.ts`.

- [ ] **Write failing tests** against a real temp repo (`test/helpers/git-fixtures.ts` already builds these — read it first): a staged add appears in `added`; a staged edit in `modified`; **`git mv a.md b.md` appears as one `renamed` entry, not an add plus a delete**; a rename *with* an edit (git reports `R087`) still lands in `renamed`; an unstaged change appears nowhere; a binary file is included (the transforms filter, not this).
- [ ] Run `pnpm exec vitest run --project node hook-staged` → FAIL.
- [ ] **Implement** with `git diff --cached --name-status -M -z`. Use `-z`: a vault has paths with spaces and non-ASCII (`nøter/æøå.md` is in the path-safety tests), and the unquoted form mangles them.
- [ ] Run → PASS. Commit: `feat(hooks): read the staged set, with git's rename detection`.

## Task 3: `relink`

**Files:** Create `apps/desktop/src/main/vault/hooks/relink.ts`; test `apps/desktop/test/hook-relink.test.ts`.

- [ ] **Write failing tests:** with `a.md` renamed to `sub/b.md` and `c.md` containing `[[a.md]]`, `c.md` is rewritten to `[[sub/b.md]]` and named in `changed`; a `[[a.md|Label]]` keeps its label; a chain (`a→b`, `b→c` in one commit) resolves to the final destination and does **not** double-rewrite; no renames ⇒ no files read and `changed` empty; a link inside a fenced code block is left alone if `rewriteWikiLinksMulti` already guarantees that — **check it, and if it does not, this transform must not be the place that starts.**
- [ ] Run `pnpm exec vitest run --project node hook-relink` → FAIL.
- [ ] **Implement by reusing `rewriteWikiLinksMulti`**, which `moveNotes` already uses for exactly this in one read-all-then-write pass. Read `main/vault/move.ts` first: its doc comment explains why N independent renames race and double-rewrite, and this transform inherits that reasoning wholesale. Do **not** move files — git already did; only inbound links need fixing.
- [ ] Run → PASS. Commit: `feat(hooks): rewrite links for a file moved outside Holi`.

**Why this one matters most:** `AGENTS.md` currently tells the agent to grep for `[[<path>` and rewrite by hand before moving a file. That instruction is followed inconsistently and silently produces dangling links. This makes the vault's own commit fix it.

## Task 4: `archive-done`

**Files:** Create `apps/desktop/src/main/vault/hooks/archive-done.ts`; test `apps/desktop/test/hook-archive-done.test.ts`.

- [ ] **Write failing tests:** a `task.*.md` with `status: done` and a `completedAt` older than the threshold moves under `archive/`; one done *today* does not (a task completed this morning is still what the user is looking at); a `todo`/`doing` task never moves; **inbound `[[links]]` to a moved task are rewritten** (reuse Task 3's helper — a moved task with a stranded link is the exact harm `sweepDaily`'s backref guard exists to prevent; read `main/vault/daily.ts`); the transform is a **no-op when `hooks['archive-done']` is false or absent**; running twice moves nothing the second time.
- [ ] Run `pnpm exec vitest run --project node hook-archive-done` → FAIL.
- [ ] **Implement.** `parseTaskFile` decides done-ness — never a regex over the text, and never the filename (the vault store's own two rules; see `vault-store.ts`). If `Task` carries no completion date, **the threshold has to come from git** (`git log -1 --format=%cI` for the file) rather than from mtime, which a checkout resets. Say which you used in the log line.
- [ ] Run → PASS. Commit: `feat(hooks): archive done tasks, links and all`.

## Task 5: `normalize-md`

**Files:** Create `apps/desktop/src/main/vault/hooks/normalize-md.ts`; test `apps/desktop/test/hook-normalize-md.test.ts`.

- [ ] **Write failing tests:** trailing whitespace is stripped; a missing final newline is added; CRLF is left **alone** (a Windows collaborator's line endings are not a defect to fix in their file); a task file round-trips through `parseTaskFile`/`serializeTaskFile` so its frontmatter key order is canonical; **prose is never reflowed** — assert a 300-character paragraph comes back byte-identical; a fenced code block is untouched, indentation included; a file already normal is not rewritten at all (idempotent, and it must not appear in `changed`).
- [ ] Run `pnpm exec vitest run --project node hook-normalize-md` → FAIL.
- [ ] **Implement.** **No prose reflow, ever** — the editor autosaves and Holi auto-commits, so a reflow fires mid-sentence on a file someone has open, moving their cursor. This repo's own memory records that `prettier --write` corrupts it; a vault's notes deserve more caution than a codebase, not less. Safe, idempotent, invisible changes only.
- [ ] Run → PASS. Commit: `feat(hooks): normalize markdown without touching anyone's prose`.

## Task 6: the runner, the log, and never blocking

**Files:** Create `runner.ts` and `log.ts`; tests `apps/desktop/test/hook-runner.test.ts`, `hook-log.test.ts`.

- [ ] **Write failing tests:** only enabled transforms run; a transform that **throws** is caught, lands in `failed`, and the run still returns (assert the commit is not vetoed); rewritten files are restaged (`git diff --cached` shows the rewrite, so the commit contains it rather than leaving it for the next one); a transform failing 3 runs in a row appears in `disabled` and is skipped on the 4th; the log is appended to `.holi/hooks.local.log`, `isLocalOnlyPath` says true for it, and it is capped (write 10k lines, assert the file stays bounded and keeps the **newest**).
- [ ] Run `pnpm exec vitest run --project node hook-runner hook-log` → FAIL.
- [ ] **Implement.** The breaker's state is per-session in memory, not in the log — a restart is a fair reason to try again. Notify the running agent through the ops seam from slice 2 Task 5; when no agent is listening this must be a silent no-op, never an error that becomes the failure it was reporting.
- [ ] Run → PASS. Commit: `feat(hooks): run the transforms, log what happened, never veto a commit`.

## Task 7: seed the hook and point git at it

**Files:** Create `apps/desktop/src/main/agent/hooks/pre-commit.mjs`; modify `seed-content.ts` and `active-vault.ts`; extend `seed-content.test.ts` and `active-vault.test.ts`.

- [ ] **Write failing tests:** `ensureSeeded` writes `.holi/git-hooks/pre-commit`, executable, and it is in `MANAGED_FILES` (so D75 refreshes it — a hook Holi cannot update is a hook Holi cannot fix); opening a vault sets `core.hooksPath` to `.holi/git-hooks` in that clone's **local** config (assert `git config --local`, and that `--global` is untouched); a vault whose settings enable nothing still gets the hook installed but the runner does nothing; the hook **exits 0 even when the runner errors** (drive it as a process, and assert the exit code — this is the guarantee the whole design rests on).
- [ ] Run `pnpm exec vitest run --project node seed active-vault` → FAIL.
- [ ] **Implement.** Keep `pre-commit.mjs` a shim: it curls the ops port and exits 0 on any failure including "Holi is not running" — someone committing from a terminal with the app closed must not be blocked by us. All real logic stays in TypeScript where it is tested.
- [ ] Run → PASS. Commit: `feat(hooks): seed the pre-commit runner and point the clone at it` (D76).

## Task 8: tell the agent and the user

**Files:** Modify the seeded `AGENTS.md` in `seed-content.ts`; extend `seed-content.test.ts`.

- [ ] **Write a failing test** asserting `AGENTS.md` gains a Hooks section naming `.holi/hooks.local.log` and the enable list, and that its **stale link-rewrite instruction is gone** when `relink` is on — the file currently tells the agent to grep and rewrite by hand, which is now the hook's job and a second actor doing it is how a link gets rewritten twice.
- [ ] Run → FAIL. **Implement**, keeping it to four lines: what runs, where the log is, that a failure never blocks a commit, and that Holi already suspends its own commit loop during the agent's turn (`pause(reason)` plus the `UserPromptSubmit`→`Stop` brackets) so the agent does not need to arrange that itself.
- [ ] Run → PASS. Commit: `docs(hooks): tell the agent what runs on commit and where the trace is`.

## Task 9: gates and hand verification

- [ ] Full gates, as in the slice-2 plan (node, dom, shared, typecheck, eslint — 0 errors and exactly the 2 known warnings).
- [ ] **In a scratch vault, not the real one.** `apps/desktop/verify-focus-pull.sh` shows the local-bare-repo rig: a bare origin, a clone, `vaults.add` on a pre-cloned path, no token and no network. These transforms rewrite files, so prove them somewhere disposable first.
- [ ] By hand: `git mv` a linked note in a terminal, commit, and confirm the referring note was rewritten **in that same commit**; confirm the log names what changed; break a transform deliberately and confirm the commit still lands and the failure is in the log.
- [ ] Commit `docs/verification/<date>-vault-hooks.md`.

---

## Gotchas

- **`pnpm exec` always.** Absolute paths — the shell's cwd drifts.
- **Never `prettier --write` this repo.** `printWidth` 100, wrap by hand.
- **Main-process edits do not restart the dev app.** Almost everything here is main-side.
- **`git diff --cached -z`**, or paths with spaces and non-ASCII come back quoted and mangled.
- **Restage what you rewrite**, or the fix lands in the *next* commit and the one being made is still wrong.
- **A rename with edits is `R<score>`, not `R100`.** Match the letter, not the number.
- **The hook must exit 0 when Holi is not running.** Someone committing from a terminal with the app closed is a normal thing to do.
- **`archive-done` defaults off**, and moving a task file needs the link rewrite or it strands `[[task:*]]` references.
- **Never reflow prose.** The editor autosaves and Holi auto-commits, so a reflow lands mid-sentence in an open file.
- **Do not let a transform failure become a commit failure.** The commit is the user's save; the transform is an opinion.
