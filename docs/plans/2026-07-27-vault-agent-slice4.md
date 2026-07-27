# Vault agent — Slice 4 (PDF capability) Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The agent can turn a note into a PDF with the **same Typst engine** the UI's "Convert to PDF" uses — by (1) putting the resolved typst binary path in the agent's `$TYPST_BIN` env at spawn, and (2) seeding a `md-to-pdf` skill that documents the template model + render recipe. No new machinery.

**Architecture:** Everything needed already exists in `apps/desktop/src/main/pdf/`: `resolveTypstBin()` (find-only: `TYPST_BIN` env → cached download → `PATH`), `ensureTypst()` (find-or-download), and the `doc(notePath, meta, assets)` wrapper contract (`wrapper.ts`) the UI compiles with `typst compile wrapper.typ out.pdf --root /`. Slice 4 only wires the resolver into the agent env (mirroring the Slice-2 hook-port injection) and seeds a skill file. The agent writes the wrapper + typed `meta` literals itself.

**Tech Stack:** the existing `pdf/typst-bin.ts` resolver, the agent manager + `buildAgentEnv`, `index.ts` wiring, Claude Code skills (`.claude/skills/<name>/SKILL.md`), Vitest 4.

**PRD:** `docs/prd/agent.md` §"Rendering PDFs", build order slice 4. Design spec for the template model: `docs/specs/2026-07-26-typed-template-fields-design.md`.

---

## Design decisions (settled, do not re-litigate)

- **Reuse the existing resolver; add no PDF machinery.** `resolveTypstBin({cacheDir})` is already find-only (no download) — perfect for the spawn path. `ensureTypst({cacheDir})` is the download-on-first-use warmer. Both already exist and are tested.
- **The agent env var is `TYPST_BIN`.** It is the *same* override `resolveTypstBin` reads, so the value round-trips cleanly, and the skill's `"$TYPST_BIN" compile …` recipe uses it directly.
- **Resolve find-only at spawn; warm fire-and-forget at spawn.** The manager awaits `resolveTypstBin()` (a fast `which`, never a download) to set `env.TYPST_BIN`, and fires `ensureTypst()` **unawaited** so a machine that has never rendered caches typst for next time — the download never blocks (or happens on) the spawn path. Wired exactly like the Slice-2 hook port (a `deps` provider, injected from `index.ts`).
- **Only warm when the agent is actually used.** The warm fires from the manager's `start`, not app startup, so a user who never opens the agent never triggers a 30 MB typst download.
- **PDFs are outputs, never committed.** The skill writes the PDF to a scratch dir outside the vault tree (`mktemp -d`) and reports the absolute path — so no `.gitignore` change is needed and sync never sees it.
- **The agent writes typed `meta` literals directly** (PRD). The skill documents the six field types → Typst value mapping; the agent does not need Holi's `coerceMeta`.
- **Fallback when typst is absent.** If `$TYPST_BIN` is empty, the skill tells the user to run one UI **Convert to PDF** (which installs typst) and retry.

## Known limitations (state them, don't hide them)

- **`resolveTypstBin` awaits a `which` per spawn.** Fast and not a download, so it satisfies "never downloads on the spawn path"; the download half (`ensureTypst`) is never awaited.
- **The skill reaches new vaults only.** `SEED_FILES` is create-if-missing, so existing clones need a re-seed to get the skill (same caveat as `AGENTS.md`/`settings.json`). The env var works on every vault regardless. (Update the test vaults after, as in slice 2.)
- **Windows typst download is unverified** (pre-existing `typst-bin.ts` caveat) — out of scope here.

---

## Conventions (read once)

- **Tooling:** bare `node`/`npx` broken — always `pnpm exec`. **Absolute `cd` every Bash call** — cwd drifts (it bit `tsc`/`electron-vite build`, which resolve only from `apps/desktop`). Never chain `cd packages/shared && … build`.
- **Typecheck gate:** from `apps/desktop`, `pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"`. Baseline **6** (pre-existing `state/history.ts`). Must not rise. If it prints `0`, tsc ran from the wrong dir — re-run with the explicit `cd`.
- **Test baselines:** desktop **635**, shared **179**. Confirm at start. Expected desktop after this slice ≈ **639** (buildAgentEnv typst + manager typst env + manager warm + seed skill).
- **Build:** `cd apps/desktop && pnpm exec electron-vite build`.
- **Live app:** dev on CDP 9333; main edits need a relaunch — ask Nicolai. Scoped teardown only: `pkill -f "better-holi-final/node_modules/.pnpm/electron@"`.
- **Commit trailer:** end every commit message with `Claude goes brr.. via Dash`.

## File Structure

- **Modify** `apps/desktop/src/main/agent/agent-runtime.ts` — `AgentEnvOpts.typstBin`; `buildAgentEnv` sets `TYPST_BIN`.
- **Modify** `apps/desktop/test/agent-runtime.test.ts` — the `typstBin` env case.
- **Modify** `apps/desktop/src/main/agent/agent-manager.ts` — `resolveTypstBin?`/`warmTypst?` deps; resolve → env at spawn; fire the warm.
- **Modify** `apps/desktop/test/agent-manager.test.ts` — spawn env carries `TYPST_BIN`; the warm fires.
- **Modify** `apps/desktop/src/main/index.ts` — wire the two providers from `pdf/typst-bin`.
- **Modify** `apps/desktop/src/main/agent/seed-content.ts` — seed `.claude/skills/md-to-pdf/SKILL.md`.
- **Modify** `apps/desktop/test/seed-content.test.ts` — assert the skill + its recipe.

### Shared contracts (define once)

```ts
// agent-runtime.ts — AgentEnvOpts addition
typstBin?: string | null   // → env.TYPST_BIN when set (the UI's Typst engine, for the md-to-pdf skill)

// agent-manager.ts — AgentManagerDeps additions
/** Find-only typst path for the child's $TYPST_BIN (no download). */
resolveTypstBin?: () => Promise<string | null>
/** Fire-and-forget: cache typst for next time if the machine has never rendered. */
warmTypst?: () => void
```

At spawn (manager `start`, before building env): `const typstBin = (await deps.resolveTypstBin?.()) ?? null`, pass it to `buildAgentEnv(process.env, { hookPort, hookToken, typstBin })`, and `deps.warmTypst?.()` (unawaited).

---

## Task 1: Put the resolved typst path in the agent's `$TYPST_BIN`

**Files:** Modify `agent-runtime.ts`, `agent-manager.ts`, `index.ts`, their tests.

- [ ] **Step 1: Failing tests.**
  - `agent-runtime.test.ts` (near the hook-env cases): `buildAgentEnv({PATH:'/usr/bin'}, { typstBin: '/opt/typst' }).TYPST_BIN === '/opt/typst'`; absent/null → `TYPST_BIN` undefined.
  - `agent-manager.test.ts`: in `rig()`, add deps `resolveTypstBin: () => Promise.resolve('/fake/typst')` and `warmTypst: () => { warmed += 1 }` (+ expose `warmed()` on the rig). New tests: after `start()`, the recorded spawn `opts.env.TYPST_BIN === '/fake/typst'` **and** `warmed() === 1`.
- [ ] **Step 2: Run, verify fail** — `cd apps/desktop && pnpm exec vitest run test/agent-runtime.test.ts test/agent-manager.test.ts`.
- [ ] **Step 3: Implement.**
  - `agent-runtime.ts`: add `typstBin?: string | null` to `AgentEnvOpts`; in `buildAgentEnv`, after the hook keys: `if (opts.typstBin) env.TYPST_BIN = opts.typstBin`.
  - `agent-manager.ts`: add `resolveTypstBin?`/`warmTypst?` to `AgentManagerDeps`. In `start`, before the `runtime.start({…})` call: `const typstBin = (await deps.resolveTypstBin?.()) ?? null`. Extend the env call to `buildAgentEnv(process.env, { hookPort: …, hookToken: …, typstBin })`. After `runtime.start(...)` succeeds (or just before it — either side of spawn is fine), call `deps.warmTypst?.()` **unawaited**.
  - `index.ts`: import `{ resolveTypstBin, ensureTypst }` from `./pdf/typst-bin`; compute `typstCacheDir` (same `join(app.getPath('userData'), 'typst')` already passed to the router — reuse the value). Add to the `createAgentManager({…})` call: `resolveTypstBin: () => resolveTypstBin({ cacheDir: typstCacheDir })`, `warmTypst: () => { void ensureTypst({ cacheDir: typstCacheDir }) }`.
- [ ] **Step 4: Run, verify pass** (manager + runtime).
- [ ] **Step 5: Typecheck** → 6.
- [ ] **Step 6: Commit** — `feat(agent): expose the Typst engine to the agent as $TYPST_BIN`.

---

## Task 2: Seed the `md-to-pdf` skill

**Files:** Modify `seed-content.ts`, `test/seed-content.test.ts`.

- [ ] **Step 1: Add the skill to `SEED_FILES`.** In `seed-content.ts`, add a `MD_TO_PDF_SKILL` constant and a `SEED_FILES` entry `'.claude/skills/md-to-pdf/SKILL.md': MD_TO_PDF_SKILL`. Exact content:

````markdown
---
name: md-to-pdf
description: Render a vault note to a PDF using Holi's bundled Typst engine and the vault's templates. Use when asked to export, print, or make a PDF of a note.
---

# Render a note to PDF

Holi ships a Typst engine; its absolute path is in the `$TYPST_BIN` environment
variable. If `$TYPST_BIN` is empty, Typst is not installed yet — tell the user to
run **Convert to PDF** once from a note's ⋯ menu (that installs it), then retry.

## Templates

A template is a folder under `.holi/templates/<slug>/`:

- `template.typ` — exports `doc(notePath, meta, assets)`.
- `template.json` — a manifest declaring the fields the template accepts.

List them with `ls .holi/templates/`. Every vault ships the `plain` template.

Each `template.json` field has a `key`, `label`, `type`, and optional `required`,
`default`, and `options`. The six field types and the Typst value each becomes:

| type       | Typst value example                        |
|------------|--------------------------------------------|
| `text`     | `"Acme Inc"`                               |
| `textarea` | `"Line one\nLine two"`                     |
| `select`   | `"one of the manifest's options"`          |
| `number`   | `42`                                       |
| `date`     | `datetime(year: 2026, month: 7, day: 27)`  |
| `checkbox` | `true` / `false`                           |

Omit an optional field to leave it unset — the template reads
`meta.at(key, default: none)`.

## Recipe

1. Choose a template (default `plain`) and read its `template.json` for the fields.
2. Write a wrapper `.typ` in a scratch dir **outside the vault** (PDFs are outputs,
   never committed). Use ABSOLUTE paths so `--root /` can read everything:

   ```typ
   #import "/ABS/VAULT/.holi/templates/plain/template.typ": doc
   #doc(
     "/ABS/VAULT/notes/the-note.md",
     meta: (recipient: "Acme Inc"),
     assets: "/ABS/VAULT/.holi/templates/plain/assets",
   )
   ```

3. Compile with the bundled engine:

   ```sh
   DIR=$(mktemp -d)
   # …write "$DIR/wrapper.typ" per above…
   "$TYPST_BIN" compile "$DIR/wrapper.typ" "$DIR/the-note.pdf" --root /
   ```

4. Report the absolute path of the resulting PDF to the user. Do not move it into
   the vault.
````

- [ ] **Step 2: Seed test.** In `test/seed-content.test.ts` (near the AGENTS/settings tests):

```ts
  it('seeds the md-to-pdf skill with the Typst render recipe', () => {
    const skill = SEED_FILES['.claude/skills/md-to-pdf/SKILL.md']!
    expect(skill).toContain('name: md-to-pdf')
    expect(skill).toContain('$TYPST_BIN')
    expect(skill).toContain('doc(') // the template contract
    expect(skill).toContain('--root /') // the compile recipe
  })
```

Also update the pinned `SEED_FILES` key-list assertion if one exists (grep the test for the key array and add `.claude/skills/md-to-pdf/SKILL.md`).

- [ ] **Step 3: Run the seed suite** — `cd apps/desktop && pnpm exec vitest run test/seed-content.test.ts`.
- [ ] **Step 4: Typecheck** → 6.
- [ ] **Step 5: Commit** — `feat(agent): seed the md-to-pdf skill (Typst render recipe)`.

---

## Task 3: Full gates + live verification

**Files:** none.

- [ ] **Step 1: Typecheck** → 6.
- [ ] **Step 2: Desktop suite** — `cd apps/desktop && pnpm exec vitest run 2>&1 | tail -6` (~639; confirm, no unexpected failures).
- [ ] **Step 3: Shared suite** — `cd packages/shared && pnpm exec vitest run 2>&1 | tail -3` → 179.
- [ ] **Step 4: Build** — `cd apps/desktop && pnpm exec electron-vite build 2>&1 | tail -3` → clean.
- [ ] **Step 5: Live (ask Nicolai to relaunch — main changed; CDP 9333).** On a vault whose `.claude/skills/` has the skill (a fresh vault, or re-seed an existing one — offer to update the test vaults as in slice 2):
  1. **`$TYPST_BIN` is set** — in the drawer, ask the agent to run `echo "$TYPST_BIN"`; it prints an absolute path (or empty, if typst was never installed — then run one UI Convert to PDF and retry).
  2. **Render** — ask "make a PDF of `<some note>`". The agent discovers the skill, reads a template, writes a wrapper, compiles, and reports an absolute `.pdf` path. Open it — it matches the UI's Convert output for the same template.
  3. **Not committed** — confirm the PDF is outside the vault tree and the vault's sync stays `up-to-date` (nothing new to commit).
  - Report what happened, especially #2 (does the agent find + use the skill unaided?).

---

## Final verification

- [ ] Typecheck **6**; desktop suite green (confirm count); shared **179**; build clean.
- [ ] Live: `$TYPST_BIN` is set in the agent env; the agent renders a note to a PDF via the seeded skill using the same Typst engine; the PDF is not committed.

## Self-review (spec coverage)

- **Same Typst engine as the UI, one env var + one skill, no new machinery** (PRD) → Task 1 reuses `resolveTypstBin`/`ensureTypst`; Task 2 seeds the skill; nothing else added.
- **`$TYPST_BIN`: find-only at spawn, non-blocking, never downloads on the spawn path; fire-and-forget warm** (PRD) → Task 1: awaited find-only resolve for the env, unawaited `ensureTypst` warm.
- **Seeded `md-to-pdf` skill documents the template model, six-type schema, `doc(notePath, meta, assets)`, and the compile recipe; agent writes typed `meta` literals** (PRD) → Task 2's SKILL.md.
- **PDFs are outputs, never committed** (PRD) → the skill writes to `mktemp -d` and reports the path; no gitignore change, sync never sees it.
- **Fallback when typst is unset** (PRD) → the skill's opening note.
- **This is the final agent slice.** Deferred/out of scope: the standalone `parseFields` manifest validation (agent-independent side work, its own plan); Windows typst download verification (pre-existing caveat).
