# PRD — Onboarding

> **Built and live.** The three-act ritual, both modes, and the join path all ship. Written down late: this pillar was designed in a dated spec (2026-07-24), built, and then owned by no PRD for three weeks — so a reader working out what Holi does from the living docs could not have discovered that first-run onboarding exists at all.

## Summary
A signed-in user with **no vaults** has nothing to do and nowhere to go. Onboarding is the surface that turns that dead end into a vault: a full-screen, three-act ritual that walks the user to either **create** a vault (a new private GitHub repo under their account or an org) or **join** one a teammate has already added them to.

Sign-in itself is not here — that is device flow ([`auth-identity.md`](auth-identity.md)). Onboarding starts the moment a session exists and the vault list comes back empty.

## Why a ritual and not a form
The obvious build is a dialog with a name field. It was rejected, and the reason is worth keeping because it is a product decision rather than a taste one:

**The first vault is the moment the product explains itself.** Holi's whole model — *your notes are a git repo your team owns, and the agent lives inside it* — is unusual enough that a user's first thirty seconds decide whether they understand what they just installed. A cramped popover names a repo. Three acts (greeting → naming → threshold) say what a vault *is* before asking for one.

It is also the cheapest place to put that explanation: it is the only screen every user sees exactly once, and it competes with nothing.

## Goals — as built
- **One component, two modes.** `mode="first-run"` plays all three acts. `mode="add-vault"` starts at act 2, is dismissible, and opens from the vault switcher's **+**. This **retired `AddVault.tsx`** rather than sitting beside it — two ways to acquire a vault is two things to keep in agreement, and the popover was the worse of them.
- **Create-led, join as a first-class second route.** A quiet link on act 2 ("*↳ join one you've been added to*") swaps the naming stage for a repo picker. Joining skips act 3 and lands straight in the vault: there is nothing to celebrate creating.
- **A team vault is an org-owned repo, and the owner picker is the lever.** Act 2 lists the signed-in login plus every org from `github.orgs`, defaulting to the personal account. There is no "team vault" concept beyond who owns the repo — which is the whole of D60 restated at the point a user first meets it.
- **The vault name *is* the repo name.** The typed name is slugified once (`Q2 Planning` → `q2-planning`) and that slug is what is submitted *and* what is displayed everywhere afterwards. **No separate display name**, deliberately: the rest of the app names a vault by `repoName(remote)`, so a prettier typed name would diverge from the switcher the moment onboarding ended.
- **The flow is a pure reducer.** `state/onboarding-flow.ts` holds `{ act, view, name, owner, error, submitting }` and every transition; `features/onboarding/OnboardingRitual.tsx` is a thin view over it. That split is what makes the flow testable without a DOM, and it is why the act transitions and slug gating have unit tests (`test/onboarding-flow.test.ts`) while the choreography does not.
- **Keyboard throughout.** `space`/`enter` advances, `enter` submits, `Esc` walks backward and ultimately dismisses — in add-vault mode only, because first-run has nothing to dismiss *to*.
- **The gate lives in `App.tsx`**, not in the shell: `session === undefined` → loading, `null` → sign-in, then `vaults.length === 0` → the ritual, else the shell. The initial `loadVaults()` lifts to `App` for exactly this reason — the gate cannot decide before the list arrives.
- **Success needs no "open vault" call.** `createVaultAtom`/`addVaultAtom` already set the active remote and refresh the vault list, so `vaults.length` becomes 1, the gate flips, and the shell renders the open vault. One state change, not a handoff.

## Non-goals
- **Inviting anyone.** Holi implements no invitations, and this is where a user first feels that: you join a repo you have *already* been given push access to on GitHub. Collaboration is GitHub's membership model ([`auth-identity.md`](auth-identity.md)), and onboarding does not paper over it.
- **A system-dependency check.** Every user is a developer and git is assumed. A missing-git clone failure surfaces as an inline error that bounces back to act 2 — not a separate screen diagnosing the machine.
- **Teaching the product.** No tour, no checklist, no sample content. The ritual gets you a vault; a personal vault then opens today's daily note ([`daily-notes.md`](daily-notes.md)), which is a better first screen than any tour.
- **Being reachable again.** There is no "replay onboarding". Once a vault exists, the only remaining path is add-vault mode.

## Edge cases & risks
- **A repo you cannot push to becomes a vault that silently fails to sync.** The join picker filters to `canPush` and shows non-pushable repos disabled *with the reason*, rather than hiding them — a repo the user can see on GitHub and cannot find here reads as a bug in Holi.
- **Repos that are already vaults** are excluded from the picker; adopting one twice is not a state worth having.
- **`github.orgs` failing is non-fatal** — the picker still offers the personal account. **`github.repos` failing** shows an inline "couldn't load your repos" and leaves create working. Neither is allowed to block the only screen the user can act on.
- **A create that fails** bounces to act 2 with the error's own message inline. No error-code discrimination: the prose GitHub returns is more useful than anything a mapping would produce.
- **Adopting a repo that is not a vault** seeds nothing and produces an empty tree. The picker's filter is by push access, not by vault-ness — see Open questions.
- **The ported CSS is global** (`onboarding-ritual.css`, `.obrit-*`-prefixed). Collision risk is low and it was not converted to modules; it is the one place in the renderer that is not Tailwind.

## Open questions
- **Should the join picker distinguish a vault from any other repo?** It filters on push access alone, so a code repo can be adopted and will open as a vault with no `.holi/`. Cheap to detect (probe for `.holi/` via the API before offering it); unclear whether it is worth a request per repo, or whether the honest answer is to let it happen and let the vault seed itself.

## Dependencies
[`auth-identity.md`](auth-identity.md) — the device-flow session, `github.orgs`/`github.repos`, and the access model onboarding surfaces. [`vaults-sync.md`](vaults-sync.md) — `createVaultAtom`/`addVaultAtom`, the clone, and what a vault is. [`daily-notes.md`](daily-notes.md) — what a personal vault opens onto once the ritual ends.
