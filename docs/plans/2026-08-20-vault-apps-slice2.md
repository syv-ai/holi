# Vault apps — slice 2 Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The agent can finish an app, open it, and be told immediately when it wrote something that will not work — closing the loop slice 1 left open, where the agent writes an app blind and asks the user to go look.

**Architecture:** Three pieces that only make sense together. A **manifest** (`app.yaml`) makes registration explicit, so an app becomes real when the agent says it is finished rather than when its first file lands. A **`holi` CLI** — the `holi-google` pattern, a generated shell script over a localhost route with a per-instance token — gives the agent `app open` and `seed refresh`. A **PostToolUse validator** turns the authoring skill from documentation into a feedback loop, which is what makes the manifest safe: a forgotten manifest is silent non-appearance, and silence is the failure mode slice 1 proved is worst.

**Tech Stack:** TypeScript, Electron, the existing `hook-server` (localhost + per-instance token), tRPC over IPC, a `.mjs` Claude Code hook, Vitest (`node` for main/pure, `packages/shared`, `dom` for components).

**Spec:** `docs/prd/vault-apps.md`. **Decisions:** `docs/decisions.md` D75 (managed files are refreshed, not frozen). D74 §Anatomy rejected a manifest — read why before Task 1; this one has a different job and the plan says so.

---

## Scope

**In:** `app.yaml` as the registration marker and a one-time migration for slice-1 apps; the `holi` CLI with `app open`, `app init`, `seed refresh`; the agent ops routes behind it; the seeded-file managed/once split with content hashes; a PostToolUse validator hook; skill + AGENTS.md updates.

**Out:** `holi.data` and writes (still §State, deferred), the `utilityProcess` backend, personal apps in `userData`, the command-palette entry, auto-reload, and vault git hooks (`2026-08-20-vault-hooks.md`, which depends on this plan's `seed refresh`).

## File map

- `packages/shared/src/app-manifest.ts` *(new)* — `APP_MANIFEST_FILE`, `parseAppManifest`, `AppManifest`. Pure; the renderer and main both parse it.
- `packages/shared/src/path-safety.ts` — `isAgentSurfacePath` unchanged here; D76 adds to it, not this plan.
- `apps/desktop/src/main/agent/ops.ts` *(new)* — the agent-facing routes (`app/open`, `seed/refresh`) mounted on the existing hook server.
- `apps/desktop/src/main/agent/hook-server.ts` — route the request instead of treating every POST as a turn signal.
- `apps/desktop/src/main/agent/cli.ts` *(new)* — generates the `holi` script. Mirrors `google/cli.ts`; read that first.
- `apps/desktop/src/main/agent/seed-content.ts` — split `SEED_FILES` into `MANAGED_FILES` + `ONCE_FILES`; `ensureSeeded` refreshes the first class by hash.
- `apps/desktop/src/main/agent/seed-state.ts` *(new)* — read/write `.holi/seed-state.local.json`.
- `apps/desktop/src/main/apps/migrate-manifests.ts` *(new)* — one-time `app.yaml` for a slice-1 app directory.
- `apps/desktop/src/main/agent/hooks/vault-app-check.mjs` *(new)* — the PostToolUse validator.
- `apps/desktop/src/main/agent/skills/vault-apps/SKILL.md` — the manifest, `holi app open`, and what the validator will say.
- `apps/desktop/src/renderer/src/state/apps.ts` — `appIdsAtom` keys on the manifest.
- Tests: `packages/shared/test/app-manifest.test.ts` *(new)*, `apps/desktop/test/{agent-ops,agent-cli,seed-state,seed-content,migrate-manifests,vault-app-check}.test.ts`, `apps/desktop/src/renderer/src/features/apps/__tests__/AppsSection.test.tsx` (extend).

## Contracts

```ts
// packages/shared/src/app-manifest.ts

/** The registration marker. Written LAST, so the app exists when it is finished
 *  rather than when its first file lands. YAML rather than JSON on purpose: the
 *  vault's task frontmatter is already YAML, it takes comments, and it does not
 *  fail on a trailing comma — which matters for a file whose only job is being
 *  written correctly, unattended, by a model. */
export const APP_MANIFEST_FILE = 'app.yaml'

export interface AppManifest {
  /** Display label. Defaults to the directory name; NEVER a second id — the
   *  directory name is still the identity (D74). */
  name?: string
  /** A lucide icon name. Unknown/absent falls back to the default app glyph. */
  icon?: string
  /** Free text shown in the sidebar tooltip. */
  description?: string
}

/** Never throws: a broken manifest degrades to `{}`, so a YAML typo costs the
 *  label, not the app. `null` ONLY when the text is not a mapping at all. */
export function parseAppManifest(yaml: string): AppManifest | null
```

```ts
// apps/desktop/src/main/agent/ops.ts — what the CLI talks to.
// Mounted on the hook server, which already owns the port + per-instance token.
// NOTE the existing rule: a hook route must answer with an EMPTY body (a body is
// injected into Claude's context). An ops route is a CLI reply and may answer.
'app/open'     (appId)          -> { ok: true } | { ok: false, error }
'seed/refresh' (path?, force?)  -> { refreshed: string[], skipped: { path, reason }[] }
```

```ts
// apps/desktop/src/main/agent/seed-content.ts — the D75 split.

/** Holi owns these after writing them: refreshed on open when untouched. */
export const MANAGED_FILES: Record<string, string>   // .claude/skills/**, .claude/hooks/**
/** The user's the moment they exist. Create-if-missing, as today. */
export const ONCE_FILES: Record<string, string>      // AGENTS.md, MEMORY.md, theme.json, templates
export const SEED_FILES: Record<string, string>      // = { ...ONCE_FILES, ...MANAGED_FILES }, kept
                                                     //   so existing callers/tests still resolve
```

```ts
// apps/desktop/src/main/agent/seed-state.ts

/** `.holi/seed-state.local.json` — sha256 of what Holi last wrote, per path.
 *  Machine-local (`.local.` ⇒ gitignored): it is a fact about THIS clone, and a
 *  committed copy would claim another machine's file was untouched. */
export async function readSeedState(root: string): Promise<Record<string, string>>
export async function recordSeeded(root: string, rel: string, content: string): Promise<void>
/** Overwrite iff on-disk hash === recorded hash. Absent record ⇒ never overwrite
 *  (the file predates the hashes; assume the user's). */
export async function mayRefresh(root: string, rel: string, onDisk: string): Promise<boolean>
```

---

## Task 1: the manifest type

**Files:** Create `packages/shared/src/app-manifest.ts`; test `packages/shared/test/app-manifest.test.ts`; modify `packages/shared/src/index.ts`.

- [ ] **Write failing tests:** `parseAppManifest('name: Retro\nicon: kanban\n')` → `{name:'Retro', icon:'kanban'}`; an empty string → `{}` (a manifest can be empty and still register — that is its whole job); unknown keys are dropped rather than erroring; a non-mapping (`- a\n- b`, `42`) → `null`; malformed YAML → `{}` **not** `null` (a typo must cost the label, never the app); a `name` that is not a string is dropped. Assert `APP_MANIFEST_FILE === 'app.yaml'`.
- [ ] Run `pnpm --filter @holi/shared exec vitest run app-manifest` → FAIL.
- [ ] **Implement.** There is no YAML dependency in `@holi/shared` — check `packages/shared/package.json` before adding one. `parseTaskFile` already parses frontmatter; **reuse that parser** rather than adding a second YAML implementation, and say so in a comment. Re-export from `index.ts`.
- [ ] Run → PASS. Commit: `feat(shared): the vault-app manifest`.

## Task 2: registration keys on the manifest

**Files:** Modify `apps/desktop/src/renderer/src/state/apps.ts`; test `apps/desktop/src/renderer/src/features/apps/__tests__/AppsSection.test.tsx`.

- [ ] **Write failing tests:** a directory with `app.yaml` **and** `index.html` registers; `app.yaml` alone does **not** (the entry document is still required — the manifest says "finished", not "exists"); `index.html` alone does not register **but is not silently forgotten** — assert it appears in a new `unregisteredAppIdsAtom`, so the sidebar can say "unfinished" rather than nothing. (Task 3's migration and Task 8's validator apply the same *rule* from main and from a hook process respectively — neither can read an atom, so the rule is "manifest + entry document", stated once here and re-implemented deliberately in three places rather than shared through a layer none of them have in common.); a nested `sub/app.yaml` does not register a second app.
- [ ] Run `pnpm exec vitest run --project dom AppsSection` → FAIL.
- [ ] **Implement** in `state/apps.ts`. Keep `appIdFromPath` as the id source; require both files at the app's own root.
- [ ] Run → PASS. Commit: `feat(apps): an app registers when its manifest lands, not its first file`.

## Task 3: migrate slice-1 apps

**Files:** Create `apps/desktop/src/main/apps/migrate-manifests.ts`; test `apps/desktop/test/migrate-manifests.test.ts`; call it from `vaults.open` in `router.ts` beside `ensureSeeded`.

- [ ] **Write failing tests:** a directory with `index.html` and no `app.yaml` gets one containing the directory name as `name`; a directory that already has one is untouched (byte-identical, and not listed as migrated); a directory whose id is invalid (`My_App`) is **skipped, not fixed** — renaming someone's directory is not a migration; running twice migrates nothing the second time.
- [ ] Run `pnpm exec vitest run --project node migrate-manifests` → FAIL.
- [ ] **Implement.** Returns the list it wrote, for the caller to log. **This must run before the first snapshot the renderer sees**, or a slice-1 app blinks out of the sidebar and back — put it beside `ensureSeeded` in `vaults.open`, ahead of `host.open`.
- [ ] Run → PASS. Commit: `feat(apps): write a manifest for apps that predate one`.

## Task 4: seed state, and the managed/once split

**Files:** Create `apps/desktop/src/main/agent/seed-state.ts`; modify `seed-content.ts`; tests `apps/desktop/test/seed-state.test.ts` + `seed-content.test.ts`.

- [ ] **Write failing tests** for `seed-state.ts`: `recordSeeded` then `mayRefresh` with the same content → true; with edited content → false; with **no record at all** → false (a file predating the hashes is assumed to be the user's — this is the case every existing vault is in, so getting it wrong rewrites everyone's files once); the state file is at `.holi/seed-state.local.json` and `isLocalOnlyPath` says true for it.
- [ ] **Write failing tests** for `ensureSeeded`: a managed file (`.claude/skills/vault-apps/SKILL.md`) whose recorded hash matches is **rewritten** when the shipped content changes; the same file **edited by the user** is left alone and named in the return value as skipped; a once-file (`AGENTS.md`) is never rewritten even when it matches its hash; `MANAGED_FILES` and `ONCE_FILES` are disjoint and their union is `SEED_FILES` (an exhaustive assertion — a new seed file must be classified deliberately).
- [ ] Run `pnpm exec vitest run --project node seed` → FAIL.
- [ ] **Implement.** `ensureSeeded`'s return type grows: it currently returns `string[]` of what it wrote and several tests assert against that — extend rather than replace, and update the call sites the compiler names.
- [ ] Run → PASS. Commit: `feat(agent): refresh a managed file Holi wrote and nobody edited` (D75).

## Task 5: agent ops routes

**Files:** Create `apps/desktop/src/main/agent/ops.ts`; modify `hook-server.ts`; test `apps/desktop/test/agent-ops.test.ts`.

- [ ] **Write failing tests:** a POST to `/app/open?t=<token>` with a valid id calls the injected `openApp` dep and answers `{ok:true}`; a bad token is refused **before** the body is read; an unknown app id answers `{ok:false}` with a reason rather than 500; an unknown route 404s; **the existing turn-signal routes still answer with an empty body** (assert `''`, because a body would be injected into Claude's context — this is the regression the refactor risks).
- [ ] Run `pnpm exec vitest run --project node agent-ops` → FAIL.
- [ ] **Implement.** Keep `hook-server.ts`'s no-`electron`-import rule (it loads under vitest). `openApp` arrives as a dep — main pushes to the renderer, which owns `workspaceAtom`; follow how `onSnapshot` already pushes.
- [ ] Run → PASS. Commit: `feat(agent): route the hook server, and add the agent ops endpoints`.

## Task 6: the `holi` CLI

**Files:** Create `apps/desktop/src/main/agent/cli.ts`; test `apps/desktop/test/agent-cli.test.ts`; install it beside `installGoogleCli` in `index.ts`.

- [ ] **Write failing tests:** the generated script is executable (mode `0o755`); it exits non-zero with a human sentence when `$HOLI_HOOK_PORT`/`$HOLI_HOOK_TOKEN` are unset (Holi not running); it re-reads both from the environment at each invocation rather than baking them in (assert the literal `$HOLI_HOOK_PORT` appears in the body — the port moves across restarts); `holi` with no subcommand prints usage listing exactly `app open`, `app init`, `seed refresh`.
- [ ] Run `pnpm exec vitest run --project node agent-cli` → FAIL.
- [ ] **Implement** by reading `google/cli.ts` first and following it: a generated `sh` script, a thin curl wrapper, comments addressed to the human whose machine it is on. `holi-google` sorts its subcommands by reversibility (D70) — do the same here, and note that all three of these are reversible, which is why none is gated.
- [ ] Run → PASS. Commit: `feat(agent): a holi CLI the agent can type`.

## Task 7: `app open`, `app init`, `seed refresh`

**Files:** Modify `ops.ts`, `cli.ts`; extend `agent-ops.test.ts`.

- [ ] **Write failing tests:** `app open` on an unregistered directory answers with the reason (`no app.yaml`) rather than opening a broken tab; `app init <id>` refuses an id that is not `[a-z0-9-]+`, naming the rule; `app init` on an existing app does not clobber its manifest; `seed refresh` with no path refreshes every managed file that may be refreshed and reports each skip with its reason; `seed refresh <path> --force` overwrites an edited file; `--force` on a once-file is still refused (`AGENTS.md` is the user's, and no flag changes that).
- [ ] Run → FAIL, implement, run → PASS.
- [ ] Commit: `feat(agent): open an app, scaffold one, and refresh managed files`.

## Task 8: the validator hook

**Files:** Create `apps/desktop/src/main/agent/hooks/vault-app-check.mjs`; add to `MANAGED_FILES` and to the seeded `PostToolUse` settings; test `apps/desktop/test/vault-app-check.test.ts`.

- [ ] **Write failing tests** driving the hook as a process (`google-send-gate.test.ts` shows the shape — read it first) over a `Write` tool payload: a `.js` with a syntax error is reported with the line; a **valid** `.js` is silent (a hook that talks on every write gets ignored); a `.tsx`/`.ts`/`.jsx` under `.holi/apps/**` is reported as unbuildable — **there is no bundler, so it can never load**, which today shows up as a blank tab and nothing else; a directory with `index.html` and no `app.yaml` is reported as not registered, naming `holi app init`; `localStorage`, `holi.data`, `holi.docs.write` and a hand-added bridge `<script>` are each reported with the skill's reason; a hard-coded hex colour is reported as a nudge, at a lower severity than the rest; a write **outside** `.holi/apps/**` is ignored entirely.
- [ ] Run `pnpm exec vitest run --project node vault-app-check` → FAIL.
- [ ] **Implement.** Node's own parser for the syntax check (`new Function` or `node --check`) — no new dependency. **Advisory, never blocking:** it reports and exits 0. The agent-surface gate (`google-send-gate`) is the only hook here that says no, and it says no about sending mail to a person; a lint opinion does not get the same power.
- [ ] Run → PASS. Commit: `feat(agent): tell the agent immediately when an app it wrote cannot work`.

## Task 9: teach the skill the new loop

**Files:** Modify `apps/desktop/src/main/agent/skills/vault-apps/SKILL.md` and the `AGENTS.md` Apps section in `seed-content.ts`; extend `seed-content.test.ts`.

- [ ] **Write failing tests** asserting the skill names `app.yaml` as required-and-written-last, `holi app open <id>`, and that a check will be reported back on write. Assert (whitespace-normalized, since the file is hand-wrapped at 80 columns) that the **"you cannot open the app yourself" paragraph is gone** — it is false as of Task 7, and a skill that is wrong in the direction of learned helplessness is worse than one that is merely incomplete.
- [ ] Run → FAIL. **Implement**: rewrite §"You cannot see the app run" as the loop that now exists (write → validator answers → `holi app open` → ask the user what they see), and add the manifest to §"Where it goes" as the last file to write.
- [ ] Run → PASS. Commit: `docs(apps): the authoring loop, now that the agent can close it`.

## Task 10: gates and hand verification

- [ ] Full gates: `pnpm exec vitest run --project node`, `--project dom`, `pnpm --filter @holi/shared exec vitest run`, `pnpm typecheck`, and from `apps/desktop` `pnpm exec eslint src` — **0 errors, exactly 2 known warnings** (`EditorPane.tsx:240`, `TaskDetail.tsx:348`).
- [ ] **In the running app** (relaunch — this is nearly all main-side): a slice-1 app still appears after migration; `holi app open vault-dashboard` from a terminal opens the tab; a directory with no manifest does not appear until `holi app init` writes one; editing a managed skill by hand and reopening the vault leaves the edit in place and reports the skip.
- [ ] **Ask the agent in the drawer to build an app** — the check slice 1 could not run. Confirm it finds the skill, writes a manifest, opens the app itself, and that the validator catches a deliberate syntax error you introduce.
- [ ] Commit `docs/verification/<date>-vault-apps-slice2.md` recording what was checked and what was not.

---

## Gotchas

- **`pnpm exec` always**; bare `node`/`npx` are broken here. The shell's cwd drifts between calls — absolute paths.
- **Never run `pnpm run format` / `prettier --write`** — it corrupts this repo. `printWidth` 100, wrap by hand.
- **Main-process edits do not restart the dev app.** Tasks 3–8 are main-side; relaunch or you are testing the old handler.
- **Pure-logic tests for `main/` live in `apps/desktop/test/`**, not co-located. Grep both.
- **`hook-server.ts` must not import `electron`** — it loads under vitest, and adding one breaks the suite in a way that looks unrelated.
- **A hook route answers with an empty body**; an ops route may answer. Mixing these injects CLI output into Claude's context.
- **`mayRefresh` with no recorded hash must return false.** Every vault that exists today is in that state, so a `true` here rewrites every user's edited skills once, silently.
- **The migration must precede the first snapshot**, or slice-1 apps blink out of the sidebar and back on every open.
- **`ensureSeeded`'s return value is asserted by several existing tests.** Extend it; do not repurpose it.
