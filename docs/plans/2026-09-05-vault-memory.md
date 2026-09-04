# Vault Memory (D89) Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The vault's memory is a `memory/` directory of typed markdown files whose index Holi regenerates on commit, the agent is handed an overview of it at session start, and Claude Code's own auto-memory is switched off so there is exactly one memory surface.

**Architecture:** A pure indexer in `packages/shared` turns the memory files into `memory/index.md`, grouped by `type`. A fourth pre-commit transform (`memory-index`) runs it and restages the result, so the index lands in the same commit as the memory it describes. A `SessionStart` hook reads that index (plus a scan of `*.local.md` and `git log -- memory/`) and prints an overview under 3k characters. Nothing enforces anything: FR-9 holds, and a missing key is filled in rather than refused.

**Tech Stack:** TypeScript, `yaml` + `splitFrontmatter` (both already in `@holi/shared`), Electron main, a plain `.mjs` Claude Code hook, Vitest (`shared` for the indexer, desktop `node` for the transform and seed).

**Spec:** [`../specs/2026-09-05-vault-memory-design.md`](../specs/2026-09-05-vault-memory-design.md)
**Issue:** [`syv-ai/holi#3`](https://github.com/syv-ai/holi/issues/3), items 1 to 3 only.

---

## What the spec settled, restated as constraints

- **OKF's shape, never its label.** Memory files link with `[[wiki-links]]`, so the bundle is not OKF-conformant and Holi never says it is. One link grammar in the vault.
- **The indexer maintains, it never enforces.** Missing `title` → H1 → filename. Missing `description` → first sentence. Missing `type` → `note`. Nothing here can fail a commit (FR-9); the large-file guard is the vault's only veto.
- **No `log.md`.** `git log -- memory/` is the record. A newest-first log file conflicts on its first lines every time two members write memory the same afternoon, in a file no human wrote.
- **No `index.local.md`.** A generated file that must never be committed, whose only reader is a hook that can read the source files just as cheaply.
- **`memory/` at the vault root**, personal via `memory/x.local.md` (D65; the seeded `*.local.*` ignore already covers it).
- **Nothing moves `MEMORY.md` or `USER.local.md`.** Both keep working; the split is agent work the user asks for.

## Decisions this plan locks (not in the spec)

- **The indexer is `packages/shared/src/memory-index.ts`, and it is pure.** It takes `{ path, text }[]` and returns the index markdown plus per-file metadata. It does no IO, so it tests in the `shared` project with no fixtures on disk, and the transform is the only thing that reads files.
- **The transform early-returns on `staged`, but indexes from the tree.** `StagedChanges` decides *whether* to run (does anything under `memory/` and not `.local.` appear in `added`/`modified`/`renamed`?); `listFiles` decides *what* goes in the index. Indexing from the diff would drop every file an unrelated commit did not touch.
- **`memory/index.md` is excluded from its own index**, by path, before parsing. It has no frontmatter and would otherwise index itself as `type: note`.
- **The overview hook is `.mjs` with no imports beyond `node:` builtins**, like the two hooks beside it. It shells `git log` through `execFileSync` with a 2-second cap and treats any failure as "no recent changes", never as an error.
- **The `SessionStart` hook entry is merged into existing vaults by `settingsWithRequired`**, matched by the script name (`memory-overview`) the way the send gate is matched, so a user who reordered the block does not get a duplicate.
- **`autoMemoryEnabled` is merged only when absent**, the `disableClaudeAiConnectors` shape. A user who set it `true` has said something.

## File structure

| File | Responsibility |
|---|---|
| `packages/shared/src/memory-index.ts` (create) | Pure: memory files → index markdown + metadata. `MEMORY_DIR`, `isMemoryPath`. |
| `packages/shared/src/index.ts` (modify) | Export it. |
| `packages/shared/src/path-safety.ts` (modify) | `isAgentSurfacePath` covers `memory/`. |
| `packages/shared/src/vault-settings.ts` (modify) | `memory-index: true` in `VAULT_SETTING_DEFAULTS.hooks`. |
| `apps/desktop/src/main/vault/hooks/memory-index.ts` (create) | The transform: gate on `staged`, read the tree, write `memory/index.md`. |
| `apps/desktop/src/main/vault/hooks/runner.ts` (modify) | `TransformName` gains `'memory-index'`. |
| `apps/desktop/src/main/vault/hooks/transforms.ts` (modify) | Register it **last** in `VAULT_TRANSFORMS`. |
| `apps/desktop/src/main/agent/hooks/memory-overview.mjs` (create) | The `SessionStart` overview. |
| `apps/desktop/src/main/agent/seed-content.ts` (modify) | `AGENTS_MD` memory section; `memory/index.md` as a `ONCE_FILE`; `MEMORY.md` out of the seed; `autoMemoryEnabled` + the `SessionStart` entry in `SETTINGS_JSON` and in `settingsWithRequired`. |

Test commands:

```bash
pnpm -C packages/shared exec vitest run test/memory-index.test.ts
pnpm -C apps/desktop exec vitest run --project node test/<file>.test.ts
pnpm -C packages/shared test && pnpm -C apps/desktop test   # both, before done
pnpm typecheck && pnpm lint
```

Bare `node` / `npx` do not work in this shell. Always `pnpm exec`, always from the repo root. Vitest suppresses `console.log`; write to a file if you need to see something. Quote grep flags (`"--include=*.ts"`) under zsh.

---

### Task 1: the indexer

**Files:**
- Create: `packages/shared/src/memory-index.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/memory-index.test.ts` (create)

**Contract:**

```ts
export const MEMORY_DIR = 'memory'
export const MEMORY_INDEX = 'memory/index.md'

/** A memory file's path is under `memory/` and ends `.md`; the index itself is not one. */
export function isMemoryPath(path: string): boolean
/** …and is not `*.local.*` (D65). Shared vs personal is the index's whole safety rule. */
export function isSharedMemoryPath(path: string): boolean

export interface MemoryEntry {
  path: string
  type: string          // frontmatter `type`, else 'note'
  title: string         // frontmatter `title`, else the H1, else the filename without `.md`
  description: string   // frontmatter `description`, else the body's first sentence, else ''
}

export function readMemoryEntry(path: string, text: string): MemoryEntry
/** Entries → the whole of `memory/index.md`. Sections are types, sorted; entries
 *  within a section sorted by path, one line each. */
export function renderMemoryIndex(entries: MemoryEntry[]): string
```

**Index format** (both halves matter — the header is what stops someone hand-editing it, the one-line-per-file sort is what makes concurrent additions merge):

```markdown
<!-- Generated by Holi. Edit the memory files, not this. -->

## convention

- [[memory/plan-style.md|Plan style]] — plans carry contracts and gotchas, never inline code
```

With no entries, the body is a single line saying the vault has no memories yet. That empty form is also what the seed writes.

**Gotchas:**
- `splitFrontmatter` is exported from `task-file.ts`, already in this package. Do not add `gray-matter`.
- Frontmatter that fails to parse is **not** an error: fall through to the body-derived fallbacks, exactly as if it were absent. A half-written memory file must not take the index down, and by FR-9 it could not stop the commit anyway.
- The description fallback is the first sentence of the body *after* stripping a leading H1, and it is truncated (~120 chars) at a word boundary. An index line that wraps three times is an index nobody reads.
- Escape `]]` and `|` if they appear in a title, or the wiki-link parser sees a different link than the one written.

**Tests:** every fallback in isolation (no type / no title / no description / no frontmatter at all); a file whose frontmatter is malformed YAML; grouping and sort order with three types; the empty case; a title containing `|`.

---

### Task 2: the `memory-index` transform

**Files:**
- Create: `apps/desktop/src/main/vault/hooks/memory-index.ts`
- Modify: `apps/desktop/src/main/vault/hooks/runner.ts` (`TransformName`), `transforms.ts` (`VAULT_TRANSFORMS`), `packages/shared/src/vault-settings.ts` (`VAULT_SETTING_DEFAULTS.hooks`)
- Test: `apps/desktop/test/hooks-memory-index.test.ts` (create)

**Contract:** `memoryIndex(root, staged): Promise<TransformResult>` — the same shape as `relink`.

1. Return `{ changed: [], notes: [] }` immediately unless `staged.added`, `staged.modified` or either side of `staged.renamed` contains a shared memory path. This runs on **every commit** and most commits are edits.
2. Otherwise `listFiles(root)`, keep `isSharedMemoryPath`, read each, `readMemoryEntry`, `renderMemoryIndex`.
3. Write via `writeAtomic` **only when the text differs** from what is on disk, and report `memory/index.md` in `changed` only when it actually wrote. A `changed` entry the runner restages for a file it did not change is a no-op commit.

**Registration:** last in `VAULT_TRANSFORMS`, after `relink` and `archive-done` have finished moving and rewriting, so it indexes the tree they left behind. Default `true` in `VAULT_SETTING_DEFAULTS.hooks` — like `relink` and `normalize-md`, it only ever makes a change the author would not have noticed making.

**Gotchas:**
- `TRANSFORM_NAMES` in `vault-settings.ts` validates the settings block; a name added to `TransformName` and not there is dropped with a warning and the transform silently never runs.
- `transforms.ts` restates the defaults from `@holi/shared` rather than writing them out again. Keep it that way.
- The transform must never throw for a memory file it cannot read (deleted between `listFiles` and the read is normal). Skip it.

**Tests** (desktop `node` project, real git repos as the suite already does): a commit adding a memory file gets `index.md` in the same commit; a commit touching only `notes/` leaves `index.md` untouched and does no scan; a `.local.md` memory **never appears in the index**; a rename re-indexes under the new path; an indexer that throws is caught by the runner and the commit still lands.

---

### Task 3: `memory/` joins the agent surface

**Files:**
- Modify: `packages/shared/src/path-safety.ts`
- Test: `packages/shared/test/path-safety.test.ts` (extend)

`isAgentSurfacePath` returns true for `path.startsWith('memory/')`. A vault app hosts untrusted code, and `memory/` is what the user told the assistant, subdivided. Note in the doc comment that this is a **prefix** match, unlike the four exact filenames beside it, because it is a directory.

**Test:** `memory/x.md` and `memory/x.local.md` are refused; `notes/memory/x.md` is not (an ordinary note someone wrote, the same rule `AGENTS.md` already gets); `apps.docs` filters memory out of its listing, not just `apps.read`.

---

### Task 4: seed content

**Files:**
- Modify: `apps/desktop/src/main/agent/seed-content.ts`
- Test: `apps/desktop/test/seed-content.test.ts` (extend, or the existing seed suite)

Four changes:

1. **`AGENTS.md` §Memory rewritten.** A memory is one fact in one file under `memory/`, with `type` (free-form; a suggested starting set) and a one-line `description`. `memory/x.local.md` is personal and never leaves the clone. `memory/index.md` is generated, so edit the files and not the index. `MEMORY.md` and `USER.local.md` are legacy, still read, and worth splitting into `memory/` when the user asks.
2. **`memory/index.md` becomes a `ONCE_FILE`**, holding the empty-state form from Task 1, so the directory exists and is tracked from the first commit and the transform owns it after that. A `MANAGED_FILE` would fight the transform on every vault open.
3. **`MEMORY.md` leaves `ONCE_FILES`.** Existing vaults keep the file they have; new ones do not get one.
4. **`SETTINGS_JSON` gains `"autoMemoryEnabled": false`** and the `SessionStart` hook entry, and **`settingsWithRequired` merges both into existing vaults** — `autoMemoryEnabled` only when the key is absent, the hook entry only when no `memory-overview` string is already in the block. A seed that only runs at creation is a migration that never happens (D70's lesson, restated in that function).

**Gotcha:** `SEED_FILES` is `{...ONCE_FILES, ...MANAGED_FILES}` and other code asks it "is this a file Holi seeds?". Check what removing `MEMORY.md` from it changes before removing it — the seed-state and refresh paths both read it.

---

### Task 5: the overview hook

**Files:**
- Create: `apps/desktop/src/main/agent/hooks/memory-overview.mjs`
- Modify: `seed-content.ts` (already covered in Task 4's item 4)
- Test: `apps/desktop/test/memory-overview-hook.test.ts` (create) — run the hook as a child process against a temp vault, the way a hook is actually invoked.

**Contract:** reads `CLAUDE_PROJECT_DIR`, prints to stdout, `exit 0` **always**. Absent `memory/`, prints nothing.

Sections, in order, capped at **3,000 characters**:

1. `Types in use: convention (4), environment (2), person (1)` — counted from the index's section headings.
2. The index lines, verbatim from `memory/index.md`.
3. Personal memories, from a scan of `memory/**/*.local.md`, same one-line shape, under a heading that says they are personal and uncommitted.
4. `Recent: <date> <subject>` × 3, from `git log --format=%ad %s --date=short -n 3 -- memory/`.
5. One line, only when a non-empty `MEMORY.md` exists, suggesting it be split into `memory/`.

**Over the cap:** drop section 3's and section 2's descriptions first (keep every title, so nothing becomes invisible), then truncate with a pointer to `memory/index.md`. Never drop a whole section silently.

**Gotchas:**
- `SessionStart` fires with `source` of `startup`, `resume` **or** `compact`. Print on all three; compact is the case that matters most, because it is when the agent has just forgotten.
- The hook is spawned by Claude Code, not by Holi, so it has no `HOLI_HOOK_PORT` and must not need one. Pure local reads plus one `git`.
- `execFileSync('git', …)` with `timeout: 2000` and every failure swallowed. A vault mid-rebase, or a `memory/` with no commits yet, must print the rest and say nothing about recent changes.
- Keep it dependency-free (`node:` builtins only), like `user-prompt-submit.mjs` and `vault-app-check.mjs`.

---

### Task 6: verify in the running app

**Not optional, and it is the one thing tests cannot cover.** `autoMemoryEnabled` was read out of the Claude Code binary, not out of a document.

- [ ] `pnpm dev:debug`, open a vault, confirm the seed wrote `memory/index.md` and `.claude/settings.json` carries both new keys.
- [ ] Start an agent session and confirm the overview appears in the transcript, and that it is under the cap.
- [ ] **Confirm auto-memory is actually off**: ask the agent to remember something and check that no file appears under `~/.claude/projects/<sanitized vault path>/memory/`. If one does, `autoMemoryEnabled` is being ignored from projectSettings — fall back to `CLAUDE_CODE_DISABLE_AUTO_MEMORY` on the child env Holi already builds (`agent-runtime.ts`), and record that in the spec.
- [ ] Write two memory files in one turn and confirm **one** commit carries both plus the index.
- [ ] Write a `.local.md` memory and confirm it is in the overview and **not** in `memory/index.md`.

**Gotcha:** main-process edits do not hot reload. Kill scoped: `pkill -9 -f "better-holi-final/node_modules/.pnpm/electron@"`.

---

### Task 7: docs

- [ ] `docs/decisions.md` — a D89 row, and bump "next free" (D88 is the agent turn review's).
- [ ] `docs/upcoming.md` item 13 — closed, with the reason: vault-native memory replaces surfacing Claude Code's directory, and `autoMemoryEnabled: false` is what makes it the only surface.
- [ ] `docs/prd/agent.md` §Memory, and `docs/prd/vaults-sync.md` FR-9's transform list, which currently says three.
- [ ] A comment on [#3](https://github.com/syv-ai/holi/issues/3) recording what was adopted and what was not: no `log.md`, no `index.local.md`, shape-not-label on OKF, items 4 and 5 still open.

## Gates before done

```bash
pnpm -C packages/shared test
pnpm -C apps/desktop test    # the full suite
pnpm typecheck && pnpm lint  # 0 errors; 4 pre-existing warnings
```
