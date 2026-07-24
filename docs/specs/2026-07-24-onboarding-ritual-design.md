# Design — First-run onboarding ritual

**Status:** agreed with Nicolai 2026-07-24.

**One-liner:** After device-flow sign-in with zero vaults, Holi takes over full-screen with a cinematic 3-act ritual that guides the user to **create** a vault (a GitHub repo under their account or an org) or **join** one they've been added to — replacing today's dead-end "blank vault view, no vaults" state.

**Reference:** ported and adapted from the old repo's `~/repos/holi/src/components/shared/OnboardingRitual.tsx` (+ `onboarding-ritual.css`), reshaped for the D60 model where **the vault *is* the GitHub repo** (no optional-remote, no local-only vault).

---

## Why

Authentication is built; onboarding is not. A signed-in user with no vaults lands on the empty `Shell` — "no vaults" in the dropdown and no guidance to create or join one. `AddVault.tsx` exists but only opens from a "+" the user has to find, and it's a cramped utility popover, not a welcome. The old app solved this with a designed first-run *moment*; this ports that feel onto the new model.

**The model changed, so it is not a verbatim port:**
- Old: a vault was a local folder; the GitHub remote was *optional* (backup/sync). New: the vault **is** the repo — required, identity = remote.
- Old gated the remote field on the `gh` CLI. New uses the device-flow session already in hand — no `gh`.
- Old Act 2 **only created**. New has a first-class **join** path (adopt a repo a teammate shared on GitHub — Holi implements no invitations).
- **"Team vault" = an org-owned repo.** The owner/org picker is the team-vs-personal lever and belongs front-and-center.

---

## Decisions (agreed)

1. **Treatment: the cinematic 3-act ritual** (greeting → naming → threshold), full-screen, ported polish. Not a lean single-screen.
2. **Create-led**, with **join** as a secondary route (a link on Act 2 → repo picker).
3. **Both personal and org owners**; the org picker is prominent. A team vault is just choosing an org as owner.
4. **One component, two modes.** `mode="first-run"` plays all three acts; `mode="add-vault"` starts at Act 2, is dismissible, and is reached from the Shell "+". This **retires `AddVault.tsx`**.
5. **No system-deps gate.** Device-flow already handled auth; git is assumed (every user is a developer). A missing-git clone failure surfaces as an inline error that bounces back — no separate screen.
6. **The post-open landing is unchanged.** `Shell.tsx` already auto-opens today's daily note for a personal vault and no-ops for a shared one, so Act 3 stays a uniform "Welcome to \<name>" and the vault opens correctly for either type.

---

## Trigger & placement

- **First-run gate — `App.tsx`.** Currently: `session === undefined → null; session === null → <SignIn/>; else <Shell/>`. The initial `loadVaults()` lifts to `App` (Resolved decision 1). Add a branch: once the session is present, gate on the vault list — while it's still loading show a brief "loading" state; when loaded and `vaults.length === 0`, render `<OnboardingRitual mode="first-run" />`; otherwise `<Shell/>`.
- **Add-vault mode — `Shell.tsx`.** The "+" that today toggles `<AddVault>` instead renders `<OnboardingRitual mode="add-vault" onDismiss={() => setShowAdd(false)} />`.
- **Success path.** `createVaultAtom`/`addVaultAtom` already `set(activeRemoteAtom, remote)`, refresh `snapshotAtom`, and `await loadVaultsAtom`. So on success in first-run mode, `vaults.length` becomes 1 → the gate flips false → `Shell` renders the now-open vault. The ritual needs no "open" call of its own.

---

## The three acts (create path)

**Act 1 · Greeting** (first-run only; `add-vault` starts at Act 2)
- Eyebrow "HOLI", display "Hold your thinking.", refreshed lede: *"A vault your team owns, on GitHub — notes, tasks, and an agent that lives in it."* (drops the old "mail, calendar" line — phase-2).
- *Begin →* button; `space` advances.

**Act 2 · Naming**
- One large vault-name input (auto-focused on entering the act), `maxLength` ~40, slugified live.
- **Owner picker** (prominent): a control listing the signed-in `session.login` plus orgs from `trpc.github.orgs`. Default = `session.login`.
- Live caption: `github.com/<owner>/<slug>` + "· private".
- Quiet link: **"↳ join one you've been added to"** → switches to the Join sub-view.
- `continue` / `enter` advances to Act 3 when the slug is non-empty. Back/`Esc` → Act 1 (first-run) or dismiss (add-vault).

**Act 3 · Threshold**
- Eyebrow "YOUR VAULT IS READY", display "Welcome to \<slug>." (the repo name — see Naming decision), sub: *"Created under \<owner> · your team can clone it now."*
- *Open vault →* → `createVaultAtom({ name: slug, owner })`. While pending: spinner + "Creating". On rejection: capture `err` message, bounce to Act 2, show inline error.
- (The old daily-note preview card is dropped — the real landing is handled by `Shell`.)

**Naming: the vault name *is* the repo name.** The typed name is slugified once (`Q2 Planning` → `q2-planning`) and that slug is what's submitted as the repo name **and** what's shown everywhere the vault is named — Act 3's welcome, the caption, and the vault switcher. There is no separate "display name": the rest of the app already names a vault by its repo name (`repoName(remote)`), so keeping a prettier typed name would diverge from the switcher the moment onboarding ends. One name, and it matches the remote.

## Join sub-view (from Act 2)

- Replaces the Act 2 stage with a searchable list from `trpc.github.repos`, filtered to `canPush` and excluding remotes already in `vaultsAtom`; a search input filters by `remote`.
- Clicking a repo → `addVaultAtom(remote)` → lands directly in the vault (skips Act 3).
- A "← back" affordance returns to the Act 2 create form.
- Non-pushable repos are shown disabled with a reason (a repo you can't push to becomes a vault that silently fails to sync).

---

## Components & files

**New**
- `renderer/src/components/OnboardingRitual.tsx` — the view. Props: `{ mode: 'first-run' | 'add-vault'; onDismiss?: () => void }`. Uses `sessionAtom`, `vaultsAtom`, `createVaultAtom`, `addVaultAtom`, and `trpc.github.repos|orgs` directly (as `AddVault` does today). Holds flow state via the reducer below.
- `renderer/src/state/onboarding-flow.ts` — a **pure reducer** for the flow: state `{ act: 1|2|3; view: 'form'|'join'; name; owner; error; submitting }` and transitions (`advance`, `back`, `toJoin`, `toForm`, `setName`, `setOwner`, `fail`, slug validation, `startingAct(mode)`). Pure and unit-tested; the component is a thin shell over it.
- `renderer/src/styles/onboarding-ritual.css` — ported near-verbatim from the old repo (917 lines of self-contained `.obrit-*` / `.onboarding-ritual` visual polish: vignette/ember/grain, crossfades, dots). Imported by the component (Vite supports `.css` imports; `main.tsx` already imports `index.css`).

**Edited**
- `App.tsx` — lift the initial `loadVaults()` here, add the first-run gate.
- `Shell.tsx` — drop the initial `loadVaults()` trigger (now App's job); keep reacting to `vaultsAtom`.
- `Shell.tsx` — swap the "+" from `<AddVault>` to `<OnboardingRitual mode="add-vault" …>`; drop the `AddVault` import.

**Deleted**
- `renderer/src/components/AddVault.tsx` — its create/join logic is now the ritual's Act 2 + Join sub-view.

## Dropped dependencies

The old ritual imported `lucide-react` icons and shadcn `Tooltip`. The new app uses plain unicode (`✕`, `▾`) and Tailwind only. The port uses unicode/inline arrows and no tooltip — no new deps.

## Keyboard choreography (ported)

- Act 1: `space` or `enter` → advance.
- Act 2: `enter` (with a valid slug) → Act 3; `Esc` → back/dismiss. Inside inputs, `enter` still advances.
- Act 3: `enter` → submit (create).
- Global `Esc` walks backward and ultimately dismisses (add-vault mode only).

---

## Error handling

- **Create/join failure** → the error's message shown inline (Act 2 for create, on the picker for join). The renderer now has `err.data.code` available (the tRPC-over-IPC fix), but message prose is sufficient here — no code discrimination needed for v1.
- **`github.orgs` failure** → non-fatal; the picker still offers the personal account (matches `AddVault`'s existing `.catch(() => {})`).
- **`github.repos` failure (join view)** → an inline "couldn't load your repos" message; create still works.
- **Empty/invalid name** → *continue*/*Open vault* disabled until the slug is non-empty.

---

## Testing

Vitest runs in the **`node` environment — no jsdom**, so rendered React/DOM is not unit-testable here (the codebase's established constraint).

- **Unit-tested** (`test/onboarding-flow.test.ts`): the pure reducer — `startingAct` per mode, `advance`/`back` transitions, slug validation gating advancement, `toJoin`/`toForm`, `fail` bouncing to Act 2, and slugify edge cases.
- **CDP-verified** in the running app (stated as such, never implied to be a unit test): first-run gate appears with zero vaults; Act 1→2→3 by keyboard and click; owner picker lists orgs; create round-trips and lands in the open vault; the join link → repo picker → adopt round-trips; add-vault mode from "+" skips the greeting and is dismissible.

---

## Resolved decisions

1. **`vaultsAtom` loads at the App level.** The first-run gate needs the vault list before it can decide, so the initial `loadVaults()` lifts from `Shell` to `App` (which already lifts `loadSession`). A brief "loading vaults" state — mirroring the keychain `session === undefined` state — covers the gap before the gate resolves. `Shell` no longer triggers the initial load (it still reacts to `vaultsAtom`).
2. **The vault name is the repo name (the slug).** One name, slugified once, submitted as the repo name and shown everywhere — see the Naming decision under Act 3.

## Open questions (non-blocking)

- **CSS scope.** The ported 917-line file is global. Its classes are all `obrit-`/`onboarding-ritual`-prefixed, so collision risk is low; no CSS-module conversion for v1.
