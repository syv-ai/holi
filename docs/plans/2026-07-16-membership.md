# Membership — the door into the collaboration engine

> **For agentic workers:** use the executing-plans skill. Steps are checkboxes. This plan is **lean by design** — it states contracts, decisions and gotchas. Derive the code.

**Goal:** an owner can invite a teammate to a shared vault, change their role, remove them; a member can leave; an owner can hand the vault on. At the end of this slice Holi is a collaborative app for the first time — today it is a single-user app with a fully-built collaboration engine behind a door that has no handle.

**The state of play:** `membership.list/invite/setRole/remove/leave/transferOwnership` are **all built and tested**, and **no client code calls any of them**. Everything *after* the invite already works end to end: `invite` mints a `pending:` stub user for someone who has never signed in, claimed on their first Google sign-in (`auth.test.ts:29`); `onAuthenticate` gives members read-write and rejects non-members; two members in a doc get character-level merge with live cursors. You simply cannot get a second person in. `vaults.create({kind:'shared'})` is wired to the `+` button, so today you can make a shared vault that will forever have exactly one member.

**Spec:** `prd/auth-identity.md` FR-9..FR-14 + §Flows (owning doc) · `prd/vaults-collaboration.md` §Shared vault.

---

## Decisions

| # | Decision |
|---|---|
| **D49** | **A personal vault is blocked from membership mutations by a *type*, not a habit: `sharedVaultProcedure` + a branded `SharedVaultId`.** **The bug:** `invite` and `transferOwnership` had **no vault-kind guard** — you could invite a stranger into your personal vault, or hand it away entirely. auth-identity FR-14 forbids both, and it is not cosmetic: daily-notes **D44/D45** rest on "a personal vault has exactly one owner, therefore exactly one clock", and a second member makes "today" ambiguous — the precise problem personal-only scoping exists to sidestep. (`setRole`/`remove` were saved incidentally by `assertNotLastOwner`; `leave` by its owner check — which reports "owner must transfer ownership first", implying you *could* leave your personal vault if you transferred it. Blocked by accident, and lying about why.) **Why a brand and not an `if`:** a runtime check in each op is a guard you can forget to write, and this one was forgotten twice. The membership service takes `SharedVaultId`, which **only** `sharedVaultProcedure` can produce, so a membership mutation that skips the kind check does not compile. The hard block is the middleware; the type is what stops the next one being added without it. Agreed with Nicolai 2026-07-16. |

## Contract

**Server — the guard (`apps/server/src/trpc.ts`):**
- `export type SharedVaultId = string & { readonly __sharedVault: unique symbol }` — a brand. Nothing constructs one except the middleware below.
- **`sharedVaultProcedure`** = `vaultProcedure` + kind check → `BAD_REQUEST` on a personal vault, and re-injects `vaultId` **as `SharedVaultId`**.
- **`sharedOwnerProcedure`** = `ownerProcedure` + the *same* middleware (compose it; do not re-implement the owner check).
- The kind lookup is one `select kind from vaults` — `vaultProcedure` already resolved membership, so this is a second read on a hot path, and correctness beats the round-trip. Do not cache it.

**Server — the service (`apps/server/src/membership/service.ts`), the point of the brand:**
- `invite`, `setRole`, `remove`, `leave`, `transferOwnership` move out of the router and take `{ vaultId: SharedVaultId, … }`. Logic ports as-is — it is already correct; only its *reachability* changes. This mirrors `tasks/mutations.ts` (D35): one place a membership changes.
- **`list` stays on `vaultProcedure`** and is **not** shared-only: reading your personal vault's single membership row is harmless, and FR-14 only disables invite/leave/transfer.
- **`invite` gains the FR-10 domain restriction**, reusing **`config.google.workspaceDomain`** — the same knob sign-in already enforces via `assertWorkspace`, so the two cannot disagree about who is allowed in. **Unset ⇒ no restriction**, exactly as `assertWorkspace` behaves; hardcoding `@syv.ai` would break every dev environment, where the var is unset by design.
- `leave`'s personal-vault rejection becomes explicit rather than a side-effect of the owner check.

**Desktop (`state/members.ts` + a Members section in `VaultSettings.tsx`):**
- Atoms next to `state/git.ts`'s shape: `membersAtom`, `loadMembersAtom`, and write-atoms per op. `VaultSettings` already has the `guard()` busy/error wrapper — reuse it, don't invent a second.
- **The section renders only for a shared vault** — the client mirror of D49. Derive kind from `vaultsAtom` + `activeVaultIdAtom` (as `state/daily.ts` does; there is still no `activeVaultAtom`).
- Rows: name/email + role. Owner sees a role control and remove per row; everyone sees "Leave vault"; owner sees "Transfer ownership…". **Non-owners get a read-only list** — the server rejects them anyway (`ownerProcedure`), and offering a control that always 403s is worse than not offering it.
- Invite: email + role (**default `member`**, FR-10) → `invite` → refetch. A pending invitee (never signed in) must render as **pending**, not as a mysterious blank name — `list` returns their stub row with a null `name`.
- Destructive actions (remove, leave, transfer) confirm first. Transfer is one-way and demotes you.

## Tasks

- [x] **1** `trpc.ts`: `SharedVaultId`, `sharedVaultProcedure`, `sharedOwnerProcedure`. Commit alone — it is the guard everything else leans on.
- [x] **2** `membership/service.ts` + the router rewritten over it + the invite domain check. TDD in a new `apps/server/test/membership.test.ts` (`vaults.test.ts` currently owns the one invite test; leave it). Test **every** mutation rejects a personal vault; invite rejects an off-domain email **and allows anything when the domain is unset**; the existing last-owner and stub-user behaviours still hold.
- [x] **3** Desktop: `state/members.ts` + the Members section. Headless-test whatever is pure (the shared-vault predicate, pending-invitee labelling).
- [x] **4** `pnpm -r test` + `pnpm -r typecheck` + desktop build. Then the **real app**: invite a second user to a shared vault by email, confirm they appear as pending; sign in as them (a second dev user) and confirm the vault appears in their list with read-write; open the same doc from both and watch cursors. **The last one is the whole slice** — it is the first time two humans have ever been in a Holi vault together.
- [x] **5** `prd/auth-identity.md`: note the domain restriction now lands where sign-in's does. Record D49 in `docs/decisions.md` (next free is D49 → after this, **D50**). **Never `git add` anything under `docs/`.**

## Gotchas

- **`invite` is `ownerProcedure` today and must become `sharedOwnerProcedure`** — the whole reason this plan exists. Same for `transferOwnership`.
- **Don't hardcode `@syv.ai`.** `config.google.workspaceDomain` is unset in dev (`assertWorkspace` no-ops), and a hardcoded domain would make every local invite fail while looking correct in review.
- **The invite stub user is load-bearing, not a hack** — `googleSub: 'pending:<email>'` is claimed on first sign-in by email match (`upsertGoogleUser`). Don't "clean it up" into a separate invites table; `auth.test.ts:29` pins the claim.
- **`assertNotLastOwner` is not the personal-vault guard**, it only looks like one. It blocks removing/demoting the last owner in *any* vault, which is a different rule that must survive independently.
- **A shared vault with one member is legitimate** (you made it, nobody has accepted yet) — the panel must not treat it as broken.
- **`vaults.create` hardcodes `kind:'shared'`** client-side (`state/vaults.ts:33`), and the server's `create` only accepts `shared` — personal vaults are server-provisioned. So every vault in the switcher except the auto-provisioned personal one is shareable.
