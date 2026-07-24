# First-run Onboarding Ritual — Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After device-flow sign-in with zero vaults, take over full-screen with a 3-act ritual (greeting → naming → threshold) that creates a vault (a GitHub repo under a chosen owner/org) or joins one the user's been added to — replacing today's dead-end "no vaults" shell.

**Architecture:** A pure, unit-tested **flow reducer** (`onboarding-flow.ts`) drives a thin **`OnboardingRitual.tsx`** view ported from the old repo, wearing the old repo's self-contained CSS. It's wired at the **App** level (first-run gate) and the **Shell** "+" (add-vault mode), retiring `AddVault.tsx`. Create/join go through the existing `createVaultAtom`/`addVaultAtom`, which already open the vault and refresh the list.

**Tech stack:** React + Jotai + Vite (renderer), tRPC-over-IPC, Vitest (`node` env — no jsdom, so DOM is CDP-verified not unit-tested).

**Design source:** `docs/specs/2026-07-24-onboarding-ritual-design.md`.

**Port sources (copy, then apply deltas — do not hand-retype):**
- Component: `~/repos/holi/src/components/shared/OnboardingRitual.tsx` (410 lines)
- CSS: `~/repos/holi/src/styles/onboarding-ritual.css` (917 lines, fully self-contained: data-URI SVG noise, no external fonts/assets, all `.onboarding-ritual`-scoped)

**Baselines to hold:** desktop suite (currently **538 green**), typecheck **36 errors** (pre-existing agent/history; add none), `electron-vite build` succeeds.

---

## Contracts

### `renderer/src/state/onboarding-flow.ts` (new, pure)
```ts
export type Act = 1 | 2 | 3
export type View = 'form' | 'join'
export type Mode = 'first-run' | 'add-vault'

export interface OnboardingState {
  act: Act
  view: View          // 'join' overlays act 2 with the repo picker
  name: string        // as typed; the slug is derived
  owner: string       // github login or org
  error: string | null
  submitting: boolean
}

export const slugify: (s: string) => string          // lowercase, non-alnum → '-', collapse/trim '-'
export const startingAct: (mode: Mode) => Act         // 'first-run' → 1, 'add-vault' → 2
export const initialState: (mode: Mode, owner: string) => OnboardingState
export const canAdvance: (s: OnboardingState) => boolean   // act1 → true; act2 → slug non-empty; act3 → false
export const atFloor: (s: OnboardingState, mode: Mode) => boolean  // view 'form' && act === startingAct(mode)

export type Action =
  | { type: 'advance' } | { type: 'back'; mode: Mode }
  | { type: 'toJoin' } | { type: 'toForm' }
  | { type: 'setName'; name: string } | { type: 'setOwner'; owner: string }
  | { type: 'submitStart' } | { type: 'fail'; error: string }

export const reduce: (s: OnboardingState, a: Action) => OnboardingState
```

**Transition table (`reduce`):**
| action | effect |
|---|---|
| `advance` | `canAdvance` false → unchanged; act1→act2; act2→act3. Clears `error`. |
| `back` | `view==='join'` → `view='form'`; else `act = max(startingAct(mode), act-1)`. Clears `error`. |
| `toJoin` | `view='join'`, `error=null` (only meaningful at act2) |
| `toForm` | `view='form'` |
| `setName` | `name = action.name` |
| `setOwner` | `owner = action.owner` |
| `submitStart` | `submitting=true`, `error=null` |
| `fail` | `submitting=false`, `error=action.error`, `act=2`, `view='form'` (bounce to naming) |

### `renderer/src/components/OnboardingRitual.tsx` (new, ported)
```ts
export function OnboardingRitual(props: { mode: Mode; onDismiss?: () => void }): JSX.Element
```
- Owns `useReducer(reduce, initialState(mode, session?.login ?? ''))`.
- Reads `sessionAtom`, `vaultsAtom`; sets `createVaultAtom`, `addVaultAtom`.
- Fetches `trpc.github.orgs` (owner options) and, when the join view first opens, `trpc.github.repos`.
- **Create** (act 3 *Open vault*): `dispatch(submitStart)` → `createVaultAtom({ name: slugify(name), owner })`; on reject `dispatch(fail, message)`. Success unmounts via the App gate flip.
- **Join** (repo click): `addVaultAtom(remote)`; on reject `dispatch(fail)` (stays on picker showing the error).
- **Dismiss**: when `atFloor(state, mode)` and `onDismiss` present, `back` calls `onDismiss()` instead of moving.

---

## Gotchas (codebase-specific)

1. **`vaultsAtom` starts `[]`** — it cannot distinguish "loading" from "loaded empty". The first-run gate needs a **`vaultsLoadedAtom` boolean** (set true at the end of `loadVaultsAtom`) or it flashes the ritual for a frame on every launch. Task 4 adds it.
2. **`createVaultAtom` builds the remote as `` `${owner}/${name}` ``** and passes `name` straight to `vaults.create` as the repo name — so the ritual must pass the **slug** as `name` (spec: vault name = repo name). Passing the raw typed name would create `Q2 Planning` and then open `owner/Q2 Planning`, which won't match.
3. **Both `createVaultAtom` and `addVaultAtom` already** `set(activeRemoteAtom)` + `await loadVaultsAtom` — the ritual must **not** also open the vault; success just flips `vaults.length` and the gate re-renders `Shell`.
4. **Vitest is `node` env, no jsdom** — the component is **not** unit-testable here. Only `onboarding-flow.ts` gets a test; the rendered ritual is CDP-verified. Say which is which; never imply a test covers the DOM.
5. **No `lucide-react` / shadcn in the new app.** The old component imports `lucide-react` icons and a shadcn `Tooltip`. Replace with unicode (`✕`, `→`, `←`, `↳`) and a plain `title=` attribute — matches `AddVault.tsx`/`Shell.tsx`.
6. **CSS import works** (`main.tsx` already does `import './index.css'`) — the ported `.css` is imported at the top of `OnboardingRitual.tsx`.
7. **electron-vite does not typecheck and main edits don't hot-restart** — but this slice is renderer-only, which **does** hot-reload; still relaunch if the CDP window is stale ([[holi-ui-verification-ceiling]]).

---

## Task 1: The flow reducer (pure, TDD)

**Files:**
- Create: `apps/desktop/src/renderer/src/state/onboarding-flow.ts`
- Test: `apps/desktop/test/onboarding-flow.test.ts`

- [ ] **Step 1 — Write failing tests** for the pure surface. Cover:
```ts
import { describe, expect, it } from 'vitest'
import { slugify, startingAct, initialState, canAdvance, atFloor, reduce } from '../src/renderer/src/state/onboarding-flow'

describe('slugify', () => {
  it('lowercases, dashes non-alnum, collapses and trims', () => {
    expect(slugify('  Q2 Planning!! ')).toBe('q2-planning')
    expect(slugify('a--_--b')).toBe('a-b')
    expect(slugify('')).toBe('')
  })
})
describe('startingAct', () => {
  it('first-run starts at 1, add-vault at 2', () => {
    expect(startingAct('first-run')).toBe(1)
    expect(startingAct('add-vault')).toBe(2)
  })
})
describe('reduce', () => {
  const s0 = initialState('first-run', 'nthomsencph')
  it('advance walks 1→2→3 and stops', () => {
    const s1 = reduce(s0, { type: 'advance' })
    expect(s1.act).toBe(2)
    // act2 cannot advance without a slug
    expect(reduce(s1, { type: 'advance' }).act).toBe(2)
    const named = reduce(s1, { type: 'setName', name: 'notes' })
    expect(reduce(named, { type: 'advance' }).act).toBe(3)
  })
  it('back floors at startingAct and toggles out of join first', () => {
    const atJoin = reduce(reduce(s0, { type: 'advance' }), { type: 'toJoin' })
    expect(reduce(atJoin, { type: 'back', mode: 'first-run' }).view).toBe('form')
    expect(reduce(s0, { type: 'back', mode: 'first-run' }).act).toBe(1) // already floor
    expect(reduce({ ...s0, act: 2 }, { type: 'back', mode: 'add-vault' }).act).toBe(2) // add-vault floor
  })
  it('fail bounces to the naming act with the message', () => {
    const failed = reduce({ ...s0, act: 3, submitting: true }, { type: 'fail', error: 'nope' })
    expect(failed).toMatchObject({ act: 2, view: 'form', submitting: false, error: 'nope' })
  })
  it('atFloor is true only on the form at the starting act', () => {
    expect(atFloor(initialState('add-vault', 'x'), 'add-vault')).toBe(true)
    expect(atFloor({ ...initialState('add-vault', 'x'), view: 'join' }, 'add-vault')).toBe(false)
  })
})
```
- [ ] **Step 2 — Run, watch fail.** `cd apps/desktop && pnpm exec vitest run onboarding-flow` → FAIL (module missing).
- [ ] **Step 3 — Implement** `onboarding-flow.ts` per the Contracts transition table. `slugify` = `s.trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'')`. `canAdvance`: act1 true, act2 `slugify(name).length>0`, act3 false. `back`: join→form else clamp act down to `startingAct(mode)`.
- [ ] **Step 4 — Run, watch pass.** `pnpm exec vitest run onboarding-flow` → PASS.
- [ ] **Step 5 — Commit.**
```bash
git add apps/desktop/src/renderer/src/state/onboarding-flow.ts apps/desktop/test/onboarding-flow.test.ts
git commit -m "feat(onboarding): pure flow reducer for the vault ritual"
```

---

## Task 2: Port the CSS

**Files:**
- Create: `apps/desktop/src/renderer/src/styles/onboarding-ritual.css`

- [ ] **Step 1 — Copy the file verbatim.**
```bash
mkdir -p apps/desktop/src/renderer/src/styles
cp ~/repos/holi/src/styles/onboarding-ritual.css apps/desktop/src/renderer/src/styles/onboarding-ritual.css
```
- [ ] **Step 2 — Sanity-check it's self-contained.**
Run: `grep -nE "@import|url\((?!\"data:)|font-face" apps/desktop/src/renderer/src/styles/onboarding-ritual.css`
Expected: no matches (the only `url(...)` are inline `data:image/svg+xml` noise). If anything else matches, inline or drop it.
- [ ] **Step 3 — Commit.**
```bash
git add apps/desktop/src/renderer/src/styles/onboarding-ritual.css
git commit -m "feat(onboarding): port the ritual stylesheet (self-contained)"
```

---

## Task 3: The ritual component (ported + rewired)

**Files:**
- Create: `apps/desktop/src/renderer/src/components/OnboardingRitual.tsx`

Port `~/repos/holi/src/components/shared/OnboardingRitual.tsx` and apply these deltas. Keep its JSX/act structure, dots, crossfade classes, keyboard handling, and `is-waking` continue-button touch; replace its data layer.

- [ ] **Step 1 — Copy the old file** to the new path as a starting point.
```bash
cp ~/repos/holi/src/components/shared/OnboardingRitual.tsx apps/desktop/src/renderer/src/components/OnboardingRitual.tsx
```
- [ ] **Step 2 — Swap imports** (delta):
  - Remove `lucide-react` and `@/components/ui/tooltip` imports; use unicode glyphs (`→ ← ✕ ↳`) and `title=` (gotcha 5).
  - Remove `@/lib/api`, `systemDepsAtom`, `formatHoliError`, `@/styles/...` path aliases.
  - Add: `import { useReducer, useEffect, useRef, useState } from 'react'`; `import { useAtomValue, useSetAtom } from 'jotai'`; `import type { Repo } from '../../../main/github/api'`; `import { trpc } from '../lib/trpc'`; `import { sessionAtom } from '../state/session'`; `import { vaultsAtom, createVaultAtom, addVaultAtom } from '../state/vaults'`; `import { reduce, initialState, slugify, canAdvance, atFloor, type Mode } from '../state/onboarding-flow'`; `import '../styles/onboarding-ritual.css'`.
- [ ] **Step 3 — Replace local `useState` flow with the reducer.** `const [s, dispatch] = useReducer(reduce, undefined, () => initialState(mode, session?.login ?? ''))`. Map the old `step`/`name`/`gitRemote`/`error`/`submitting` reads onto `s.act`/`s.name`/`s.owner`/`s.error`/`s.submitting`; the old `exitingStep` crossfade may stay as local `useState` (pure visual).
- [ ] **Step 4 — Rework Act 2** (delta): the old "GitHub remote · optional" field is **deleted**. Add the **owner picker** — a `<select>` over `[session.login, ...orgs]` bound to `s.owner` (`dispatch({type:'setOwner', owner})`), styled with the ritual classes. Caption reads `github.com/{s.owner}/{slugify(s.name) || '…'} · private`. Add the join link: a button `↳ join one you've been added to` → `dispatch({type:'toJoin'})`. Fetch orgs on mount: `useEffect(() => { void trpc.github.orgs.query().then(l => setOrgs(l.map(o=>o.login))).catch(()=>{}) }, [])`.
- [ ] **Step 5 — Add the Join sub-view** rendered when `s.view === 'join'` (overlays the act-2 stage): a search `<input>` + a list from `trpc.github.repos` (fetch once when the join view first opens), filtered to `r.canPush && !alreadyAdded.has(r.remote)` and `r.remote.includes(search)`, `.slice(0, 40)`. `alreadyAdded = new Set(useAtomValue(vaultsAtom).map(v => v.remote))`. Row click → `run(() => addVault(repo.remote))`. Non-pushable rows disabled with `title="you cannot push to this repo"`. A `← back` button → `dispatch({type:'toForm'})`. (This is the logic lifted from `AddVault.tsx` lines 36–102.)
- [ ] **Step 6 — Rework Act 3** (delta): display `Welcome to {slugify(s.name)}.`; sub `Created under {s.owner} · your team can clone it now.`; delete the old daily-note preview card and the `todayLabel`/`nowLabel` helpers. *Open vault* button → the submit handler below.
- [ ] **Step 7 — The submit + join handlers.** A shared runner:
```ts
const createVault = useSetAtom(createVaultAtom)
const addVault = useSetAtom(addVaultAtom)
const submit = async () => {
  if (s.submitting) return
  dispatch({ type: 'submitStart' })
  try { await createVault({ name: slugify(s.name), owner: s.owner }) }
  catch (err) { dispatch({ type: 'fail', error: err instanceof Error ? err.message : String(err) }) }
}
const run = (fn: () => Promise<unknown>) =>
  fn().catch((err: unknown) => dispatch({ type: 'fail', error: err instanceof Error ? err.message : String(err) }))
```
  (No success handling needed — the App gate unmounts on `vaults.length` change, gotcha 3.)
- [ ] **Step 8 — Rework `back`/dismiss + keyboard.** `back()` = `atFloor(s, mode) && onDismiss ? onDismiss() : dispatch({type:'back', mode})`. Keep the old keyboard effect but retarget: space/enter advance (enter at act3 → `submit`), Esc → `back`, and inside inputs enter advances when `canAdvance`. Guard against advancing past act2 unless `canAdvance(s)`.
- [ ] **Step 9 — Typecheck just this file's area.**
Run: `cd apps/desktop && pnpm exec tsc --noEmit 2>&1 | grep -E "OnboardingRitual|onboarding-flow"`
Expected: empty (no errors). (Whole-project count is still 36 until Task 4 removes AddVault; that's fine.)
- [ ] **Step 10 — Commit.**
```bash
git add apps/desktop/src/renderer/src/components/OnboardingRitual.tsx
git commit -m "feat(onboarding): the 3-act vault ritual component (create + join)"
```

---

## Task 4: Wire in — App gate, Shell add-mode, retire AddVault

**Files:**
- Modify: `apps/desktop/src/renderer/src/state/vaults.ts` (add `vaultsLoadedAtom`)
- Modify: `apps/desktop/src/renderer/src/App.tsx`
- Modify: `apps/desktop/src/renderer/src/components/Shell.tsx`
- Delete: `apps/desktop/src/renderer/src/components/AddVault.tsx`

- [ ] **Step 1 — Add `vaultsLoadedAtom`.** In `vaults.ts`, after `vaultsAtom`:
```ts
/** False until the first `loadVaults` resolves, so the App gate can tell an
 *  empty list (first run) apart from a not-yet-loaded one. */
export const vaultsLoadedAtom = atom(false)
```
And set it at the end of `loadVaultsAtom`'s body: `set(vaultsLoadedAtom, true)`.
- [ ] **Step 2 — Lift `loadVaults` to `App.tsx` and add the gate.** Replace `App.tsx` body:
```tsx
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect } from 'react'
import { SignIn } from './components/SignIn'
import { Shell } from './components/Shell'
import { OnboardingRitual } from './components/OnboardingRitual'
import { loadSessionAtom, sessionAtom } from './state/session'
import { loadVaultsAtom, vaultsAtom, vaultsLoadedAtom } from './state/vaults'

export function App() {
  const session = useAtomValue(sessionAtom)
  const vaults = useAtomValue(vaultsAtom)
  const vaultsLoaded = useAtomValue(vaultsLoadedAtom)
  const loadSession = useSetAtom(loadSessionAtom)
  const loadVaults = useSetAtom(loadVaultsAtom)

  useEffect(() => { void loadSession() }, [loadSession])
  useEffect(() => { if (session) void loadVaults() }, [session, loadVaults])

  if (session === undefined) return null            // loading keychain
  if (session === null) return <SignIn />
  if (!vaultsLoaded) return null                    // loading vault list
  if (vaults.length === 0) return <OnboardingRitual mode="first-run" />
  return <Shell />
}
```
- [ ] **Step 3 — Shell: drop the initial load, swap the "+".** In `Shell.tsx`: remove the `loadVaults` `useSetAtom`/`useEffect` (lines ~54, ~66–67 — App owns it now; keep the `loadVaultsAtom` import only if used elsewhere, else drop). Replace the AddVault usage:
  - Remove `import { AddVault } from './AddVault'`; add `import { OnboardingRitual } from './OnboardingRitual'`.
  - Change `{showAdd && <AddVault onClose={() => setShowAdd(false)} />}` to `{showAdd && <OnboardingRitual mode="add-vault" onDismiss={() => setShowAdd(false)} />}`.
  (`onAddVault={() => setShowAdd(true)}` on `VaultPicker` stays.)
- [ ] **Step 4 — Delete `AddVault.tsx`.**
```bash
git rm apps/desktop/src/renderer/src/components/AddVault.tsx
```
- [ ] **Step 5 — Grep for stragglers.**
Run: `grep -rn "AddVault" apps/desktop/src`
Expected: no matches.
- [ ] **Step 6 — Typecheck: back to the 36 baseline.**
Run: `cd apps/desktop && pnpm exec tsc --noEmit 2>&1 | grep -c error`
Expected: **36**.
- [ ] **Step 7 — Full suite green.**
Run: `pnpm exec vitest run` → the 538 baseline **plus** the new `onboarding-flow` tests, all green.
- [ ] **Step 8 — Commit.**
```bash
git add apps/desktop/src/renderer/src/App.tsx apps/desktop/src/renderer/src/components/Shell.tsx apps/desktop/src/renderer/src/state/vaults.ts
git commit -m "feat(onboarding): gate first-run on zero vaults; retire AddVault popover"
```

---

## Task 5: Build + live CDP verification

- [ ] **Step 1 — Build.** `cd apps/desktop && pnpm exec electron-vite build` → succeeds.
- [ ] **Step 2 — Launch clean, signed in, zero vaults.** The registry is already cleared this session (`vaults.json` backed up). If a vault exists, move `~/Library/Application Support/@holi/desktop/vaults.json` aside. Relaunch:
```bash
cd apps/desktop && HOLI_VAULT_ROOT=/tmp/holi-onboard nohup pnpm exec electron-vite dev -- --remote-debugging-port=9333 > /tmp/holi-dev.log 2>&1 &
```
  (Use a throwaway `HOLI_VAULT_ROOT` so a real repo isn't cloned into `~/Holi` during the check; the create path still hits real GitHub.)
- [ ] **Step 3 — Verify first-run gate + acts (CDP, `/tmp/holi-drive.mjs`).** With zero vaults, assert the ritual is up (`document.querySelector('.onboarding-ritual')` present, footer/Shell absent). Drive Act 1→2→3: Begin, type a name, confirm the owner `<select>` lists orgs, confirm the caption shows `github.com/<owner>/<slug>`, reach the threshold. State this is CDP-verified, not unit-tested.
- [ ] **Step 4 — Verify create round-trip.** On Act 3 *Open vault*, confirm the ritual unmounts and the `Shell` appears on the new vault (footer shows `owner/slug`), and `git -C <clone> log` / the GitHub repo exists. (Creates a real repo — pick a throwaway name under a personal account for the check.)
- [ ] **Step 5 — Verify join + add-vault mode.** Relaunch with the created vault present: (a) the app boots straight to `Shell` (gate false); (b) the "+" opens the ritual in add-vault mode starting at Act 2, dismissible with Esc/×; (c) the join link lists your pushable repos and adopting one lands in it.
- [ ] **Step 6 — Teardown + report.** `pkill -f "better-holi-final/node_modules/.pnpm/electron@"`. Report the suite count, typecheck (36), build, and each CDP observation — marking DOM checks as CDP-verified.
- [ ] **Step 7 — Delete the scratch spec + plan** (consolidate-then-purge; the design is captured by the code + this being done). Fold any lasting decision into the relevant PRD if one applies (onboarding has no PRD today — if it warrants a line, add it to `prd/auth-identity.md` §onboarding or note it's UI-only). Then:
```bash
git rm docs/plans/2026-07-24-onboarding-ritual.md docs/specs/2026-07-24-onboarding-ritual-design.md
git commit -m "docs(onboarding): remove executed plan and design spec"
```

---

## Self-review

- **Spec coverage:** trigger/gate (T4), 3 acts + owner picker (T3 S4/S6), join sub-view (T3 S5), add-vault mode + retire AddVault (T4), no deps gate (nothing added), vault-name=slug (gotcha 2, T3 S7), loadVaults→App (T4 S2), reducer + CSS port (T1/T2), testing split (T1 unit, T5 CDP). All mapped.
- **Placeholder scan:** none — every step names files, code, and expected output.
- **Type consistency:** `Mode`/`Act`/`View`/`OnboardingState`/`Action` and the atom names (`vaultsLoadedAtom`, `createVaultAtom`, `addVaultAtom`) are used identically across tasks; `createVault({name: slugify(...), owner})` matches `createVaultAtom`'s `{name, owner}` signature.
- **Open (non-blocking):** Task 5's real-GitHub create should use a throwaway repo name; the design's CSS-scope note (global but `obrit-`-prefixed) is accepted for v1.
