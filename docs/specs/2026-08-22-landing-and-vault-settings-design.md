# The landing target, and the vault settings that surround it

**Date** 2026-08-22 · **Worklist** item 15 · **Status** designed, not built

Item 15 asks for one thing — *"allow for customizing the landing note, so users can point it at
whatever — including an app or even boards, agenda or email"* — and it was blocked on *"a decision
on where settings live first"*. This spec answers that, and the answer turned out to be bigger than
one key: a vault has settings that nothing ever asks about, and the moment a vault is created is
where a user would expect to be asked.

Three slices, one story:

1. **The landing target.** A resolved-from-disk `landing` key, and the dispatch that lands on it.
2. **The onboarding settings act.** A fourth act in the ritual, rendered from a declared list of
   vault settings, that writes the answers into the vault at birth.
3. **`colorScheme`.** Dark / light / system — the switch the codebase has been predicting.

---

## What happens today

`components/Shell.tsx:219-227` runs one effect, once per remote, deliberately sequential:
`openVault(remote)` → `openDaily()` → `sweepDaily()`. It is the only caller of `vaults.open`, so
cold start and an explicit vault switch both come through here.

`state/daily.ts` decides what "land" means. `openTodaysDailyAtom` **bails if the vault is shared** —
`isPersonalVault` asks GitHub for the collaborator list and returns `false` only on a positive
`>1`; offline or signed out counts as personal. `sweepDailyAtom` carries the same gate.

So a **personal** vault lands on `DD-MM-YYYY.md`, and a **shared** vault lands on **nothing** — an
empty pane, `active: -1`. Nothing auto-opens a board, agenda, app or mail; those come from the nav
rail only. ⌘⇧D (`Shell.tsx:230-239`) re-runs the same jump.

Which *vault* opens is separate and already settled: `vaults[0]`, with the registry sorting
most-recently-opened first (`main/vault/registry.ts:55-61`). This spec does not touch that.

---

## Decisions

### D-a. The landing target is vault-owned, with a per-key `.local` override

`landing` lives in the committed `.holi/settings.json`, overridable per key by the gitignored
`.holi/settings.local.json` — the D64/D82 layering that theme and icons already use.

Everyone who clones a shared vault lands on the same thing (a team's board, say) unless they
override it locally. It is agent-authorable, it is portable, and it gives a shared vault a landing
for the first time.

Rejected: machine-only (a shared vault would still land on nothing for anyone who had not set one);
persisting the workspace instead (a bigger change, and it answers a different question — see
Non-goals); `userData/settings.json` (invisible to the agent, unportable).

### D-b. `landing` names the daily by kind, not by path

`{"kind":"note","path":"22-08-2026.md"}` rots overnight. So the landing vocabulary carries one kind
beyond the tab union:

```json
{ "landing": { "kind": "daily" } }
```

| value | lands on |
|---|---|
| `{"kind":"daily"}` | today's daily note — **the default when `landing` is unset** |
| `{"kind":"note","path":"…"}` | that note, pinned |
| `{"kind":"app","appId":"…"}` | that vault app |
| `{"kind":"board"}` / `{"kind":"agenda"}` / `{"kind":"mail"}` | the singleton surface |

The daily note is being rebuilt into a customisable dashboard (email, agenda, todos, apps as
iframes, and still a note). Naming it by kind means the landing target keeps pointing at it through
that rebuild for free.

### D-c. One target, not a list

`landing` is a single value. A list would need to answer where each tab lands in the strip, and it
cannot: `openSingleton` inserts **leftmost**, `openApp` and `openPinned` **append**. A list whose
order the strip contradicts is worse than no list. Widening later is additive — the parser gains an
array branch — so this is deferred, not foreclosed.

### D-d. `dailyNotes` is a setting, and it replaces `isPersonalVault`

A vault says whether it wants a daily note. `dailyNotes: false` means:

- nothing is minted at launch and nothing is swept/archived automatically;
- **⌘⇧D still creates today's note on demand**, and the explorer still marks today's row when the
  file exists.

Off means *"stop doing this behind my back"*, not *"the feature is gone"*. Flipping the key back on
resumes the sweep where it left off.

**`isPersonalVault` leaves the daily path entirely.** The collaborator count was a guess standing in
for a question nobody had asked; now the question is asked, at onboarding (D-f), and the answer is
committed. This deletes a `github.collaborators` round-trip from cold start. The router procedure
stays — `features/vault/VaultSettings.tsx` still shows the member list.

The harm the guess guarded against is real and is not being ignored: in a shared vault, two people
both write `DD-MM-YYYY.md`, the same file. That is now a thing the user is *told* about at the
moment they choose, rather than a thing decided for them by a network call. Per-person daily paths
(`daily/<login>/…`) were considered and deferred to the dashboard rebuild, where a personal surface
wants a personal path anyway.

### D-e. The policy leaves `openTodaysDailyAtom`

`openTodaysDailyAtom` becomes unconditional: *mint today's daily and land on it*. The `dailyNotes`
gate moves out, into the landing dispatch and into `sweepDailyAtom`.

This is what makes ⌘⇧D work with daily notes off, and it leaves the atom doing one thing. `landing`
owns the policy; `daily` owns the mechanism.

The mechanism splits in two: **`ensureTodaysDailyAtom`** mints and says where the file is, and
`openTodaysDailyAtom` is that plus the landing. Landing calls the first (whenever `dailyNotes`), and
only *lands* on the daily when that is the target — see §The dispatch. Keeping them fused is the bug
this spec shipped once and had to fix in the running app.

### D-f. Onboarding gains a settings act

The ritual (`features/onboarding/OnboardingRitual.tsx`, driven by the pure reducer in
`state/onboarding-flow.ts`) is per-vault: `first-run` plays greeting → naming → threshold,
`add-vault` skips the greeting. A fourth act sits **between naming and threshold**, after the repo
exists and before the celebratory beat.

It is a **vault settings** act, not a daily-notes question — it will grow. See D-g.

**The join path does not ask.** An adopted repo's `settings.json` already speaks, or the defaults
do. Overwriting a teammate's committed answer because you happened to clone their vault would be
the same failure as the guess this replaces.

### D-g. The act renders from a descriptor list, and the seed reads the same list

One exported list of vault-setting descriptors:

```
{ key, label, explanation, control, default, target, whereToChange }
```

- `control` — the shape of the choice: a **toggle** (`dailyNotes`), a **choice** of named options
  (`landing`, `colorScheme`), or a **group** of toggles under one heading (`hooks`, which is three
  booleans and reads as one decision: *what happens on commit*).
- `target` — `'committed'` or `'local'`; which of the two files the answer is written to (D-h).
- `whereToChange` — the sentence telling the user where this lives afterwards
  (`.holi/settings.json`, `.holi/theme.json`, the vault settings panel). Carried as **data**, so a
  row structurally cannot ship without one.

`main/agent/seed-content.ts` builds `HOLI_SETTINGS` from this list instead of the hand-written
literal it has today. One source of truth for *what a vault's settings are and what they default
to*; adding a setting later is adding a row, not restructuring an act.

### D-h. Four rows, two files

| row | key | written to | why |
|---|---|---|---|
| A daily note, each day | `dailyNotes` | `.holi/settings.json` | a statement about the vault |
| What this vault opens on | `landing` | `.holi/settings.json` | a statement about the vault |
| What happens on commit | `hooks` | `.holi/settings.json` | D76; a statement about the vault |
| Appearance | `colorScheme` | `.holi/settings.local.json` | a statement about **you on this machine** |

A teammate's committed choice flipping your app to light mode is exactly the failure the `.local`
layer exists to prevent, so `colorScheme` is written local. Same loader, same per-key override,
different write target — which is why `target` is a field on the descriptor rather than a rule in
the writer.

`.holi/settings.local.json` is already gitignored by the seeded `*.local.*` rule, and
`.holi/theme.local.json` is already seeded as a gitignored skeleton
(`seed-content.ts:326-329`) — so seeding a second machine-local file follows an existing precedent
rather than inventing one.

**`landing` on the step offers only `daily` / `board` / `agenda` / `mail`.** A brand-new vault has
no notes and no apps to point at. Pointing it at a note or an app stays a file edit — which is where
authoring belongs (`holi-users-are-developers`).

### D-i. `colorScheme` is a slice, because the switch does not exist

`state/theme.ts:24-29` says so directly:

> *"`data-theme` is unstamped today — the app is dark-first, so `:root` (dark) wins. Default to dark
> accordingly. When a light/dark toggle ships, this hook will need to re-run when the attribute
> flips (a MutationObserver, or a mode atom in its dep list)."*

The light **palette** is already authored (`index.css:100`, the full `[data-theme='light']`
override), so the expensive half is done. What is missing:

- a `colorScheme: 'dark' | 'light' | 'system'` setting, resolved by the same loader;
- something that stamps `data-theme` on `document.documentElement` from it;
- `system` → `matchMedia('(prefers-color-scheme: dark)')`, **with its change listener**, so the app
  follows the OS while it is running rather than only at launch;
- `useVaultTheme` re-running when the mode flips — a mode atom in its dependency list, as the
  comment predicts. A vault theme resolves to `{light, dark}` blocks and only one is applied; a flip
  that does not re-apply leaves the wrong block on the root.

### D-j. One loader, and the two existing readers fold into it

`.holi/settings.json` has **no schema and no shared loader** today. Two independent hand-rolled
readers parse it:

- `main/vault/vault-settings.ts` — `maxCommittedFileBytes`, for the large-file gate;
- `main/vault/hooks/transforms.ts` — the `hooks` block, for the pre-commit transforms.

Adding a third would make four. So: a pure `resolveVaultSettings(committed, local)` in
`packages/shared/src/vault-settings.ts`, beside `theme.ts` and `icon-map.ts`, parsing the **whole**
file to one typed shape — `hooks`, `maxCommittedFileBytes`, `landing`, `colorScheme`, `dailyNotes`.

Both existing readers call it and **keep their exact signatures** (`readMaxCommittedFileBytes`,
`readHookSettings`), so the commit path and the large-file gate do not change behaviour and their
existing tests are the regression guard.

This is the only refactor in this spec, and it is here solely because the alternative is a fourth
parser in a file with no schema.

### D-k. Validation is a trust boundary, and rot degrades

The committed `settings.json` is written by whoever wrote the vault — including a teammate. Parsing
follows `lib/tab-drop.ts`'s `parseTabPayload` exactly: every field checked, **a fresh narrow object
built per kind**, `null` on anything else. Returning the parsed value would let whatever else was in
that JSON ride into the workspace.

Nothing here ever throws. A missing file, corrupt JSON, an unknown `kind`, a wrong type — each
resolves to the default, the way `resolveTheme` and every existing reader already do.

A landing target that has **rotted** — a note that was deleted, an app that is gone in a shared
vault someone else edited — falls back to `daily`, not to an error. Same trade D82 accepted for
icons: rot degrades to the ordinary thing.

---

## Non-goals

- **Persisting the workspace across restarts.** `state/panes.ts:75-79` flags it as an open product
  question and names `.holi/settings.local.json` as where the answer would go. It stays open. This
  spec does not persist tabs, and a landing target is what a vault opens on **every** time, not just
  the first.
- **A UI for `landing` beyond the four choices a new vault can express.** Authoring stays files.
- **Named theme presets.** `colorScheme` is dark/light/system only; picking a vault palette at
  creation would need a set of named presets that do not exist.
- **Per-person daily paths.** Deferred to the dashboard rebuild (D-d).
- **A settings surface in `VaultSettings.tsx`.** It is read-only on purpose. Displaying the resolved
  values there is a reasonable follow-up; editing them is not.

---

## Architecture

```
packages/shared/src/vault-settings.ts        pure: parse → merge → validate → defaults
  resolveVaultSettings(committed, local) → VaultSettings
  VAULT_SETTING_DESCRIPTORS                 the declared list (D-g)

apps/desktop/src/main/vault/settings.ts      the disk half (mirrors main/vault/theme.ts)
  readVaultSettings(root)                    reads both files, never throws
  writeVaultSettings(root, {committed, local})
                                             ONE merge-then-atomic-rename per file, not per key —
                                             the act answers several at once, and three renames
                                             would be three chances to half-write a vault.
                                             Merge semantics copied from reminders/delivered-log.ts
                                             so sibling keys (hooks, maxCommittedFileBytes) survive.

apps/desktop/src/main/vault/vault-settings.ts     ─┐ call the shared resolver;
apps/desktop/src/main/vault/hooks/transforms.ts   ─┘ signatures unchanged (D-j)

apps/desktop/src/main/agent/seed-content.ts  HOLI_SETTINGS built from the descriptors (D-g)

router.ts   settings.read  → query, mirroring theme.read
            settings.write → mutation, used by the onboarding act only

apps/desktop/src/renderer/src/lib/landing-target.ts     pure: takes the resolved settings and what
  resolveLanding(settings, {docPaths, appIds})          the vault actually holds, returns the target
                                                        to open — with rot already collapsed to
                                                        `daily`, or to nothing. No atoms, no trpc.
apps/desktop/src/renderer/src/state/landing.ts
  openLandingAtom            read settings → resolveLanding → one dispatch call
apps/desktop/src/renderer/src/state/daily.ts
  openTodaysDailyAtom        unconditional now (D-e); isPersonalVault deleted
  sweepDailyAtom             gated on dailyNotes
apps/desktop/src/renderer/src/state/onboarding-flow.ts
  Act = 1|2|3|4; the settings answers on the reducer state
```

### The dispatch

`Shell.tsx`'s effect becomes `openVault → openLanding → sweepDaily`.

**Minting is not landing.** Whenever `dailyNotes` is true the vault mints today's
daily and sweeps prior days — *whatever* `landing` says. `landing` decides only
what you are looking at. Folding the two together means a vault that opens on its
board quietly stops journalling, which is a hole in the record found weeks later.
The mint runs **before** the target is resolved, so a `landing` naming the daily
by path is live on the morning it is created rather than reading as rotted.

| resolved `landing.kind` | lands via | on rot |
|---|---|---|
| `daily` | lands on the file already minted above | — |
| `note` | `openPinned` | no doc at that path → fall back to `daily` |
| `app` | `openApp` | no such app → fall back to `daily` |
| `board` / `agenda` / `mail` | `openSingleton` | — |

`dailyNotes: false` with no `landing` resolves to landing on **nothing** — an empty pane, exactly
what a shared vault does today. That is coherent, and it is called out here because it is the one
configuration that looks broken and is not.

`landing` is resolved in the renderer, so the `LandingTarget` type lives in `packages/shared` and the
renderer maps it to a `Tab`. It is deliberately **not** the `Tab` union: `SingletonTab` is a named
literal rather than a derived one precisely so `openSingleton(w, 'app')` cannot typecheck
(`panes.ts:38-44`). Parse to `LandingTarget`, then dispatch per kind, and that property survives.

---

## Testing

| what | where | project |
|---|---|---|
| `resolveVaultSettings` — merge, per-key override, whitelist, hostile input | `packages/shared/test/vault-settings.test.ts` | shared |
| the descriptor list is complete (every row has a `whereToChange` and a `target`) | same | shared |
| `resolveLanding` — every kind, every rot fallback, `dailyNotes: false` | `apps/desktop/test/landing-target.test.ts` | **node** |
| `openLandingAtom` dispatches to the right opener | `apps/desktop/test/landing.test.ts` | **node** |
| the onboarding reducer's fourth act | `apps/desktop/test/onboarding-flow.test.ts` | **node** |
| the settings act renders one row per descriptor | `src/renderer/**/__tests__/*.test.tsx` | dom |
| `colorScheme` stamping + the `matchMedia` listener + re-apply on flip | node / dom | both |
| hooks + large-file behaviour after the reader swap | existing tests, unchanged | node |

Pure logic goes in `packages/shared/src/` or `src/renderer/src/lib/`; renderer lib logic is tested
from `apps/desktop/test/*.test.ts` in the **node** project, not co-located — only
`src/renderer/**/*.test.tsx` runs in `dom`.

---

## Slices

**1 — The landing target.** The shared loader (D-j, D-k), `landing` and `dailyNotes`, the disk half,
`settings.read`, `state/landing.ts`, the `Shell` effect, the policy moving out of
`openTodaysDailyAtom`, `isPersonalVault` deleted from the daily path. Closes item 15. Ships with no
UI: the keys are authored in the file, which is the stance.

**2 — The onboarding settings act.** The descriptor list, `seed-content.ts` reading it, the fourth
act and its reducer changes, `settings.write`, three rows (`dailyNotes`, `landing`, `hooks`). This
is what makes slice 1's keys discoverable.

**3 — `colorScheme`.** The setting, the `data-theme` stamp, the `system` listener, `useVaultTheme`
re-running on a flip, and the fourth row. Sized as its own slice because the switch does not exist
yet (D-i).

---

## Open questions

None blocking. Two worth revisiting later:

- **OQ-1.** Whether tabs survive a restart (`panes.ts:75-79`). Answering it yes would make `landing`
  fire only on a vault's first open. Deliberately left open.
- **OQ-2.** Whether `VaultSettings.tsx` should *display* the resolved settings read-only. Cheap, and
  it would make a `.local` override that shadows a committed value visible instead of mysterious.

---

## Documents this amends

- `prd/daily-notes.md` — FR-4 (what launch lands on) and the personal-vault gate, which becomes the
  `dailyNotes` setting.
- `prd/notes-editor.md` §Panes — the landing target is what fills the first pane.
- `prd/vaults-sync.md` FR-9 — `.holi/settings.json` gains a schema and a shared loader; the
  *"data, never code"* rule is unchanged and now enforced by a whitelist rather than by convention.
- `docs/decisions.md` — one new row for the landing target and the settings home.
