# Vault agent config isolation (D72) — implementation plan

> **For agentic workers:** use the executing-plans skill. Steps are `- [ ]` checkboxes.
> **Plan style:** contracts and gotchas, not inline code — the standing preference in this repo.

**Goal:** a vault agent sees Holi's config and the vault's config, and nothing
from the user's `~/.claude`.

**Spec:** `docs/specs/2026-08-14-vault-agent-config-isolation-design.md` ·
**Decision:** D72 (next free number is **D73**)

**Already shipped, do not rebuild** (`438ca2a`): `disableClaudeAiConnectors` in
the seeded vault settings, and the send gate matching `mcp__.*[Gg]mail.*`. This
plan is D72 laws 1, 2 and 4 — the config directory itself.

---

## What is true before you start

Verified on 2026-08-14 by measurement, not inference. **Do not re-derive these;
do re-check any that your change depends on.**

| Fact | Consequence |
| --- | --- |
| `CLAUDE_CONFIG_DIR` relocates every `~/.claude` path, and `~/.claude.json` too | one lever covers settings, skills, plugins, MCP and project state |
| A fresh config dir reports **`Not logged in · Please run /login`** | the switchover costs one login; Task 3 exists because of it |
| Symlinking `~/.claude.json` into a fresh dir does **not** restore the login | credentials are keyed to the directory; do not retry this |
| Session transcripts live at `<configDir>/projects/<cwd-slug>/` | one shared dir still gives each vault its own `--resume` |
| Settings precedence is managed > CLI > local > project > user | the vault's `.claude/settings.json` still outranks whatever Holi seeds |

**Suite baselines to beat:** node **1199**, dom **337**, shared **229**,
typecheck 0, eslint 0 errors (2 long-standing warnings in `EditorPane.tsx` /
`TaskDetail.tsx` are expected).

---

## Task 1 — `CLAUDE_CONFIG_DIR` in the agent's environment

**Files:** modify `src/main/agent/agent-runtime.ts`; extend
`test/agent-runtime.test.ts` — which already covers `buildAgentEnv`, including
the "reserved keys are stripped" cases this task extends.

**Contract.** `AgentEnvOpts` gains `configDir?: string | null`; `buildAgentEnv`
sets `CLAUDE_CONFIG_DIR` when it is supplied.

**Gotchas.**

- **Strip the inherited value first.** `buildAgentEnv` already does this for
  every `HOLI_*` key, with the reasoning written above them: a vault or user env
  must not be able to spoof the target. `CLAUDE_CONFIG_DIR` is the same class of
  key and a stronger one — an inherited value would silently put the agent back
  on the machine's config, or somewhere arbitrary.
- Absolute path only. Claude Code resolves it relative to nothing useful, and the
  agent's cwd is the vault.
- Leave `buildAgentArgs` alone. `--strict-mcp-config` stays off on purpose (D72
  law 3): a vault may declare its own MCP servers.

**Tests.** `configDir` sets the variable; an inherited `CLAUDE_CONFIG_DIR` is
stripped when no `configDir` is given; it is stripped and replaced when one is;
`PATH` prepending still works alongside it.

- [x] Write the failing tests · run `pnpm exec vitest run --project node test/agent-runtime.test.ts` · implement · re-run · commit

## Task 2 — provision the shared config directory

**Files:** create `src/main/agent/agent-config-dir.ts` and
`test/agent-config-dir.test.ts`; call it from wherever the agent's env is built
(`agent-manager.ts`, around the existing `buildAgentEnv` call site).

**Contract.**

```
ensureAgentConfigDir(userDataDir: string): Promise<string>   // returns the absolute path
isLoggedIn(configDir: string): Promise<boolean>              // reads .claude/.claude.json
```

`userData/agent-config/`. Created if absent, and seeded with a Holi-managed
`settings.json` carrying `disableClaudeAiConnectors: true` — a second layer
under the vault's own, so a vault whose `.claude/settings.json` is deleted still
gets no cloud connectors.

**Gotchas.**

- **Merge, do not overwrite.** Same rule as `settingsWithRequired`: this file
  will accumulate the user's own choices (their `/login`, their model
  preference), and rewriting it wholesale on every launch would discard them.
  Reuse the key-wise merge rather than writing a second one.
- **`ensureSeeded`'s lesson applies again.** Provision on *every* launch, not on
  first run — a seed that only runs at creation is a migration that never
  happens, and this directory will need new keys later.
- Do not create `projects/`, `sessions/` or `.claude.json`. Claude Code owns
  those and creates them itself; pre-creating them is guessing at another
  program's schema.
- `isLoggedIn` reads `oauthAccount` out of `<configDir>/.claude.json` and treats
  *any* read or parse failure as "not logged in". Absent is the common case on
  first run and is not an error.

**Tests.** The directory is created; a second call is a no-op that preserves an
existing key; the seeded settings carry the connector opt-out; `isLoggedIn` is
false for a missing file, false for malformed JSON, false when `oauthAccount` is
absent, true when it is present.

- [x] Write the failing tests · run · implement · re-run · commit

## Task 3 — say that a login is needed, without reading the terminal

**Files:** modify `src/renderer/src/features/agent/AgentPanel.tsx`; create
`src/renderer/src/features/agent/__tests__/AgentPanel.test.tsx`.

**It has no test today** — that directory contains one file and nothing else, so
this task creates the first one. Budget for that: mounting `AgentPanel` will
surface whatever it reaches for (`window.holi`, a PTY, atoms), and the useful
scope here is the notice, not the terminal. Consider extracting the
"needs a login" decision as a pure function and testing that, rather than
mounting the whole panel to assert one line of text.

**The rule, and it is the one worth restating:** Holi does not infer Claude
Code's state from its output. That decision predates this plan and is exactly
what someone would break here, because the words `Not logged in` are visible on
screen and scraping them looks like the shortest path. **The state is a file** —
Task 2's `isLoggedIn`. Surface it from there.

**Contract.** Before or alongside launching the agent, if `isLoggedIn` is false,
show a one-line notice in the panel: the vault agent now uses its own Claude
configuration, and `/login` is needed once. It is a notice, not a blocker — the
agent still starts, and `/login` is a thing the user types into it.

**Gotcha.** Check once per launch, not on a timer. The answer changes exactly
once, and polling a file to watch for it is the same instinct as polling the PTY.

- [x] Done in **main, not the renderer** — the panel already had this notice and it was
      about to start lying. See the D72 amendment; no `AgentPanel.test.tsx` was written.

## Task 4 — verification, including the part only a human can do

- [x] `pnpm exec node node_modules/typescript/bin/tsc --noEmit` → 0
- [x] `pnpm exec eslint src` → 0 errors
- [x] `pnpm exec vitest run --project node` → **≥ 1199** (background it; ~110s)
- [x] `pnpm exec vitest run --project dom` → **≥ 337**
- [x] from `packages/shared`: `pnpm exec vitest run` → **229**
- [ ] **Ask the user to run it** (this environment cannot keep a GUI Electron
      alive) and confirm, in a real vault: the panel says a login is needed;
      `/login` works once and sticks across a restart; **`/skills` no longer
      lists `find-skills`, `humanize-text`, `pr-review` or
      `web-artifacts-builder`**; Holi's own `gmail-calendar`, `md-to-pdf` and
      `theme` are still there; and asking for a draft uses `holi-google`, not a
      claude.ai connector.

## Task 5 — the record

- [x] Amend D72 with what was built, the suite numbers, and anything the build
      contradicted. **D70's "still unproven" list is now stale in one respect** —
      the gate's MCP blind spot was found in real use and is recorded in D72;
      make sure D70 points at it rather than reading as if the gate were whole.
- [x] Consolidate into `prd/agent.md` (§Tool surface and §Permissions) once
      built, per the D67–D71 pattern.

---

## Landmines in this repo

- **Main-process edits do not hot-reload.** Anything under `src/main/` needs a
  `pnpm dev` restart — and *this whole plan is main-process*, so nothing you
  change will appear until the app is restarted. Kill the Electron **child**,
  not just the `electron-vite` parent: an orphan holds the single-instance lock
  and the next `pnpm dev` shows the old window with a dead renderer, which looks
  exactly like a code bug. `pkill -f "better-holi-final.*Electron.app/Contents/MacOS/Electron"`.
- **`pnpm exec` always** — bare `node`/`npx` are broken. `cd` with absolute
  paths; the shell's cwd drifts between calls.
- **Never run `pnpm run format` / `prettier --write`** — it corrupts this repo.
  `printWidth` is 100; wrap by hand.
- **Node tests live in `apps/desktop/test/` and are not typechecked.** Renderer
  tests are co-located and must be `.test.tsx` — a `.test.ts` under
  `src/renderer/` silently never runs. Grep both when planning a change.
- **No personal name in code.** Fixtures use `Ada Holm` / `ada@syv.ai`; comments
  name a decision (a D-number or a date), never a person. `docs/` is exempt.
- Commit directly to `main`, trailer `Claude goes brr.. via Dash`. **The user
  approves pushes.**
