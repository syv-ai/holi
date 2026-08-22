# Landing target & vault settings — implementation plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A vault says what it opens on, and a user is asked for that (and three neighbours) when the vault is created.

**Architecture:** One pure resolver in `packages/shared` parses `.holi/settings.json` under its per-key `.holi/settings.local.json` override and hands main a typed shape; the two existing hand-rolled readers of that file fold into it. The renderer resolves a `landing` target to one `openSingleton`/`openApp`/`openPinned` call, with rot collapsing to today's daily. A fourth onboarding act, rendered from a declared descriptor list that the seed also reads, writes the answers into the vault at birth.

**Spec:** [`docs/specs/2026-08-22-landing-and-vault-settings-design.md`](../specs/2026-08-22-landing-and-vault-settings-design.md). Read it first — the *why* for every decision below lives there and is not repeated here.

**Tech stack:** TypeScript, jotai atoms, tRPC over Electron IPC, Vitest (three projects: `shared`, and desktop's `node` + `dom`).

---

## Before you start

**Gates.** Run from `/Users/nicolaibthomsen/repos/syv/better-holi-final` with absolute paths — the cwd drifts, and a `cd` inside a compound command does not persist.

| what | command | baseline |
|---|---|---|
| shared | `pnpm --filter @holi/shared exec vitest run` | 329 |
| desktop node | `cd apps/desktop && pnpm exec vitest run --project node` | 1653, ~2.5 min |
| desktop dom | `cd apps/desktop && pnpm exec vitest run --project dom` | 543 |
| types | `pnpm typecheck` | clean |
| lint | `cd apps/desktop && pnpm exec eslint src` | 0 errors, **exactly 2** known warnings (`EditorPane.tsx:236`, `TaskDetail.tsx:404`) |

**`pnpm exec` always** — bare `node`/`npx` are broken in this shell. **Never run the node suite in parallel with another suite.** A third eslint warning is yours: fix it, don't silence it.

**Hot reload.** Renderer edits reload. **Main-process and `packages/shared` edits do not** — relaunch with `pnpm dev:debug` (CDP on port 9333) before verifying anything that touched them. This bites in tasks 2, 3, 7, 8.

**Where tests live.** Pure logic in `packages/shared/src/` is tested from `packages/shared/test/`. Pure logic in `src/renderer/src/lib/` and atom behaviour are tested from `apps/desktop/test/*.test.ts` in the **node** project — *not* co-located. Only `src/renderer/**/*.test.tsx` runs in `dom`. Grep all three trees before assuming a test is absent.

**Prettier.** Run it on files you *wrote*, not files you merely edited. `.prettierrc.json` now carries `semi: false`; the repo is written without semicolons.

**Assert every scripted edit.** If you use a script to do a replacement, `assert old in s` before every `.replace` — a silently no-op'd edit surfaces as a test failure minutes later, with no clue where.

**On this plan's shape.** It gives contracts, decisions, ported constants, test *intent* and gotchas — not inline implementations or full test files. That is deliberate and is the house rule for plans here; you are expected to derive the code. Where an exact string appears (a JSON key, a file path, a default value), the string **is** the decision and must be used verbatim.

**Mutation-check your tests.** After each task goes green, break the implementation in two or three specific ways and confirm a test catches each. Two tests that passed for the wrong reason were caught this way in the last session, and one caught an error in a *doc*.

---

## File structure

**Create**

| file | responsibility |
|---|---|
| `packages/shared/src/vault-settings.ts` | pure parse → merge → validate → defaults for the *whole* `.holi/settings.json`; the descriptor list |
| `packages/shared/test/vault-settings.test.ts` | its tests |
| `apps/desktop/src/main/vault/settings.ts` | the disk half — read both files, write per file atomically |
| `apps/desktop/src/renderer/src/lib/landing-target.ts` | pure `resolveLanding` — settings + what the vault holds → the target to open |
| `apps/desktop/src/renderer/src/state/landing.ts` | `openLandingAtom` — read, resolve, one dispatch call |
| `apps/desktop/src/renderer/src/features/onboarding/VaultSettingsAct.tsx` | the fourth act's view |
| `apps/desktop/src/renderer/src/state/color-scheme.ts` | the mode atom, the `data-theme` stamp, the `system` listener |
| `apps/desktop/test/landing-target.test.ts`, `landing.test.ts`, `color-scheme.test.ts` | node-project tests |

**Modify**

| file | change |
|---|---|
| `apps/desktop/src/main/vault/vault-settings.ts` | `readMaxCommittedFileBytes` calls the shared resolver; **signature unchanged** |
| `apps/desktop/src/main/vault/hooks/transforms.ts:52-77` | `readHookSettings` likewise; **signature unchanged** |
| `apps/desktop/src/main/agent/seed-content.ts` | `HOLI_SETTINGS` built from the descriptor list, not the hand-written literal; seed `.holi/settings.local.json` |
| `apps/desktop/src/main/router.ts` | new `settings` router (`read`, `write`), registered in the root router |
| `apps/desktop/src/renderer/src/state/daily.ts` | `openTodaysDailyAtom` unconditional; `sweepDailyAtom` gated on `dailyNotes`; `isPersonalVault` deleted |
| `apps/desktop/src/renderer/src/components/Shell.tsx:219-227` | `openVault → openLanding → sweepDaily` |
| `apps/desktop/src/renderer/src/state/onboarding-flow.ts` | `Act = 1|2|3|4`; settings answers on the reducer state |
| `apps/desktop/src/renderer/src/features/onboarding/OnboardingRitual.tsx` | fourth dot, fourth act, `s.act === 3` guards become `4` |
| `apps/desktop/src/renderer/src/state/theme.ts` | `activeMode()` reads the atom; `useVaultTheme` re-runs on a flip |

---

# Slice 1 — the landing target

Closes worklist item 15. Ships with no UI: the keys are authored in the file, which is the stance.

---

### Task 1: The shared resolver

**Files:**
- Create: `packages/shared/src/vault-settings.ts`
- Create: `packages/shared/test/vault-settings.test.ts`
- Modify: `packages/shared/src/index.ts` (add `export * from './vault-settings'`)

**Contract:**

```
resolveVaultSettings(committedJson: string | null, localJson: string | null): ResolvedVaultSettings
```

`ResolvedVaultSettings` = `{ landing, dailyNotes, colorScheme, hooks, maxCommittedFileBytes, warnings }`. Every field non-optional and defaulted; `warnings: string[]` mirrors `ResolvedTheme.warnings` so a typo is diagnosable rather than silent.

`LandingTarget` is a discriminated union, exported: `{kind:'daily'}` · `{kind:'note', path}` · `{kind:'app', appId}` · `{kind:'board'|'agenda'|'mail'}`.

**Decisions to encode:**

- **Not the `Tab` union.** `Tab` lives in the renderer and `SingletonTab` is a *named* literal precisely so `openSingleton(w,'app')` cannot typecheck (`panes.ts:38-44`). Define `LandingTarget` here independently; the renderer maps it. Do not import across.
- **Per-key override at the top level.** Parse both files, local last. Copy the shape of `resolveIconMap` (`packages/shared/src/icon-map.ts:107-130`) — `parseMap` returning `{}` for anything that is not a JSON object is exactly the degrade-never-throw behaviour wanted here.
- **`hooks` merges per transform key**, not wholesale — a local file naming one transform must not disable the others.
- **A fresh narrow object per kind.** Follow `parseTabPayload` (`src/renderer/src/lib/tab-drop.ts`) exactly: check every field, build a new object, `null`/default on anything else. Never return the parsed value. The committed file is written by a teammate; this is a trust boundary, and it is the *stronger* case for the validator, not the weaker one.
- **Nothing throws, ever.** Missing file, corrupt JSON, unknown `kind`, wrong type, `landing` as an array — each resolves to the default and pushes a warning.

**Defaults** (export as `VAULT_SETTING_DEFAULTS`, one object — task 7's descriptors and the seed both read it):

| key | default | note |
|---|---|---|
| `landing` | `{kind:'daily'}` | unset means daily |
| `dailyNotes` | `true` | |
| `colorScheme` | `'system'` | consumed in slice 3; resolved from day one so the key is never "unknown" |
| `hooks` | `{relink:true, 'normalize-md':true, 'archive-done':false}` | must match today's `DEFAULT_HOOKS` in `transforms.ts` exactly |
| `maxCommittedFileBytes` | `DEFAULT_MAX_COMMITTED_FILE_BYTES` | re-declare the 10 MB number here; `large-files.ts` keeps its own const and task 2 asserts they agree |

- [ ] **Step 1: Write the failing tests.** Cover: both files absent → all defaults; committed only; local overriding one key and inheriting the rest; `hooks` merging per transform key; every `landing` kind round-tripping; a `note` landing with an empty-string path → default + warning; unknown `kind` → default + warning; `landing` as an array, a string, `null` → default; corrupt JSON in either file → that file ignored, the other still applied; a hostile object with extra keys → they do not appear on the result. Mirror `packages/shared/test/theme.test.ts` for style.

- [ ] **Step 2: Run and watch them fail.** `pnpm --filter @holi/shared exec vitest run vault-settings` — expect "Failed to resolve import".

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Green.** `pnpm --filter @holi/shared exec vitest run vault-settings`, then the full shared suite — **330+**, and no existing test regressed.

- [ ] **Step 5: Mutation-check.** Break three things in turn and confirm a test catches each: make the merge put local *first*; make `hooks` replace instead of merge; make the `note` branch return the parsed object rather than a fresh one. Revert each. A test that survives all three is passing for the wrong reason.

- [ ] **Step 6: Commit.** `git add packages/shared/src/vault-settings.ts packages/shared/src/index.ts packages/shared/test/vault-settings.test.ts`

---

### Task 2: The disk half, and the two readers fold into it

**Files:**
- Create: `apps/desktop/src/main/vault/settings.ts`
- Modify: `apps/desktop/src/main/vault/vault-settings.ts`, `apps/desktop/src/main/vault/hooks/transforms.ts:52-77`

**Contract:**

```
readVaultSettings(root: string): Promise<ResolvedVaultSettings>
```

Reads `.holi/settings.json` and `.holi/settings.local.json` in parallel, hands both texts to `resolveVaultSettings`. **Mirror `main/vault/theme.ts` line for line** — same `readOrNull` helper, same never-throws contract, same file-name constants exported (`SETTINGS_FILE`, `SETTINGS_LOCAL_FILE`).

`writeVaultSettings` is task 8's; do not build it yet.

**Decisions:**

- `readMaxCommittedFileBytes(root)` and `readHookSettings(root)` **keep their exact signatures and their doc comments' promises**. Their bodies become a call to `readVaultSettings` plus a field pick. Their existing tests are the regression guard — they must pass untouched.
- Both are on the **commit path**. A behaviour change here is a corrupted commit, so the bar is: existing tests pass with zero edits.

- [ ] **Step 1: Add one assertion first.** In the shared test file, assert `VAULT_SETTING_DEFAULTS.maxCommittedFileBytes === DEFAULT_MAX_COMMITTED_FILE_BYTES`'s numeric value (10 MB, as a literal). Two constants that must agree and don't is exactly the drift this fold could introduce.

- [ ] **Step 2: Write `main/vault/settings.ts`.**

- [ ] **Step 3: Rewire the two readers.** Do not touch their signatures. Delete the hand-rolled parsing bodies.

- [ ] **Step 4: Run the node suite.** `cd apps/desktop && pnpm exec vitest run --project node` — **1653**, all green, **and no test file edited**. If a hook or large-file test needed changing, the fold changed behaviour: stop and find out why.

- [ ] **Step 5: Commit.**

---

### Task 3: `settings.read` on the router

**Files:** Modify `apps/desktop/src/main/router.ts` (new `settings` router beside `theme` at `:1416`; register it in the root router at `:1938`)

**Contract:** `settings.read` — `.input(fields({ remote: 'string' })).query(...)` → `Promise<ResolvedVaultSettings>`. A read, mirroring `theme.read` at `router.ts:1417-1419`. `settings.write` arrives in task 8.

**Gotcha:** main does not hot-reload. Relaunch `pnpm dev:debug` before any manual check.

- [ ] **Step 1: Add the router and register it.**
- [ ] **Step 2: `pnpm typecheck`** — clean. The tRPC client is typed off the router, so a missing registration shows up here, not at runtime.
- [ ] **Step 3: Commit.**

---

### Task 4: `resolveLanding`, pure

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/landing-target.ts`
- Create: `apps/desktop/test/landing-target.test.ts` (**node** project)

**Contract:**

```
resolveLanding(
  settings: Pick<ResolvedVaultSettings, 'landing' | 'dailyNotes'>,
  vault: { docPaths: ReadonlySet<string>; appIds: ReadonlySet<string> },
): LandingTarget | null
```

Returns the target to actually open, **with rot already collapsed**, or `null` for "land on nothing".

| in | out |
|---|---|
| `{kind:'daily'}`, `dailyNotes: true` | `{kind:'daily'}` |
| `{kind:'daily'}`, `dailyNotes: false` | `null` |
| `{kind:'note', path}`, path in `docPaths` | unchanged |
| `{kind:'note', path}`, path **absent** | fall back — re-resolve as `{kind:'daily'}`, so `dailyNotes: false` yields `null` |
| `{kind:'app', appId}`, id absent | same fall back |
| `board`/`agenda`/`mail` | unchanged; never rots |

**Why pure and why here:** same split as `lib/tab-overflow.ts` and `lib/tab-drop.ts` — "the arithmetic lives here, takes numbers, and is checked on numbers". jsdom computes no layout and this needs no DOM; every rot fallback becomes a one-line assertion instead of an atom test with a mocked tRPC.

**Gotcha:** the fallback is *re-resolution*, not a hardcoded `{kind:'daily'}`. A rotted note in a vault with `dailyNotes: false` must land on nothing, not on a daily the vault said it didn't want. Write that test first — it is the one a naive implementation gets wrong.

- [ ] **Step 1: Write the failing tests** — the six table rows plus the gotcha row, plus an empty vault (no docs, no apps).
- [ ] **Step 2: Run and watch fail.** `cd apps/desktop && pnpm exec vitest run --project node landing-target`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Green**, same command.
- [ ] **Step 5: Mutation-check** — make the fallback return a literal `{kind:'daily'}` and confirm the gotcha test fails. Revert.
- [ ] **Step 6: Commit.**

---

### Task 5: The dispatch, and the policy leaving `daily.ts`

**Files:**
- Create: `apps/desktop/src/renderer/src/state/landing.ts`, `apps/desktop/test/landing.test.ts`
- Modify: `apps/desktop/src/renderer/src/state/daily.ts`, `apps/desktop/src/renderer/src/components/Shell.tsx:219-227`

**Contract:** `openLandingAtom` — a write-only atom, `async (get, set) => Promise<void>`:

1. `activeRemoteAtom`; bail if null.
2. `trpc.settings.read.query({ remote })`.
3. `resolveLanding(settings, { docPaths, appIds })` — `docPaths` from `get(snapshotAtom).docs`, `appIds` from `get(appIdsAtom)` (`state/apps.ts:55`).
4. Dispatch: `daily` → `set(openTodaysDailyAtom)` · `note` → `openPinned` · `app` → `openApp` · singleton → `openSingleton`. `null` → return, leaving `emptyWorkspace()`.

**Changes to `daily.ts`:**

- **`openTodaysDailyAtom` becomes unconditional** — mint today's daily and land on it, full stop. The `isPersonalVault` guard comes out. This is what makes ⌘⇧D still work with daily notes off; the policy now lives in `landing.ts`.
- **`sweepDailyAtom` gates on `dailyNotes`** instead of `isPersonalVault` (read via `trpc.settings.read`).
- **Delete `isPersonalVault` entirely.** Grep first — if nothing else imports it, delete the export and its doc comment. This removes a `github.collaborators` round-trip from cold start. The **router procedure stays**: `features/vault/VaultSettings.tsx:152` still uses it for the member list.
- Update `daily.ts`'s module docstring — it currently says the layer "decides *whether* to ask (personal vaults only)". That is no longer true.

**Changes to `Shell.tsx`:** the effect becomes `openVault → openLanding → sweepDaily`. Keep it one effect, once per remote, deliberately sequential — the ordering comment at `:210-218` explains why (daily runs *after* open so it wins the race for the active doc) and that reasoning holds for landing. Amend the comment; do not delete it.

**Gotcha:** ⌘⇧D at `Shell.tsx:230-239` keeps calling `openTodaysDailyAtom` directly and stays ungated. Do not route it through `openLandingAtom`.

**Second gotcha — one read, not two.** `openLandingAtom` and `sweepDailyAtom` both need `dailyNotes`, and the `Shell` effect runs them back to back. Two `settings.read` calls per launch is one more file read than the old code made, which undercuts the round-trip this slice is supposed to remove. Cache the resolved settings in an atom that the effect populates once, or have the sweep take `dailyNotes` as an argument. Do not leave both calling `trpc.settings.read` independently.

- [ ] **Step 1: Write the failing atom tests** (node project, mocked `trpc`) — each kind dispatches to the right opener; `null` leaves the workspace empty; a rotted note lands on the daily. Follow the existing tRPC-mocking pattern; grep `apps/desktop/test/` for a test that already mocks `trpc.` and copy it.
- [ ] **Step 2: Run and watch fail.**
- [ ] **Step 3: Implement `landing.ts`.**
- [ ] **Step 4: Move the policy out of `daily.ts`, delete `isPersonalVault`, gate the sweep.**
- [ ] **Step 5: Wire `Shell.tsx`.**
- [ ] **Step 6: Full gates.** node suite, then dom suite, then `pnpm typecheck`, then `pnpm exec eslint src` (0 errors / 2 warnings). Existing daily tests will need edits — that is expected here, unlike task 2, because the atom's contract genuinely changed. Read each edit and make sure you are updating an expectation, not deleting a test.
- [ ] **Step 7: Commit.**

---

### Task 6: Verify slice 1 in the running app

**Read the `holi-ui-verification-ceiling` memory before driving the app.** Two traps live there: a CDP viewport override that outlives its session and paints the window white, and React state not being readable in the same `Runtime.evaluate`.

Main and shared changed, so **relaunch**: `pnpm dev:debug` (CDP on 9333).

- [ ] **Step 1: No file** → lands on today's daily. Unchanged behaviour, and the regression that matters most.
- [ ] **Step 2: `{"landing":{"kind":"board"}}`** in `.holi/settings.json` → board is the leftmost tab and is active.
- [ ] **Step 3: `{"landing":{"kind":"note","path":"<a real note>"}}`** → that note, pinned.
- [ ] **Step 4: `{"landing":{"kind":"note","path":"does-not-exist.md"}}`** → today's daily, no error dialog, no empty pane.
- [ ] **Step 5: `{"dailyNotes":false}`** with no `landing` → empty pane; **⌘⇧D still mints and opens today's note**; nothing is swept.
- [ ] **Step 6: A `.holi/settings.local.json` naming only `landing`** → it wins, and `hooks` from the committed file still apply (commit something and watch `normalize-md` run).
- [ ] **Step 7:** Do not write to Nicolai's vault. Use a scratch vault.

---

# Slice 2 — the onboarding settings act

What makes slice 1's keys discoverable.

---

### Task 7: The descriptor list, and the seed reads it

**Files:** Modify `packages/shared/src/vault-settings.ts`, `apps/desktop/src/main/agent/seed-content.ts`, `packages/shared/test/vault-settings.test.ts`

**Contract:** `VAULT_SETTING_DESCRIPTORS: readonly VaultSettingDescriptor[]`, each:

| field | meaning |
|---|---|
| `key` | the settings key |
| `label` | the row's heading |
| `explanation` | the sentence under it — **this is where the shared-vault warning lives** for `dailyNotes` |
| `control` | `'toggle'` (`dailyNotes`) · `'choice'` + options (`landing`, `colorScheme`) · `'group'` of toggles (`hooks` — three booleans that read as one decision, *what happens on commit*) |
| `default` | reads from `VAULT_SETTING_DEFAULTS`, never a second literal |
| `target` | `'committed'` \| `'local'` — which file the answer is written to |
| `whereToChange` | the sentence naming where this lives afterwards |

**Rows and their targets** (spec D-h):

| key | target | file |
|---|---|---|
| `dailyNotes` | `committed` | `.holi/settings.json` |
| `landing` | `committed` | `.holi/settings.json` |
| `hooks` | `committed` | `.holi/settings.json` |
| `colorScheme` | **`local`** | `.holi/settings.local.json` |

`colorScheme`'s descriptor lands here; its *behaviour* is slice 3. The act renders it from day one and the write works; nothing reads it yet.

**`landing`'s options on this step are `daily` / `board` / `agenda` / `mail` only** — a brand-new vault has no notes and no apps to point at. Pointing it at a note or an app stays a file edit.

**Seed changes:**
- `HOLI_SETTINGS` is **built from the descriptors** whose `target` is `'committed'`, not hand-written. Keep it a `JSON.stringify(..., null, 2) + '\n'` string so `ONCE_FILES` is unchanged in shape.
- Add `.holi/settings.local.json` to `ONCE_FILES` with the `'local'` descriptors' defaults. Precedent and the reason it is safe: `.holi/theme.local.json` is already seeded there (`seed-content.ts:326-329`) — the `.gitignore` is written first in `ensureSeeded`, so a `*.local.*` file is ignored before it lands.
- `.holi/settings.json` stays in **`ONCE_FILES`, not `MANAGED_FILES`** — created if absent, never touched again. Rewriting a user's settings on every launch is the opposite of the point.

**Gotcha:** the seeded `HOLI_SETTINGS` must still contain the `hooks` block D76 expects. If the descriptor list omits a transform, the seed silently stops declaring it. Assert the built JSON deep-equals today's literal.

- [ ] **Step 1: Write the failing tests** — every descriptor has a non-empty `whereToChange` and a valid `target`; every `key` exists in `VAULT_SETTING_DEFAULTS`; the seed JSON built from the `committed` descriptors deep-equals the current hand-written `HOLI_SETTINGS` object.
- [ ] **Step 2: Run and watch fail.**
- [ ] **Step 3: Implement the descriptors; rewrite the seed to build from them.**
- [ ] **Step 4: Green** — shared suite, then the node suite (seed tests live there).
- [ ] **Step 5: Commit.**

---

### Task 8: `writeVaultSettings` and `settings.write`

**Files:** Modify `apps/desktop/src/main/vault/settings.ts`, `apps/desktop/src/main/router.ts`

**Contract:**

```
writeVaultSettings(root, { committed?: Partial<...>, local?: Partial<...> }): Promise<void>
```

**One merge-then-atomic-rename per file, not per key.** The act answers four things at once; three renames would be three chances to half-write a vault. Copy the merge from `main/reminders/delivered-log.ts:44-61` — read, spread, write to `.tmp`, `renameSync` — so sibling keys (`hooks`, `maxCommittedFileBytes`, `reminders`) survive. `mkdirSync(dirname, {recursive:true})` first.

**Router — the `fields()` constraint.** `fields()` (`router.ts:247-264`) accepts only `string` and `boolean`; there is no object kind. So:

```
settings.write: fields({ remote: 'string', committedJson: 'string?', localJson: 'string?' })
```

Main `JSON.parse`s each and runs it through the **same validator the read uses** before merging. This is a feature, not a workaround: a write cannot bypass the trust boundary, and an invalid value from the renderer is dropped exactly as an invalid value from a teammate's file would be. Do **not** widen `fields()` to take objects — that helper is used by every procedure in the file.

- [ ] **Step 1: Write failing tests** (node) — a write of one key leaves siblings intact; a write to `committed` does not touch `local`; an invalid value is dropped rather than written; a `.tmp` file never survives a successful write.
- [ ] **Step 2: Run and watch fail.**
- [ ] **Step 3: Implement both halves.**
- [ ] **Step 4: Green** + `pnpm typecheck`.
- [ ] **Step 5: Commit.**

---

### Task 9: The reducer's fourth act

**Files:** Modify `apps/desktop/src/renderer/src/state/onboarding-flow.ts`, `apps/desktop/test/onboarding-flow.test.ts`

**Contract:** `Act = 1 | 2 | 3 | 4`. Act 3 is **the settings act**; the threshold moves to act 4.

- `initialState` gains `settings: Record<string, unknown>` seeded from `VAULT_SETTING_DEFAULTS` — so a user who clicks straight through gets exactly the seeded defaults and the write is a no-op in effect.
- New action `{ type: 'setSetting'; key: string; value: unknown }`.
- `reduce`'s `'created'` case still lands on act 3 — which is now the settings act, not the threshold. **Its comment says "advance to the threshold, which can truthfully say so" — that comment is now wrong. Update it.**
- `canAdvance`: act 3 is always advanceable (every row has a default). Act 4 remains `false` — the floor of "there is nowhere further".
- `startingAct` and `atFloor` are unchanged; `add-vault` still starts at 2.

**Gotcha:** the reducer is pure and already well tested. Read `apps/desktop/test/onboarding-flow.test.ts` before editing and check whether any existing test asserts `act === 3` *meaning the threshold*. Those assertions are now about act 4.

- [ ] **Step 1: Write the failing tests** — `'created'` lands on 3; advancing from 3 reaches 4; `canAdvance` is true at 3 and false at 4; `setSetting` records a value and leaves the others alone; `back` from 3 returns to 2; `add-vault` still starts at 2.
- [ ] **Step 2: Run and watch fail.** `cd apps/desktop && pnpm exec vitest run --project node onboarding-flow`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Green**, and fix any existing assertion that meant "the threshold".
- [ ] **Step 5: Commit.**

---

### Task 10: The act's view

**Files:**
- Create: `apps/desktop/src/renderer/src/features/onboarding/VaultSettingsAct.tsx` and a `__tests__` sibling (**dom**)
- Modify: `apps/desktop/src/renderer/src/features/onboarding/OnboardingRitual.tsx`

**Contract:** renders **one row per descriptor**, in list order, from `VAULT_SETTING_DESCRIPTORS`. It reads the list; it does not enumerate keys itself. Adding a row later must be adding a descriptor and nothing else — that property is the point of the task, so assert it (task 11, step 1).

Each row: `label`, `explanation`, the control for its `control` kind, and `whereToChange` as quiet trailing text.

**`OnboardingRitual.tsx` changes:**
- A **fourth dot**. The dots are three hardcoded `<span className="obrit-dot">` + `<span className="obrit-rule">` pairs at `:261-267`. Add a fourth pair; `dotState(4)` already works from the reducer's act.
- A new `<section className="obrit-act" data-state={actState(3)}>` for the settings act, and the existing threshold section's `actState(3)` becomes `actState(4)`.
- The `s.act === 3` guards at `:135`, `:214` and the `enter()` call site mean *the threshold* — they become `4`. **Grep for `act === 3` and read each hit**; some are about "the last act" and some about "act three", and they are no longer the same thing.

**Style:** the ritual has its own self-contained dark token set (`onboarding-ritual.css:7-9`) and does **not** use the app's theme tokens. Match the existing acts — reuse `obrit-*` classes and the `Button variant="ceremony"` / `CEREMONY_GHOST` pair. Do not import app-theme colours into it.

**Lint:** `eslint-boundaries` runs at **error** tree-wide. `features/` may import `@/primitives` and `@/composites`; it may not import another feature. Keep the new component inside `features/onboarding/`.

- [ ] **Step 1: Write the failing dom test** — one row per descriptor (assert against `VAULT_SETTING_DESCRIPTORS.length`, not a hardcoded 4); each row shows its `whereToChange`; changing a control fires `setSetting` with the right key.
- [ ] **Step 2: Run and watch fail.** `cd apps/desktop && pnpm exec vitest run --project dom VaultSettingsAct`
- [ ] **Step 3: Implement the component.**
- [ ] **Step 4: Wire it into the ritual** — fourth dot, new section, the `act === 3` sweep.
- [ ] **Step 5: Green** — dom suite (**544+**), then `pnpm exec eslint src` (0 errors / 2 warnings), then `pnpm typecheck`.
- [ ] **Step 6: Prettier the two files you wrote.** Not the ones you edited.
- [ ] **Step 7: Commit.**

---

### Task 11: Write the answers, and verify the ritual

**Files:** Modify `apps/desktop/src/renderer/src/features/onboarding/OnboardingRitual.tsx`

**Contract:** advancing from the settings act calls `trpc.settings.write` once, splitting the answers by each descriptor's `target` into `committedJson` / `localJson`. One call, two files.

**Ordering gotcha:** the vault already exists by act 3 — `submit()` at `:153-160` created it and the seed has already written both settings files with the defaults. So this write **merges over** a seeded file; it does not create one. That is why task 8's merge semantics matter.

**Failure behaviour:** a failed write must **not** block the ritual. The vault is real and its seeded defaults are valid; land the user on the threshold anyway. Follow `failInPlace`'s reasoning — a submit failure stays where it happened rather than navigating away — but here the honest ending is "the vault exists, your preferences didn't stick", so surface it and continue rather than trapping them on a settings step.

- [ ] **Step 1: Assert the extensibility property** — a dom or node test that adds a fake descriptor to the list and shows both the view and the write pick it up with no other change. This is the one property that makes task 10's design worth its cost; if it cannot be tested, the split-by-`target` logic is enumerating keys somewhere.
- [ ] **Step 2: Implement the write.**
- [ ] **Step 3: Green** — dom + node.
- [ ] **Step 4: Relaunch** `pnpm dev:debug`. Main and shared changed.
- [ ] **Step 5: Run the ritual end to end in a scratch vault** — four dots, the settings act appears after creation and before the threshold, every row renders with its `whereToChange`.
- [ ] **Step 6: Click straight through with no changes** → `.holi/settings.json` equals the seed exactly, and `.holi/settings.local.json` holds `colorScheme: "system"`.
- [ ] **Step 7: Answer `dailyNotes: false` + `landing: board`** → relaunch → the vault opens on the board and mints no daily. Slice 1 and slice 2 meeting is the whole point of this verification.
- [ ] **Step 8: Confirm `git status` in the scratch vault** shows `settings.json` tracked and `settings.local.json` ignored.
- [ ] **Step 9: The join path does not ask** — adopt an existing repo and confirm the ritual goes naming → threshold with no settings act.
- [ ] **Step 10: Commit.**

---

# Slice 3 — `colorScheme`

Sized as its own slice because the switch does not exist. `state/theme.ts:24-29` says so: *"`data-theme` is unstamped today… When a light/dark toggle ships, this hook will need to re-run when the attribute flips."* The light **palette** is already authored (`index.css:100`, the full `[data-theme='light']` block), so the expensive half is done.

---

### Task 12: The mode atom and the stamp

**Files:**
- Create: `apps/desktop/src/renderer/src/state/color-scheme.ts`, `apps/desktop/test/color-scheme.test.ts`

**Contract:**

- `colorSchemeAtom` — the setting: `'dark' | 'light' | 'system'`, read from `settings.read` on vault change.
- `activeModeAtom` — the **resolved** mode, `'light' | 'dark'`. `system` consults `matchMedia('(prefers-color-scheme: dark)')`.
- The stamp: `'light'` → `document.documentElement.dataset.theme = 'light'`; `'dark'` → `'dark'`. **Stamp both explicitly.** `:root` carries the dark values today and unstamped happens to resolve dark, but relying on that makes the light case a special case and leaves `color-scheme:` (`index.css:23`) unset — which is what paints the native window background behind the app.
- **The `system` listener is required, not optional.** `matchMedia(...).addEventListener('change', …)`, removed on teardown. Without it the app follows the OS only at launch, which reads as a bug the first time someone flips their Mac to dark at sunset.

**Gotcha:** jsdom has no real `matchMedia`. Stub it in the test and assert the listener is both added *and removed* — a leaked listener across vault switches is the kind of thing that only shows up as a slow leak.

- [ ] **Step 1: Write the failing tests** — each setting resolves to the right mode; `system` follows the stub; a `change` event re-resolves; teardown removes the listener; the stamp is written for both modes.
- [ ] **Step 2: Run and watch fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Green.**
- [ ] **Step 5: Commit.**

---

### Task 13: `useVaultTheme` re-runs on a flip

**Files:** Modify `apps/desktop/src/renderer/src/state/theme.ts`

**Contract:** `activeMode()` (`:24-29`) stops reading the DOM and reads `activeModeAtom`; the mode joins `useVaultTheme`'s effect dependency list beside `[remote, snapshot]`. **Delete the stale comment** at `:24-28` — it describes a future that has now arrived, and leaving it will send the next reader looking for a toggle that already shipped.

**Why this is load-bearing:** a vault theme resolves to `{light, dark}` blocks and only one is ever applied to the root. A flip that does not re-apply leaves the *wrong* block's custom properties sitting on `documentElement` — the app switches its base palette and keeps the other mode's vault overrides. That is a worse-looking bug than not supporting light mode at all, and it is invisible in any vault with no theme file.

- [ ] **Step 1: Write the failing dom test** — a vault with **both** `light` and `dark` blocks; flip the mode; assert the applied custom properties are the new mode's values. Follow `ThemeApplicator`'s existing tests for the setup.
- [ ] **Step 2: Run and watch fail.**
- [ ] **Step 3: Implement; delete the stale comment.**
- [ ] **Step 4: Green** — dom, then node, then `pnpm typecheck`, then eslint.
- [ ] **Step 5: Commit.**

---

### Task 14: Verify slice 3 in the running app

Relaunch (`pnpm dev:debug`) — shared changed.

- [ ] **Step 1: `colorScheme: "light"`** in `.holi/settings.local.json` → the app is light, including **portalled surfaces** (open a dialog and a context menu; Radix portals to `document.body`, which is exactly why the stamp is on the root and not a wrapper).
- [ ] **Step 2: `"system"`** → flip macOS System Settings → Appearance while the app is running → it follows **without a relaunch**. This is the whole reason task 12 has a listener.
- [ ] **Step 3: A vault with a `theme.json` carrying both blocks** → flip modes → the vault's own colours follow, and no stale custom properties from the other mode are left on the root (check `document.documentElement.style` over CDP).
- [ ] **Step 4: Confirm `colorScheme` is in `settings.local.json` and gitignored** — and that a committed `colorScheme` in `settings.json` is overridden by it, which is the whole reason it is a `local` target.

---

### Task 15: Docs

**Files:** Modify `docs/decisions.md`, `docs/prd/daily-notes.md`, `docs/prd/notes-editor.md`, `docs/prd/vaults-sync.md`, `docs/upcoming.md`

**Next free decision number is D85** — `decisions.md`'s header names the highest spent number; check it again before allocating, since another session may have taken it.

- [ ] **Step 1: D85 row** — the landing target and the settings home. Cover: the layering chosen and the three rejected homes; `landing` naming the daily by **kind** so it survives the dashboard rebuild; one target not a list, and why (`openSingleton` inserts leftmost, `openApp` appends); `dailyNotes` replacing `isPersonalVault` and what that trades (a guess for a committed answer, minus a cold-start round-trip); the shared-vault collision becoming something the user is *told* rather than decided for them; per-person daily paths considered and deferred to the dashboard rebuild; the descriptor list as one source of truth for the act and the seed; `colorScheme` written `local` because a teammate's committed choice flipping your app is the failure the `.local` layer exists to prevent.
- [ ] **Step 2: `prd/daily-notes.md`** — FR-4 (what launch lands on) and the personal-vault gate, which is now the `dailyNotes` setting. **OQ#2 was "resolved" by the collaborator check; it is now resolved differently.** Say so rather than editing the old answer away.
- [ ] **Step 3: `prd/notes-editor.md` §Panes** — the landing target is what fills the first pane. Leave the tabs-persistence question open; it is a non-goal here (spec OQ-1) and `panes.ts:75-79`'s comment stays true.
- [ ] **Step 4: `prd/vaults-sync.md` FR-9** — `.holi/settings.json` now has a schema and a shared loader; *"data, never code"* is unchanged and is now enforced by a whitelist rather than by convention.
- [ ] **Step 5: `docs/upcoming.md`** — item 15 `[x]` with what shipped. **Never run `git add docs`** — the file is untracked and gitignored on purpose. Stage paths individually.
- [ ] **Step 6: Commit** the four tracked docs only.

---

## Definition of done

- [ ] All three suites green: shared **330+**, node **1653+**, dom **544+** — with no baseline test deleted.
- [ ] `pnpm typecheck` clean; `pnpm exec eslint src` 0 errors and **exactly 2** warnings.
- [ ] `isPersonalVault` is gone from the daily path; `github.collaborators` is still called by `VaultSettings.tsx` and nowhere on cold start.
- [ ] A rotted `landing` degrades to the daily — or to nothing when `dailyNotes` is false — and never to an error.
- [ ] The ritual has four acts, four dots, and the join path still has three.
- [ ] Adding a fifth setting is adding one descriptor, proven by a test.
- [ ] `settings.local.json` is gitignored in a freshly created vault, and holds `colorScheme`.
- [ ] Nicolai has approved the push. **Ask, every time.**
