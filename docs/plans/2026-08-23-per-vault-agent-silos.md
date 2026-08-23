# Per-vault agent silos (D86) Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every vault its own Claude Code config directory, its own login, and its own agent theme, and say so in the panel when the login is missing.

**Architecture:** `ensureAgentConfigDir` stops being a per-launch call returning one shared path and becomes a per-spawn resolution keyed on the active vault's remote. A new `resolveVaultAgentConfig` sits between the manager and the disk: it slugs the remote, provisions `userData/agent-config/<slug>/`, stamps Claude Code's `theme` from the same `colorScheme` setting D85 resolves for the app, and reads `<dir>/.claude.json` for `oauthAccount` so the manager can print a sign-in instruction into the terminal record before the PTY writes a byte. A one-shot migration renames the existing shared directory into the most recently opened vault's slot so the vault someone actually uses keeps its login and its transcripts.

**Tech Stack:** TypeScript, Electron main process, node:fs/promises, Vitest (the `node` project — `apps/desktop/test/*.test.ts`).

---

## Decisions this plan locks (not in the spec, made here)

- **The slug is `<sanitized remote>-<sha1(remote) first 8 hex>`.** The spec suggests matching Claude Code's `projects/` convention (every non-alphanumeric → `-`). That alone is not injective: `syv/better-holi` and `syv-better/holi` both sanitize to `syv-better-holi`, and two vaults silently sharing a config directory is exactly the plugin leak D86 exists to kill. The hash suffix costs eight characters of legibility and makes the collision impossible by construction.
- **The login notice goes into the terminal scrollback, not the panel header.** D72 deliberately deleted a header login notice because `/login` fires no event that would push status, so the header's copy went stale the moment it mattered. Scrollback is a log, not state: a line printed at spawn is still true about that spawn. It is written to the mirror inside `start()`, where `attached` is always false (teardown clears it), so the renderer picks it up from `attach()`'s replay with no second send path.
- **A malformed `.claude.json` reads as logged in.** A missing file is the fresh-directory case and must nag; unparseable JSON is vanishingly rare and nagging on uncertainty is worse than staying quiet.
- **The theme is resolved in main, not fetched from the renderer.** `readVaultSettings(root).colorScheme` plus `nativeTheme.shouldUseDarkColors` through `resolveColorMode` is the same pure function `activeModeAtom` uses, so no IPC round trip and no new renderer→main channel.
- **The mid-session theme note is renderer-side and reactive.** `.holi/settings.local.json` is deliberately outside `AGENT_CONFIG_FILES` (PRD: `*.local.*` never syncs, so no pull can change it), and widening that set to catch a local theme flip would contradict its stated reason. The panel compares the mode now against the mode at spawn instead.

## File structure

| File | Responsibility |
|---|---|
| `apps/desktop/src/main/agent/agent-config-dir.ts` (modify) | Slug, per-vault provisioning, the settings merge (two rules now), the `oauthAccount` read, the one-shot migration. Everything that touches `userData/agent-config/`. |
| `apps/desktop/src/main/agent/agent-manager.ts` (modify) | Swaps the `configDir` string dep for a per-spawn resolver; prints the sign-in notice. |
| `apps/desktop/src/main/index.ts` (modify) | Builds the resolver closure (it owns `app.getPath('userData')` and `nativeTheme`); runs the migration once at launch. |
| `apps/desktop/src/renderer/src/lib/agent-notices.ts` (create) | Pure: does the panel owe the user a "restart to change Claude's theme" line? |
| `apps/desktop/src/renderer/src/features/agent/AgentPanel.tsx` (modify) | Renders that line. |
| `apps/desktop/test/agent-config-dir.test.ts` (modify) | Existing suite; the signature change breaks every case in it. |
| `apps/desktop/test/agent-notices.test.ts` (create) | The pure note rule. |
| `apps/desktop/test/agent-manager.test.ts` (modify) | Per-spawn resolution, the notice in the mirror. |
| `docs/decisions.md`, `docs/prd/agent.md` (modify) | D86 goes from agreed to built; §Config layering's "one shared directory / one `/login` once ever" paragraph is now wrong. |

Test commands throughout:

```bash
pnpm -C apps/desktop exec vitest run --project node test/<file>.test.ts
```

Bare `node`/`npx` do not work in this shell. Always `pnpm exec`.

---

### Task 1: The slug

**Files:**
- Modify: `apps/desktop/src/main/agent/agent-config-dir.ts`
- Test: `apps/desktop/test/agent-config-dir.test.ts`

**Contract:**

```ts
/** Filesystem-safe, stable, collision-free directory name for a vault's config. */
export function agentConfigSlug(remote: string): string
```

Sanitize every character outside `[A-Za-z0-9]` to `-`, collapse runs of `-`, trim leading/trailing `-`, lowercase, then append `-` + `createHash('sha1').update(remote).digest('hex').slice(0, 8)`.

- [x] **Step 1: Write the failing tests**

In a new `describe('agentConfigSlug')`:
- `'nthomsencph/privat'` starts with `'nthomsencph-privat-'` and matches `/^[a-z0-9-]+$/`.
- The same remote twice gives the same string (stability is the whole point — a slug that drifts orphans a login).
- `'syv/better-holi'` and `'syv-better/holi'` differ (the collision this suffix exists for).
- A remote of only punctuation (`'///'`) still yields a non-empty, `/`-free name.

- [x] **Step 2: Run and watch it fail**

`pnpm -C apps/desktop exec vitest run --project node test/agent-config-dir.test.ts`
Expected: FAIL, `agentConfigSlug is not a function`.

- [x] **Step 3: Implement it**

Import `createHash` from `node:crypto`. Guard the all-punctuation case by letting the hash carry the name when the sanitized half is empty.

- [x] **Step 4: Green**

Same command. Expected: the four new cases PASS; the existing `ensureAgentConfigDir` cases still pass (untouched so far).

- [x] **Step 5: Commit**

```bash
git add apps/desktop/src/main/agent/agent-config-dir.ts apps/desktop/test/agent-config-dir.test.ts
git commit -m "feat(agent): a vault's config directory has a name of its own"
```

---

### Task 2: One directory per vault, and the theme in it

**Files:**
- Modify: `apps/desktop/src/main/agent/agent-config-dir.ts`
- Test: `apps/desktop/test/agent-config-dir.test.ts`

**Contract:**

```ts
/** The parent. Unchanged value, new meaning: it now holds one directory per vault. */
export const AGENT_CONFIG_DIR_NAME = 'agent-config'

export async function ensureAgentConfigDir(
  userDataDir: string,
  remote: string,
  opts?: { theme?: 'dark' | 'light' },
): Promise<string>   // → join(userDataDir, AGENT_CONFIG_DIR_NAME, agentConfigSlug(remote))
```

`settingsWithRequired(existing, opts)` gains a second rule and keeps the first:

| key | rule | why |
|---|---|---|
| `disableClaudeAiConnectors` | set **only when absent** | it is a default; a user who wrote `false` is not overruled |
| `theme` | set on **every** spawn when `opts.theme` is given | it tracks a live Holi setting, so the last write must win |

Return `null` (write nothing) when neither rule changed anything, and on unparseable JSON. Both existing behaviours — merge rather than overwrite, never touch a malformed file — survive verbatim.

**Gotchas:**
- Do not create `projects/`, `sessions/` or `.claude.json`. The existing test asserting `readdir(configDir) === ['settings.json']` is load-bearing: pre-creating another program's state store is guessing at its schema.
- `mkdir(..., { recursive: true })` makes the parent for free. Do not `mkdir` the parent separately.

- [x] **Step 1: Update the existing suite to the new signature, and add the new cases**

Every existing call becomes `ensureAgentConfigDir(userData, 'owner/repo')`. Then add:
- returns `join(userData, 'agent-config', agentConfigSlug(remote))`.
- two different remotes get two different directories, and writing `model: 'opus'` into one leaves the other's settings without it (the isolation claim, asserted directly).
- `{ theme: 'light' }` writes `"theme": "light"`; calling again with `{ theme: 'dark' }` **overwrites** it to `dark` while a user-set `model: 'opus'` alongside survives (the merge rule and the every-spawn rule at once).
- no `theme` in `opts` leaves any existing `theme` key untouched.
- a malformed settings file is still left byte-identical even when a theme is requested.

- [x] **Step 2: Run and watch it fail**

Expected: FAIL — first on arity/type, then on the theme assertions.

- [x] **Step 3: Implement**

Thread `remote` into the `join`, thread `opts` into `settingsWithRequired`, and rewrite the module docblock: the paragraph beginning *"**One directory, shared by every vault.**"* now argues the opposite and must say why (capability, not history — `plugins/` is keyed by nothing).

- [x] **Step 4: Green**

- [x] **Step 5: Commit**

```bash
git commit -am "feat(agent): one config directory per vault, carrying its theme"
```

---

### Task 3: The sign-in pre-flight (§6, never built)

**Files:**
- Modify: `apps/desktop/src/main/agent/agent-config-dir.ts`
- Test: `apps/desktop/test/agent-config-dir.test.ts`

**Contract:**

```ts
/** Is this config directory signed in? Reads `<dir>/.claude.json` for `oauthAccount`.
 *  Never throws, never scrapes the PTY (standing decision — the answer is a JSON key). */
export async function isAgentSignedIn(configDir: string): Promise<boolean>
```

| state of `.claude.json` | result |
|---|---|
| absent | `false` — the fresh-directory case, the one that must nag |
| present, `oauthAccount` object present | `true` |
| present, no `oauthAccount` key | `false` |
| present, unparseable | `true` — do not nag on uncertainty |

- [x] **Step 1: Write the four failing cases**, one per row.

- [x] **Step 2: Run and watch it fail.**

- [x] **Step 3: Implement.**

- [x] **Step 4: Green.**

- [x] **Step 5: Commit**

```bash
git commit -am "feat(agent): read the sign-in state instead of leaving it to be inferred"
```

---

### Task 4: The per-spawn resolver

**Files:**
- Modify: `apps/desktop/src/main/agent/agent-config-dir.ts`
- Test: `apps/desktop/test/agent-config-dir.test.ts`

**Contract:**

```ts
export interface AgentConfigResolution {
  /** Absolute path for `$CLAUDE_CONFIG_DIR`. */
  dir: string
  /** False → the manager prints the `/login` instruction into the terminal. */
  signedIn: boolean
}

export async function resolveVaultAgentConfig(args: {
  userDataDir: string
  remote: string
  /** The vault's clone dir — `colorScheme` is read from its `.holi/settings*.json`. */
  root: string
  /** What the OS reports right now. Injected: this module must not import electron. */
  systemPrefersDark: boolean
}): Promise<AgentConfigResolution>
```

Body: `readVaultSettings(root)` → `resolveColorMode(settings.colorScheme, systemPrefersDark)` → `ensureAgentConfigDir(userDataDir, remote, { theme })` → `isAgentSignedIn(dir)`.

**Gotchas:**
- `resolveColorMode` and `readVaultSettings` already exist (`packages/shared/src/vault-settings.ts:597`, `main/vault/settings.ts:40`). Do not re-derive the mode; `system` must mean the same thing to the agent as it does to `data-theme`, and one function is how that stays true.
- **No `electron` import in this module.** `agent-manager.ts` states the same rule for the same reason (it must load under vitest), and this module is now on that path.

- [x] **Step 1: Write the failing tests.** Build a temp vault root with a `.holi/settings.local.json`.
  - `colorScheme: 'light'` → the directory's `settings.json` says `"theme": "light"`.
  - `colorScheme: 'system'` with `systemPrefersDark: true` → `"dark"`; with `false` → `"light"`.
  - a vault with no `.holi/settings.local.json` at all resolves rather than throwing (the default is `system`).
  - a fresh directory returns `signedIn: false`.

- [x] **Step 2: Run and watch it fail.**

- [x] **Step 3: Implement.**

- [x] **Step 4: Green.**

- [x] **Step 5: Commit**

```bash
git commit -am "feat(agent): resolve a vault's config directory, theme and sign-in together"
```

---

### Task 5: The manager resolves per spawn

**Files:**
- Modify: `apps/desktop/src/main/agent/agent-manager.ts`
- Test: `apps/desktop/test/agent-manager.test.ts`

**Contract change on `AgentManagerDeps`:**

```ts
// REMOVED — a path fixed at app launch cannot follow a vault switch:
//   configDir?: string | null
/** Per spawn (D86): the active vault changes while the app runs. Omitted (tests,
 *  and only tests) → the agent runs on the machine config with no notice. */
resolveConfigDir?: (vault: { remote: string; root: string }) => Promise<AgentConfigResolution | null>
```

In `start()`, after `workRoot` is known and **before** `runtime.start`:

1. `const config = (await deps.resolveConfigDir?.({ remote: vault.remote, root: workRoot })) ?? null`
2. Pass `configDir: config?.dir ?? null` into `buildAgentEnv` (the existing key, unchanged downstream).
3. If `config && !config.signedIn`, write the notice into `terminal` (the `TerminalMirror`) before `runtime.start`.

**Notice text** — no em dashes, and it must explain the per-vault part or the second `/login` reads as a bug:

```
This vault needs its own Claude sign-in. Type /login below.
Each vault keeps its own Claude Code config, so signing in here
does not touch your other vaults.
```

Written as `\x1b[33m…\x1b[0m` with `\r\n` line endings, straight to `terminal.write(...)`.

**Gotchas:**
- Write to the **mirror only**, not through the `agent-pty:data` send path. `teardown()` runs at the head of every `start()` and sets `attached = false`, so nothing is listening yet; the renderer gets the line from `attach()`'s replay. Sending it as well would double it on the first attach.
- The write must precede `runtime.start`, so the instruction is above Claude's own output rather than buried under an Ink redraw.
- `resolveConfigDir` is `await`ed on the spawn path. It is two small file reads; do not make it fire-and-forget, because the env has to carry the path.
- If it rejects, the spawn must not die — an unreadable settings file should not cost the user their agent. Wrap in `.catch(() => null)` and `log()` it, matching how `resolveTypstBin` is treated.

- [x] **Step 1: Write the failing tests**

Extend `rig()` to take `resolveConfigDir` instead of `configDir` (default: omitted). New cases:
- the resolver is called with the **active vault's** remote and root, and `spawn.opts.env.CLAUDE_CONFIG_DIR` is what it returned.
- it is called **again on a second `start()`**, and a resolver returning a different path for a different remote puts the second path in the second spawn's env (the per-spawn claim; today's code would reuse the launch value).
- `signedIn: false` → `await manager.attach()` contains `/login`.
- `signedIn: true` → the replay does **not** contain `/login`.
- a rejecting resolver still spawns, with no `CLAUDE_CONFIG_DIR` in the env.

- [x] **Step 2: Run and watch it fail**

`pnpm -C apps/desktop exec vitest run --project node test/agent-manager.test.ts`

- [x] **Step 3: Implement.** Update the `configDir` docblock on `AgentManagerDeps` — it currently cites D72's shared directory.

- [x] **Step 4: Green.**

- [x] **Step 5: Commit**

```bash
git commit -am "feat(agent): the config directory is resolved per spawn, not per launch"
```

---

### Task 6: Migration — the shared directory becomes a vault's

**Files:**
- Modify: `apps/desktop/src/main/agent/agent-config-dir.ts`
- Test: `apps/desktop/test/agent-config-dir.test.ts`

**Contract:**

```ts
/** One-shot: `userData/agent-config/` (flat, shared, logged in, holding one vault's
 *  transcripts) becomes `userData/agent-config/<slug>/`. Run once at launch, before
 *  any spawn. A rename of a whole directory, never a rewrite of its contents. */
export async function migrateSharedAgentConfig(
  userDataDir: string,
  remote: string,
): Promise<'moved' | 'skipped'>
```

Algorithm, with a staging directory `userData/agent-config.migrating` because a directory cannot be renamed into itself:

1. If `agent-config.migrating` exists, a previous run was interrupted — resume from step 4 using it as the source.
2. Else if `agent-config/settings.json` is not a file, return `'skipped'`. (Every install that ever ran `ensureAgentConfigDir` has one; the new layout has only subdirectories.)
3. `rename(agent-config, agent-config.migrating)`.
4. If `agent-config/<slug>` already exists, return `'skipped'` without clobbering it.
5. `mkdir(agent-config)`, then `rename(agent-config.migrating, agent-config/<slug>)`, return `'moved'`.

**Gotchas:**
- Steps 3 and 5 are same-volume renames, which is why this is safe where copying transcripts was not (the 2026-08-14 spec refused to rewrite another program's state store; this never opens a file).
- Idempotent by construction: after a move there is no `agent-config/settings.json`, so a second run returns `'skipped'`.
- The 444-file `plugins/` directory rides along into the chosen vault. That is correct: it is where those plugins were installed from.

- [x] **Step 1: Write the failing tests**
  - a flat directory holding `settings.json`, `.claude.json` and a `projects/` subtree ends up whole under `<slug>/`, with `.claude.json` byte-identical (the login survives).
  - running it twice returns `'moved'` then `'skipped'`, and nothing moves the second time.
  - a `userData` with no `agent-config` at all returns `'skipped'` and creates nothing.
  - an already-migrated layout (`agent-config/<slug>/settings.json`, no top-level `settings.json`) returns `'skipped'`.
  - an orphaned `agent-config.migrating` from an interrupted run is picked up and completed.

- [x] **Step 2: Run and watch it fail.**

- [x] **Step 3: Implement.**

- [x] **Step 4: Green.**

- [x] **Step 5: Commit**

```bash
git commit -am "feat(agent): the shared config directory becomes the vault that was using it"
```

---

### Task 7: Wire it in main

**Files:**
- Modify: `apps/desktop/src/main/index.ts` (around `:444`)

No test — this is composition over units already covered, and `index.ts` imports `electron` so it does not load under vitest. `typecheck` is the gate.

Replace the `ensureAgentConfigDir(app.getPath('userData'))` call and the `configDir:` dep with:

```ts
const userDataDir = app.getPath('userData')
// D86: the shared directory (D72) belonged to whichever vault was actually being
// used. `list()` is sorted lastOpenedAt desc, so that is entry zero. A fresh
// install has neither an old directory nor an entry; both paths no-op.
const firstVault = (await registry.list())[0]?.remote
if (firstVault) {
  await migrateSharedAgentConfig(userDataDir, firstVault).catch((err) =>
    console.warn('[agent] config migration skipped:', err),
  )
}

agent = createAgentManager({
  host,
  resolveConfigDir: ({ remote, root }) =>
    resolveVaultAgentConfig({
      userDataDir,
      remote,
      root,
      // Read at spawn, not captured: the OS preference changes while the app runs.
      systemPrefersDark: nativeTheme.shouldUseDarkColors,
    }),
  // …rest unchanged
})
```

**Gotchas:**
- `nativeTheme` joins the `electron` import at `index.ts:21` (`app, BrowserWindow, dialog, ipcMain, protocol, type Tray`).
- The migration must be `await`ed before `createAgentManager`, or a fast first spawn could provision an empty directory beside the one being moved.
- `registry` is constructed at `index.ts:198`, in the same scope as the agent wiring at `:444`. No new plumbing.

- [x] **Step 1: Make the edit.**

- [x] **Step 2: Typecheck**

`pnpm -C apps/desktop typecheck` → clean.

- [x] **Step 3: Commit**

```bash
git commit -am "feat(agent): wire per-vault config, and move the shared one into its vault"
```

---

### Task 8: The theme's known limit, said in the panel

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/agent-notices.ts`
- Create: `apps/desktop/test/agent-notices.test.ts`
- Modify: `apps/desktop/src/renderer/src/features/agent/AgentPanel.tsx`

Claude Code reads `settings.json` at start, so flipping Holi's theme leaves a running session on the old one. The spec's answer is a sentence, not a hot-swap.

**Contract:**

```ts
/** The panel's theme nudge, or null. Pure so it can be tested without xterm. */
export function agentThemeNote(args: {
  running: boolean
  /** The resolved mode when the live session spawned; null when none has. */
  modeAtSpawn: 'light' | 'dark' | null
  mode: 'light' | 'dark'
}): string | null
```

Returns `'restart to change Claude’s theme'` only when `running && modeAtSpawn !== null && modeAtSpawn !== mode`. Null otherwise.

- [x] **Step 1: Write the failing tests** — one per branch: not running, no spawn recorded, matching modes, differing modes.

- [x] **Step 2: Run and watch it fail.**

`pnpm -C apps/desktop exec vitest run --project node test/agent-notices.test.ts`

- [x] **Step 3: Implement the helper.**

- [x] **Step 4: Green.**

- [x] **Step 5: Render it in `AgentPanel.tsx`**

- `const mode = useAtomValue(activeModeAtom)` (`@/state/color-scheme`).
- `const modeAtSpawnRef = useRef<'light' | 'dark' | null>(null)`, set to `mode` inside `startSession` on a successful start, cleared to `null` in the `onExit` handler. A ref is not reactive, so mirror it into `useState` — the note has to re-render when the mode flips.
- Render beside the existing `status.configStale` span, same `text-amber-400/80 truncate` treatment.
- Leave the D72 "no login notice here" comment in place and **extend it**: the sign-in instruction now exists, and it lives in the scrollback for the reason that comment gives.

- [x] **Step 6: Commit**

```bash
git commit -am "feat(agent): say that a theme change reaches Claude on restart"
```

---

### Task 9: Full suite, then the docs

**Files:**
- Modify: `docs/decisions.md`, `docs/prd/agent.md`

- [x] **Step 1: Run the whole desktop suite**

```bash
pnpm -C apps/desktop test
```

Every file, both projects. Memory's rule: `typecheck` misses fake-preload gaps, so the full suite runs before this is called done.

- [x] **Step 2: Typecheck the workspace**

```bash
pnpm typecheck
```

- [x] **Step 3: Update `docs/prd/agent.md` §Config layering**

Three things in it are now false and are the point of this change:
- *"`CLAUDE_CONFIG_DIR` points the agent at `userData/agent-config/`"* → `userData/agent-config/<vault-slug>/`, resolved per spawn.
- *"It costs one `/login`, once, ever… One shared directory for every vault, because per-vault would charge that per vault while buying separate settings nothing needs"* → this is the sentence D86 overturns. Replace with the capability argument (`plugins/` is keyed by nothing), the per-vault `/login`, and that it is lazy: asked the first time the agent opens in that vault, never during onboarding.
- Add that Holi now stamps `theme` in that file from the vault's `colorScheme`, on every spawn, and that a running session keeps its old theme until restarted.
- Add a line on the migration: the shared directory was renamed into the most recently opened vault, so one vault kept its login and its transcripts and the others start fresh.

- [x] **Step 4: Update `docs/decisions.md`**

D86's row says **"Agreed 2026-08-23, not built."** Change it to built, and add what the build settled that the design did not: the hash-suffixed slug and why sanitizing alone was not enough; that the sign-in instruction lives in the scrollback rather than the header, on D72's own argument; that the migration is a whole-directory rename to the `lastOpenedAt` head; and that the mid-session theme note is renderer-side because `*.local.*` is deliberately outside `AGENT_CONFIG_FILES`.

Leave D87 exactly as it is. It is agreed, not designed, and nothing here touches it.

- [x] **Step 5: Commit**

```bash
git add docs apps
git commit -m "docs: D86 is built, and the agent's config is a vault's own"
```

---

## Out of scope, deliberately

- **D87 (per-vault Google).** Named as a separate build in the spec's own companion section. Nothing in this plan touches `userData/google-auth.enc`, the loopback flow, `holi-google`, or the mail/calendar cache.
- **Whose Claude account fills these directories.** The spec leaves it open (2026-08-14 §8); this makes the directories separate and decides nothing about identity.
- **Surfacing per-vault plugins as a feature.** A consequence of this change, listed as open. No UI here.
- **Symlinking home plugins (§8's escape hatch) into a vault's directory.** Still available by hand, now per vault; no code.

## Self-review notes

Spec coverage checked section by section: the decision (Task 2), per-spawn resolution (Tasks 4, 5, 7), the stable filesystem-safe name (Task 1), `settingsWithRequired` keeping merge-not-overwrite while theme writes every spawn (Task 2), §6's `oauthAccount` read with no PTY scraping (Tasks 3, 5), the panel wording (Task 5), migration by whole-directory rename (Tasks 6, 7), the theme's known limit (Task 8), docs (Task 9). The lazy-login requirement is met by construction — nothing in onboarding is touched, and the notice fires on first spawn in a vault.
