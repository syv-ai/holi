# PRD — Auth, Identity & Access Control

The identity spine of the rebuild. Everything else — per-user UI prefs (D6), vault membership (D7), role-gated agent ops (D10), offline caching (D13) — hangs off a real, server-verified user identity. The old Tauri app had **zero** auth; this is entirely new surface, so this PRD designs it rather than porting it.

Decisions: **D7** (Google Workspace SSO + membership/roles), **D6** (CC-native config layering; `per_user_state` = UI prefs only), **D13** (sign-in required, offline via cache), **D10** (role-gated MCP ops). Server-side schema is owned by [`server-data.md`](server-data.md); this PRD references those tables and defines behavior.

---

## Summary

Employees sign in with their **Syv Google Workspace** account. Identity **is** the Google account — no Syv-native passwords. The desktop app runs a standard OAuth **Authorization Code + PKCE** flow in the **system browser** with a **loopback redirect**, exchanges the code for a Syv-issued **session token** (not the raw Google tokens), and stores it in the **OS keychain**. Every subsequent tRPC call and every Yjs WebSocket connection carries that token and is authorized server-side against **vault membership + role** — exactly two roles, **owner** and **member**; there is no viewer / read-only tier (D7). The agent's MCP ops are gated by the **same** role at the same boundary, so the client can never self-escalate. First sign-in provisions the user's personal vault. A cached session permits **offline** work for **~30 days since last successful server contact**, then re-auth is required; sign-in is required at least once to use Holi (D7, D13).

Holi's auth is **only** the Syv/Google session. Claude Code is assumed **already installed and authenticated** on every machine with the employee's own account (D30) — Holi does no Claude provisioning, metering, or credential management; the two auth surfaces never touch.

---

## Goals / Non-goals

### Goals
- One-tap company SSO via Google Workspace; no separate Holi credentials (D7).
- Secure desktop OAuth: system-browser flow, tokens never exposed to the renderer, secrets in the OS keychain.
- A durable, server-owned **user record** keyed to Google identity; **first-login provisioning** of a personal vault (D13).
- **Membership + roles** on shared vaults — exactly two roles, **owner** and **member**, no viewer tier: invite by `@syv.ai` email, change role, remove, leave, transfer ownership; personal vault as the single-member degenerate case (D7).
- A **single authorization boundary** on the server that covers tRPC, Yjs connections, and agent MCP ops uniformly (D10).
- **Per-user scoping** (tier-2 server state = **UI prefs only**, D6) keyed to the user identity and invisible to other members. Personal agent config (`~/.claude`, `CLAUDE.local.md`, USER.md) is machine-local and never touches the server.
- **Offline** via cached session, valid **~30 days since last successful server contact** before re-auth (D7, D13).

### Non-goals
- Non-Google identity providers, multi-tenant / multi-domain support, external (non-`@syv.ai`) guests. Google-Workspace-only for v1.
- Syv-native accounts / password auth (explicitly rejected in D7).
- Fine-grained per-document ACLs *within* a vault — the access unit is the **vault** (v1). Per-folder/per-doc permissions are out of scope.
- SCIM / directory auto-provisioning, admin console, audit-log UI (post-v1).
- MDM/device trust, hardware-key enforcement.

---

## User stories

- As a new employee, I open Holi, click **Sign in with Google**, approve in my browser, and land in my ready-to-use **personal vault** — no setup. (The agent drawer just works because Claude Code is already installed and signed in with my own account, D30 — Holi never asks me to authenticate Claude.)
- As a vault **owner**, I invite a teammate by their `@syv.ai` email as a **member** (default) or **owner**, and they see the vault appear in their list with read-write access.
- As an **owner**, I promote a member to owner, demote a co-owner to member, or remove someone; the change takes effect immediately on their live sessions.
- As a **member**, I can read and edit every doc and the task board, watch presence, and run the assistant to read *and* write on my behalf.
- As a **member**, I can leave a shared vault I no longer work in.
- As an **owner** leaving the company's project, I **transfer ownership** to another member before leaving.
- As any user, my **UI prefs** follow me across my devices and stay **invisible** to everyone else in a shared vault (D6). My USER.md, personal skills, and chat history are **machine-local** — never on the server, so never visible to anyone (D6, D9).
- As any user, I keep working on a **flight** (offline) against my cached session and synced edits replay when I reconnect (D13, D21).
- As any user, I **sign out**; my session token and cached vault contents are purged from the machine.

---

## Functional requirements

### Sign-in
1. **FR-1** Provide a single **Sign in with Google** action. No email/password form.
2. **FR-2** Use OAuth 2.0 **Authorization Code + PKCE** in the **system browser** (not an embedded webview) with a **loopback** (`http://127.0.0.1:<ephemeral-port>`) redirect. (Rationale in [Security](#authorization-model).)
3. **FR-3** Restrict the flow to the Syv Google Workspace by setting the OAuth `hd` (hosted-domain) parameter **and** re-verifying `hd == syv.ai` server-side on the ID token. Reject any account outside the domain with a clear "Holi is Syv-only" error.
4. **FR-4** Request **minimal scopes** for v1 sign-in: `openid email profile`. Gmail/Calendar scopes (Phase 2) are requested **incrementally** only when those features are first used — not at sign-in.
5. **FR-5** The desktop app exchanges the code and receives a **Syv session token** from the server; the raw Google refresh/access tokens **never** reach the desktop app (see Flows).

### Identity & provisioning
6. **FR-6** On first successful sign-in, upsert a **user record** keyed by the Google account (`sub` claim as stable primary key; email as a mutable attribute), capturing display name and avatar URL.
7. **FR-7** On first-ever sign-in for a user, **provision a personal vault** owned solely by them (one membership row, role `owner`, `kind = personal`). Idempotent — re-runs never create a second personal vault.
8. **FR-8** Personal-vault provisioning seeds default config (daily-note scaffold per D17, empty AGENTS/MEMORY, tier-1 defaults). Provisioning is a server transaction; a partial failure leaves no half-vault.

### Membership & roles
9. **FR-9** Roles are exactly **owner** and **member** — no viewer / read-only tier (D7). `member` = read + write **all** content (notes, tasks); `owner` = member + vault administration (invite/remove members, transfer ownership, delete vault, edit theme/settings). Owner ⊇ member in capability. Every membership row is `(vaultId, userId, role)`.
10. **FR-10** **Invite** by `@syv.ai` email (owner only), picking role `member` | `owner` (default **member**). If the invitee already has a user record, the vault appears in their list immediately; if not, the invite is **pending** and resolves to a membership on their first sign-in (email match). Invites are non-transferable and domain-restricted.
11. **FR-11** **Change role** (member ↔ owner) and **remove member** are owner-only. A removal must take effect on the removed user's **live** sessions — their Yjs connection for the vault is closed on the change (see Flows / Authorization).
12. **FR-12** **Leave**: any non-owner member may remove their own membership. An **owner cannot leave** a shared vault with other members without transferring ownership first.
13. **FR-13** **Transfer ownership**: owner designates another **member** as new owner; the old owner atomically becomes a member. A shared vault always has **exactly one** owner.
14. **FR-14** A **personal vault** has exactly one membership (owner); invite/leave/transfer are disabled for it. Attempting to share a personal vault is out of scope for v1 (a future "promote to shared" path is an open question).

### Session & authorization
15. **FR-15** Every tRPC procedure and every Yjs (Hocuspocus) connection **must** resolve a valid session → user, then authorize against membership/role. Unauthenticated or unauthorized calls fail closed.
16. **FR-16** Members and owners get **read-write** Yjs (Hocuspocus) connections; a non-member's connection is **rejected**. There is no read-only connection tier — every user with vault access can edit (D7).
17. **FR-17** The agent's MCP ops are authorized against the **same** membership/role at the server, independent of any client-supplied mode (D10). No client input can raise the effective role.
18. **FR-18** **Sign-out** revokes the server session, deletes the keychain token, and purges the local working-copy cache + offline queue for all vaults on that machine.

### Offline
19. **FR-19** A previously signed-in user may launch and work **offline** using a cached session for up to the **offline grace window** of **~30 days since last successful server contact** (D7). A short-lived access token is refreshed silently while online, which re-anchors the window; beyond 30 days offline, Holi enters a locked state requiring reconnection and re-auth.
20. **FR-20** Offline edits queue locally (D21) and replay on reconnect; the sync-status indicator reflects offline/syncing/synced. Authorization is re-checked on reconnect — a role revoked while offline is enforced when the connection re-establishes, and any queued writes the user is no longer permitted are rejected server-side (surfaced as a sync notice, never silently applied).

---

## Data & types

Full schema is owned by [`server-data.md`](server-data.md); the shapes below are the contract this PRD depends on. Types live in `packages/shared`.

```ts
// Identity
type User = {
  id: string            // server-assigned uuid (internal PK)
  googleSub: string     // Google 'sub' claim — stable identity key, unique
  email: string         // @syv.ai; mutable, not the identity key
  displayName: string
  avatarUrl?: string
  createdAt: string; updatedAt: string
}

type Role = 'owner' | 'member'   // exactly two roles — no viewer/read-only (D7)

type Membership = {
  vaultId: string
  userId: string
  role: Role
  invitedByUserId?: string
  createdAt: string
}

// Pending invite for a user who has not signed in yet
type PendingInvite = {
  vaultId: string
  email: string         // @syv.ai
  role: Exclude<Role, 'owner'>   // can't pre-invite an owner
  invitedByUserId: string
  createdAt: string
}
```

**Sessions** are server-side records; the client holds only an opaque token.

```ts
// Server-side; client never sees google tokens
type Session = {
  id: string
  userId: string
  tokenHash: string     // hash of the opaque session token; raw token is client-only
  createdAt: string
  lastSeenAt: string    // updated on each authorized call — drives offline grace
  expiresAt: string     // absolute session lifetime
  revokedAt?: string
}

// Held only by the desktop app, in the OS keychain
type ClientSession = {
  token: string         // opaque bearer; presented to tRPC + Hocuspocus
  userId: string
  expiresAt: string
  cachedAt: string      // last successful server contact — offline-grace anchor
}
```

Google refresh/access tokens (needed for Phase-2 Gmail/Calendar) are stored **server-side only**, encrypted at rest, associated to the user — never synced to the desktop app.

**Per-user tier-2 state** is **UI prefs only** (D6), keyed `(userId, vaultId, key)` in `per_user_state` (architecture §7). It is readable/writable **only** by that `userId`; no membership role grants access to another user's tier-2 rows (see [Per-user scoping](#per-user-scoping)). *(USER.md and personal skills are **not** server state — they live in the user's machine-local Claude config (`~/.claude`, `CLAUDE.local.md`), untouched by Holi, D6. Chat history is likewise local/per-machine, never synced, D9.)*

---

## Flows

### Sign-in (desktop OAuth, system browser + loopback)
1. App has no valid keychain session → shows **Sign in with Google**.
2. Desktop **main** process: generate PKCE `code_verifier`/`code_challenge` + `state` (CSRF nonce); bind an ephemeral loopback listener on `127.0.0.1`.
3. Open the **system browser** to Google's authorize URL with `client_id`, `redirect_uri=http://127.0.0.1:<port>`, `scope=openid email profile`, `hd=syv.ai`, `code_challenge`, `state`.
4. User approves in-browser. Google redirects to the loopback listener with `code` + `state`. Main verifies `state`, then closes the browser tab handoff with a small "you can return to Holi" page.
5. Main sends `{ code, code_verifier, redirect_uri }` to the **Syv server** (tRPC `auth.exchange`). **The server** does the token exchange with Google (holding the Google `client_secret`), verifies the ID token (signature, `aud`, `exp`, `hd == syv.ai`), upserts the `User` (FR-6), provisions the personal vault if first-ever (FR-7), stores Google refresh token server-side, and returns a **Syv session token** + `expiresAt`.
6. Main stores the session in the **OS keychain** (`ClientSession`); the renderer is told only "signed in as X" via the preload bridge. **Renderer never holds the token.**
7. All later tRPC/Yjs calls attach the token; main injects it (renderer asks main to make privileged calls, or the token is attached in the main-side tRPC/WS client).

> **Why loopback + system browser, not embedded:** Google blocks OAuth in embedded webviews; the system browser reuses the user's existing Google session (true SSO) and keeps credentials out of the app's renderer. Loopback (RFC 8252 native-app pattern) needs no custom URL-scheme registration and no client secret on the device (PKCE replaces it). The **code exchange happens on the server**, so the confidential `client_secret` and the Google refresh token stay off every desktop machine.

### Token refresh / session renewal
- The Syv session token is **short-lived**; main **silently refreshes** it via a tRPC `auth.refresh` before expiry while online, and each refresh re-anchors the offline window (updates `lastSeenAt`/`cachedAt`). The cached session stays valid for **offline** work for **~30 days since last successful server contact** (D7); past that, re-auth is required. (Exact access-token TTL is an implementation detail; the 30-day offline ceiling is the decided user-facing bound.)
- Google refresh (for Phase-2 APIs) is entirely **server-side**; the desktop app never participates.

### Invite a member
1. Owner opens vault members panel → enters an `@syv.ai` email, picks role (member | owner; default **member**).
2. tRPC `membership.invite` (authorized: caller is owner of vault). Server validates domain, then either creates a `Membership` (invitee has a user record) or a `PendingInvite` (they don't).
3. If the invitee is online and already a user, the server pushes a vault-list update; the vault appears for them. Pending invites resolve on their next sign-in (FR-10).

### Role change / removal (live enforcement)
1. Owner calls `membership.setRole` / `membership.remove`.
2. On a **role change** (member ↔ owner), the server updates the membership and signals the affected client; the renderer re-renders vault-admin affordances (invite/setRole/remove, theme/settings edit) to match the new role. Edit access is unchanged — both roles read-write.
3. On a **removal**, the server closes the removed user's live Yjs connection for the vault; the vault disappears from their list; their local cache for that vault is purged on the removal event (or on next launch if offline).

### Sign-out
1. Renderer triggers sign-out → main calls `auth.signout` (server revokes the session: sets `revokedAt`).
2. Main deletes the keychain entry and **purges** local working copies + offline queues for all vaults (tier-3 is machine-local and disposable). Any un-synced offline edits are surfaced as a warning **before** purge (Open questions: block sign-out on unsynced edits?).
3. App returns to the sign-in screen.

### Offline session
1. On launch with no network, main reads the keychain `ClientSession`. If `now - cachedAt <= offlineGraceWindow` **and** `now < expiresAt`, Holi opens in offline mode against local caches (D13).
2. Editing works against local Yjs caches; edits queue (D21). Sync-status shows **offline**.
3. On reconnect: main renews the session, Hocuspocus `onAuthenticate` re-authorizes; queued updates replay and auto-merge. If the role changed or membership was revoked while offline, enforcement applies now (FR-20) — disallowed queued writes are rejected and reported.
4. If the grace window elapsed while offline, Holi **locks** to a sign-in prompt (no further local editing) until reconnection re-establishes a session.

---

## Authorization model

**One boundary, server-side, total (D7/D10).** There is exactly one place that decides "can this identity do this to this vault": the server. The client is never trusted for authorization.

Concretely, three enforcement surfaces all resolve the **same** `(session → userId → membership.role)` tuple:

| Surface | Where | Check |
|---|---|---|
| **tRPC procedures** | server, per-procedure middleware | Resolve session token → user. Load `Membership(vaultId, userId)`. Reject if absent (fail closed). Both roles get read+write on content; **owner-only** procedures (invite / setRole / remove, transfer, delete vault, edit theme/settings — D18) additionally require `role == owner`. |
| **Yjs / Hocuspocus** | `onAuthenticate` hook | Validate the token passed on WS connect → user. Load membership. Member/owner → **read-write** connection. No membership → **reject** the connection. No read-only tier exists (D7). Presence/awareness allowed for any member. |
| **Agent MCP ops** | local MCP server (Electron main) → proxies to Syv API; **the Syv API re-checks role** | Every structured op (task create/set, note_rename, calendar/mail writes) is authorized server-side against the run's user + vault role. Any member's agent can call read and write ops; **owner-only ops** (vault admin) are rejected server-side for a member regardless of what the client sends. This is the authoritative boundary (D10); the MCP server in main is a convenience proxy, not a trust boundary. |

Key properties:
- **No client self-escalation.** The role is derived server-side from the DB, never from a client-supplied field, header, or "mode." The dropped safe/power_user modes (D10) are replaced entirely by this role gate.
- **Native tool prompts are UX, not security.** Claude's interactive file/bash permission prompts control *local* file actions on the working copies; they are not the authorization boundary. Authorization for anything that touches server truth (task records, rename, mail/calendar) is the server role gate. Because there is no read-only role (D7), every user with a vault connection is a legitimate writer — the boundary that matters is **membership** (non-members are rejected outright) and, above content, the **owner-only** vault-admin gate.
- **Role capability matrix:**

  | Capability | member | owner |
  |---|:--:|:--:|
  | Read docs / tasks / history-of-own | ✓ | ✓ |
  | Presence / awareness | ✓ | ✓ |
  | Edit docs (Yjs writes) | ✓ | ✓ |
  | Create/modify tasks | ✓ | ✓ |
  | Agent write ops (MCP) | ✓ | ✓ |
  | `note_rename` (atomic link rewrite) | ✓ | ✓ |
  | Invite / setRole / remove | — | ✓ |
  | Transfer ownership | — | ✓ |
  | Edit vault theme / settings (D18) | — | ✓ |
  | Delete vault | — | ✓ |

- **Live revocation.** Role/membership changes propagate to live connections by re-running `onAuthenticate` or closing connections (Flows). No stale-role window beyond one reconnect.

### Per-user scoping

Tier-2 state (D6) is keyed to **identity**, not to vault role — and it is **UI prefs only**:
- `per_user_state(userId, vaultId, key)` is readable/writable only by that `userId`. Owners have **no** read access to another member's UI prefs — ownership governs the **shared** vault, never someone's private tier-2 rows.
- **Personal agent config is not server state at all** (D6): USER.md, personal skills, and `CLAUDE.local.md` live in the user's machine-local Claude config (`~/.claude` and the vault working dir), untouched by Holi and never synced. There is nothing for the server to scope or for another member to leak.
- The vault **theme** is a shared (tier-1) property editable **only by the owner** (D18); members see it but cannot restyle the team's vault. **Light/dark mode**, by contrast, is a per-user **local** toggle (a tier-2 UI pref) — not a server permission and not gated by role.
- Holi composes **no** agent config dir (D6): Claude Code natively picks up the shared vault `.claude/` from the working dir and the user's personal `~/.claude` / `CLAUDE.local.md` layer. Tier-2 UI prefs are fetched with the signed-in user's token and never fanned out over the vault's Yjs channel, so other members' clients never receive them.
- Chat-history JSONLs live on the user's machine; history is Claude Code's native `--resume` (D9). Nothing routes another user's history into a shared surface — there is no server-side conversation store.

---

## Edge cases & risks

- **Non-`@syv.ai` Google account** used at the consent screen: rejected server-side on `hd`/`aud` verification with a Syv-only error, even though the OAuth succeeded at Google. `hd` alone is client-forgeable in some flows, so the **server ID-token check is authoritative**.
- **Email reuse / rename.** Google `sub` is the identity key, not email — a display-name or email change (rare in Workspace) keeps the same user. A **pending invite** matches on email, so an invite sent to an email that later belongs to a different person is a (low) risk; scope pending-invite matching to same-domain and expire invites (Open questions).
- **Owner leaves without transfer.** Blocked (FR-12). A vault must always have exactly one owner. Guard: `membership.remove`/`leave` rejects if it would orphan a shared vault.
- **Last-owner deletion.** Removing the only owner of a shared vault is disallowed; deleting the vault entirely is a separate owner-only action (owned by [`vaults-collaboration.md`](vaults-collaboration.md)).
- **Removal mid-edit.** A member typing in a doc when **removed** from the vault: the server closes their Yjs connection at the change; in-flight local edits after the cutover can't sync and are flagged. Data already synced stays. (A role change owner ↔ member never affects editing — both roles are read-write.)
- **Offline role change.** Enforced on reconnect (FR-20); queued writes the user is no longer permitted are rejected and reported — never silently dropped or silently applied.
- **Token theft / exfiltration.** Session token in the OS keychain, not in plaintext files or `localStorage`; never handed to the renderer. Renderer isolation (`contextIsolation: true`, no `nodeIntegration`) keeps a compromised web context from reading it (architecture §9). A stolen token is bounded by session `expiresAt` and can be killed by sign-out/`auth.revoke`. **Risk accepted:** a fully compromised main process can read the keychain — out of scope to defend against for v1.
- **Loopback interception.** The ephemeral loopback listener + `state` nonce + PKCE prevents another local process from completing the flow without the `code_verifier`. Bind to `127.0.0.1` (not `0.0.0.0`).
- **Provisioning race.** Concurrent first-sign-ins (two devices at once) must not create two personal vaults — provisioning is an idempotent upsert keyed on `(userId, kind=personal)` in one transaction (FR-7).
- **Google downtime.** If Google OAuth is unreachable, **new** sign-ins fail; already-signed-in users continue via cached session (offline grace). Session refresh depends on the Syv server, not Google, so short Google outages don't sign existing users out.
- **Scope creep (Phase 2).** Gmail/Calendar scopes are broad; requesting them incrementally (FR-4) keeps sign-in minimal and avoids a scary first-run consent screen. Google refresh tokens for these stay server-side.
- **Company is Google-only (v1).** No fallback IdP means Google being down blocks onboarding of *brand-new* users; acceptable given the whole company is on Workspace.

---

## Dependencies

- **[`server-data.md`](server-data.md)** — owns the authoritative schema: `users`, `memberships`, `sessions`, `per_user_state`, pending invites, and the encrypted server-side Google token store. This PRD defines behavior against those tables. (No `history_summaries` — chat history is local, D9.)
- **[`vaults-collaboration.md`](vaults-collaboration.md)** — vault lifecycle (create/delete/rename), the members panel UX, presence/awareness, and Hocuspocus `onAuthenticate` wiring (this PRD specifies the *authorization* contract that hook must satisfy; that PRD owns the collaboration surface).
- **[`agent.md`](agent.md)** — the MCP ops surface and the CC-native config layering (D6/D10). This PRD specifies that MCP ops are role-gated at the same server boundary and that tier-2 UI prefs are scoped to the signed-in user; that PRD owns the op catalog and the PTY mechanics.
- **Platform:** Electron `safeStorage` / OS keychain (macOS Keychain, Windows Credential Vault, libsecret) for token storage; system-browser launch + loopback listener in main; Google Cloud OAuth client (Workspace-restricted).

---

## Open questions

1. **Session lifetimes.** The **offline grace window is decided at ~30 days** since last successful server contact (D7). What remains open: the exact **access-token TTL** and whether to force periodic re-consent (e.g. re-auth every N days regardless, independent of the offline ceiling).
2. **Sign-out with unsynced offline edits.** Block sign-out until synced, warn-and-purge, or stash the queue keyed to the user for next sign-in? Leaning warn-and-block-if-unsynced; undecided.
3. **Pending-invite expiry & re-targeting.** How long do pending invites live, and how do we prevent an invite resolving to a re-issued `@syv.ai` address belonging to a new hire? Proposed: expire after 30 days, require same-domain, re-verify on resolution.
4. **Personal → shared promotion.** Out of scope for v1 (FR-14). If needed later, does a personal vault become shareable in place (membership rows added) or is it always a copy? Affects whether personal and shared vaults differ structurally at all.
5. **Departed-employee cleanup.** When Workspace disables an account, Holi should revoke sessions and reassign/orphan their owned shared vaults. Depends on whether we integrate Workspace admin signals (SCIM/directory) — deferred, but the ownership-transfer requirement (FR-13) is the manual stopgap.
6. **Device management.** Do we surface "your active sessions/devices" and allow remote revoke? Nice-to-have; not v1 unless token-theft posture demands it.
7. **Owner count > 1.** v1 fixes exactly one owner (FR-13). If teams want co-owners, `memberships.role` already supports multiple `owner` rows — the only blocker is the "exactly one owner" invariant. Revisit if requested.
