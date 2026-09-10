# PRD — Auth, Identity & Access

The identity spine of the system — which is now almost entirely **GitHub's**.

Holi has no server, no user table, no session store, and no authorization layer of its own. Identity is a GitHub account; access to a vault is access to a repo; and the enforcement point is `git push`. This PRD specifies the one flow Holi owns (obtaining and holding a GitHub token) and, just as importantly, what it deliberately no longer does.

---

## Summary

A user signs in with **GitHub**, via the **OAuth device flow** — the browser-based grant designed for clients that cannot hold a client secret, which a desktop app cannot. Holi stores the resulting token in the **OS keychain** (Electron `safeStorage`) and uses it for exactly four things: identifying the user, listing their repos (the vault switcher), listing a repo's collaborators (the members panel), and authenticating `git` over HTTPS.

There is **no Holi session**, because there is no Holi server to hold one. There is **no membership model**, because a repo has collaborators. There is **no role model**, because GitHub's push permission is the only distinction that changes what you can do. And there is **no authorization boundary in the app**, because an authorization check that runs on the client protects nothing.

**Why GitHub and not Google Workspace.** The previous design used Google SSO because identity had to key server-side records, and Syv is a Google shop. With the server gone, the only thing identity must unlock is *the repos the vault lives in* — and that is GitHub's account, not Google's. Using anything else would mean maintaining a mapping between the identity that signs in and the identity that can push.

**What this costs, plainly.** Workspace-managed offboarding is gone: disabling someone's Google account no longer cuts their Holi access. Revoking access means removing them from the GitHub repo or the org — which is a real, auditable action, but it is one an admin performs in GitHub rather than something Holi enforces. For a company where every employee is a developer with a GitHub account, this is the boundary that was already load-bearing.

Holi's auth is **only** the GitHub token. Claude Code is assumed **already installed and authenticated** on every machine with the employee's own account — the two auth surfaces never touch.

---

## Goals / Non-goals

### Goals
- One-tap **Sign in with GitHub** using the device flow; no client secret shipped, no Holi credentials.
- Token in the **OS keychain**, held in Electron main, never handed to the renderer in plaintext.
- The **repo list** as the vault picker, and repo **creation** for "New vault".
- The **collaborator list** as a read-only members panel.
- A credential `git` can push with.
- **Honest access semantics**: Holi never claims to enforce something GitHub enforces.

### Non-goals
- **A Holi user record, session, or membership table.** There is nowhere to put one.
- **Roles.** GitHub's repo permissions are the model. Holi does not define `owner`/`member`.
- **Authorization checks in the client.** They would be advisory at best and misleading at worst.
- **Invite flows.** Adding a collaborator is a GitHub action; Holi deep-links to it.
- **Per-document ACLs within a vault** — the access unit is the repo.
- **Google Workspace SSO** — removed, and it stayed removed. The phase-2 Gmail/Calendar work (D67) did add a **Google OAuth grant**, but it is about *data access*, not sign-in: see §A second provider below. Identity is still GitHub, alone.
- **More than one GitHub account per install.** Personal GitHub for personal vaults and a work account for shared ones is a real pattern and is **not** supported: there is one session, keyed on one account id. The cost is stated rather than hidden — someone whose vaults span two accounts has to choose which one Holi is signed into, and the token store's shape means adding accounts later is additive rather than a rewrite.
- **SCIM / directory provisioning, admin console, audit-log UI.**

---

## User stories

- As a new employee, I open Holi, click **Sign in with GitHub**, approve a short code in my browser, and land in a vault picker listing my repos.
- As a user, I pick a repo and Holi clones it into its managed vault root; it opens as a vault.
- As a user, I create a new vault; Holi creates a private repo and clones it.
- As a user, I open the members panel and see who has access, straight from GitHub.
- As a user, I want to add a teammate, so Holi opens the repo's GitHub collaborators page — it does not pretend to own that flow.
- As a user, my work pushes automatically and the push succeeds because GitHub says I may. If I've been removed, the push fails and Holi tells me clearly.
- As a user, I sign out; the token leaves the keychain and Holi stops touching the remotes. My clones stay on disk unless I say otherwise.

---

## Functional requirements

### Sign-in
1. **FR-1** Provide a single **Sign in with GitHub** action. No email/password form, no other provider.
2. **FR-2** Use the **OAuth device flow**: request a device + user code, show the user code with a copy button, open `github.com/login/device` in the **system browser**, poll for the grant. **Why the device flow:** a public desktop client cannot keep a client secret, and the device flow is the grant designed for that case. It also avoids registering a custom URL scheme and running a loopback listener.
3. **FR-3** Request the minimal scopes needed: **`repo`** (private repo read/write — the vault) and **`read:user`** (identity for the UI). `read:org` only if org-owned vaults need it. Nothing else.
4. **FR-4** Handle the device-flow states explicitly: `authorization_pending` (keep polling at the returned interval), `slow_down` (back off), `expired_token` (offer to restart), `access_denied` (return to the sign-in screen with a clear message).
5. **FR-5** Store the token via Electron **`safeStorage`** in the OS keychain. The token lives in **main**; the renderer receives only `{login, name, avatarUrl}`.

### Identity & vaults
6. **FR-6** After sign-in, fetch the viewer (`login`, `name`, `avatarUrl`) and cache it for offline display. Identity is the **GitHub account id**, not the login (logins are mutable).
7. **FR-7** **Add vault** lists the user's repos (sorted by recent push, searchable) and clones the chosen one into the managed vault root.
7b. **FR-7b** A vault may be **owned by the user or by one of their orgs**, and both are offered — the create picker lists the signed-in login plus every org from `github.orgs`, defaulting to the personal account ([`onboarding.md`](onboarding.md)). There is no "team vault" concept beyond who owns the repo. This is what `read:org` is for, and it is the only thing it is for; the scope is granted rather than avoided because "your repos" would otherwise be the wrong vault picker for a company.
8. **FR-8** **New vault** creates a **private** repo, seeds it (a `.gitignore` covering `.holi/settings/app.local.yaml` and `USER.local.md`, a `.claude/` scaffold, an empty `AGENTS.md`/`MEMORY.md`, a daily-note folder), commits, pushes, and opens it.
9. **FR-9** Vaults the user has added are remembered machine-locally, with their clone paths. This list is a *machine* fact, not an account fact — a second laptop starts empty and adds its own.

### Access
10. **FR-10** The members panel lists the repo's **collaborators** from the GitHub API, read-only, showing avatar, login, and permission level.
11. **FR-11** "Add someone" **deep-links** to the repo's GitHub settings page. Holi does not implement invitation.
12. **FR-12** Holi performs **no authorization checks**. Every user with the vault on disk can edit every file in it; whether the result reaches anyone else is decided by GitHub at push time.
13. **FR-13** A **push rejected for permissions** must be reported as exactly that — "you no longer have write access to this repo" — and must not be confused with a network failure or a merge conflict. This is the one place the access model becomes visible, so it is the one place the message must be right.

### Token lifecycle
14. **FR-14** A **401/403 from the API or a credential failure from git** puts the vault into a signed-out state and prompts re-authentication, preserving local work. Tokens are revoked from GitHub's side, not expired on a schedule Holi controls.
15. **FR-15** **Sign-out** deletes the keychain entry and stops all sync. **Clones are left on disk** and the user is told where they are — deleting someone's files (which may hold unpushed commits) is not a sign-out side effect. Offer an explicit "also delete local clones" with an unpushed-work warning. **The warning has not been verified against a user who actually had unpushed work**, which is the one case it exists for — recorded as an unverified claim rather than a settled one.

### Offline
16. **FR-16** Holi **works fully offline with no session check at all**. The clone is the vault; the editor, board, agent, and reminders are local. This is a substantial simplification over the previous design's 30-day offline grace window, which existed because a server owned the truth.
17. **FR-17** Offline, pull and push are unavailable and the vault shows its sync state as **offline — N waiting**. Local commits accumulate and push automatically when the network returns.

---

## Data & types

There is no server schema. Everything below is machine-local.

```ts
// Held in Electron main; token in the OS keychain via safeStorage
type GitHubAuth = {
  token: string          // OAuth token from the device flow
  accountId: number      // stable GitHub account id — the identity key
  login: string          // mutable; display only
  name?: string
  avatarUrl?: string
  scopes: string[]       // what was actually granted, for honest error messages
}

// Machine-local vault registry (not synced, not an account fact)
type VaultEntry = {
  remote: string         // owner/repo — the vault's identity
  path: string           // clone location under the managed root
  lastOpenedAt: string
}

// Read-only, from the GitHub API
type Collaborator = {
  accountId: number
  login: string
  avatarUrl?: string
  permission: 'admin' | 'maintain' | 'write' | 'triage' | 'read'
}
```

**`accountId` is the identity key, never `login`.** A GitHub login can be changed by its owner, and a freed login can be claimed by someone else — the same class of bug the old design avoided by keying on Google's `sub` rather than email.

---

## Flows

### Sign-in (device flow)
1. No keychain token → show **Sign in with GitHub**.
2. Main `POST`s to GitHub's device-code endpoint with the client id and scopes, receiving `device_code`, `user_code`, `verification_uri`, `interval`, `expires_in`.
3. The renderer shows the **user code** prominently with a copy button and a "open GitHub" action; main opens the verification URI in the **system browser**.
4. Main polls the token endpoint at the given `interval`, honouring `slow_down`.
5. On success, main stores the token in the keychain, fetches the viewer, and tells the renderer "signed in as X".
6. All GitHub API calls and git operations happen **in main**, with the token attached there.

> **Why the system browser:** it reuses the user's existing GitHub session (so this is usually two clicks), and keeps credentials out of the app's web context entirely.

### Adding a vault
1. Signed-in user opens the vault dropdown → **+ New vault…** → **Add existing repo**.
2. Main lists repos via the API; the user picks one.
3. Main clones it under the managed root (`~/Holi/<owner>/<repo>`) using the token, registers a `VaultEntry`, and opens it.

**Only Holi-managed clones.** Holi never adopts a checkout the user maintains themselves — autosave-commit inside a working tree where someone keeps WIP branches and staged changes is destructive, and a managed clone makes that impossible by construction.

### Creating a vault
As FR-8: create a private repo, seed, commit, push, open. Seeding matters more than it looks — the `.gitignore` is what keeps `USER.local.md` and the machine-local settings out of a shared repo, and that is now a **file**, not a server boundary.

### Losing access
1. A teammate is removed from the repo on GitHub.
2. Their next auto-pull or auto-push fails with a permission error.
3. Holi reports it plainly, stops syncing that vault, and leaves the clone and its unpublished commits alone. Their local copy still opens and still edits — it is a folder of markdown on their machine, and pretending otherwise would be theatre.

**This is the honest description of the access model** and it should be stated in the product, not just here: **removing someone stops future sync; it does not reach back and remove what they already have.** That was true of any git-backed system, and it was true of the old design too the moment a clone existed.

---

## A second provider: Google, for data (D67)

Holi holds **two independent OAuth grants**, and the distinction between them is the point:

| | GitHub | Google |
|---|---|---|
| What it is | **Identity + access** — who you are, and what you may push | **A data connector** — read and act on your Gmail and Calendar |
| Grant | Device flow | **Authorization code + PKCE, loopback `127.0.0.1`** redirect |
| Scopes | `repo`, `read:user`, `read:org` | `gmail.modify`, `calendar.readonly`, `calendar.events`, `contacts.readonly`, `contacts.other.readonly` — **read-write, bounded** |
| Without it | Holi cannot open a vault | Holi works completely; mail/calendar surfaces say "not connected" |
| Scope of the connection | **One per install** — one GitHub account signs in | **One per vault** (D87) — a vault names the account it uses, and an account may serve several vaults |

**They never touch.** Signing out of GitHub leaves the Google connection alone, and disconnecting Google touches no vaults, no clones, and no GitHub session. Coupling them would mean losing a mail connector because a git token was revoked — surprising, and wrong in both directions.

**A vault's Google account is its own (D87).** D67 held one connection per machine, and nobody saw the cost until a second vault existed: what it looks like is a brand-new work vault showing personal mail. A vault now names the account it uses, in `userData/google-vault-accounts.json` keyed by remote — machine-local and **outside** the vault, because a mapping inside the clone dies with the working copy, and because every other decision about a *connected account* (the calendar choices, the image-sender allowances, the tokens themselves) already lives beside it. Many vaults may share one account; a vault has at most one.

- **No storage migration was needed.** `google-auth.enc` was already `Record<sub, auth>` — a bet `token-store.ts` took deliberately, and the one that paid out here.
- **Nothing is mapped on upgrade**, and that is deliberate rather than lazy. Every vault asks on first use, and the reconnect costs **one click and no consent round trip**, because the grant is already in the store. The alternative was guessing which vault owned the existing connection, and the equivalent guess in D86 is the one piece of that build that shipped wrong.
- **Disconnect is two acts**, because they are two different things: *disconnect this vault* drops the mapping and leaves every other vault working, and *remove account* revokes at Google, drops the record, deletes that account's cache and unlinks every vault using it. A refcount was rejected — it makes one button mean different things depending on state the user cannot see.
- **The renderer resolves by active vault; the agent does not.** See `prd/agent.md` §Tool surface.

**A vault's Google account is its own (D87).** The grant is still machine-level in the sense that the tokens live in one keychain-backed store, but **which account a vault uses is per vault**: `userData/google-vault-accounts.json` maps `owner/repo` → `sub`, machine-local and outside the clone, because a mapping inside a working copy dies when the clone does. A vault points at at most one account; an account may serve several. Nothing is mapped on upgrade and no vault inherits one — a brand-new work vault showing personal mail is the failure this exists to prevent, and it was found by making a second vault. Reusing an account another vault already has costs a mapping and **no second consent**, since the grant exists. Disconnect is therefore **two acts**: unlink this vault, which leaves the account and every other vault alone, or remove the account, which revokes at Google and clears every mapping to it. Refcounting the two into one button was rejected — it makes the same control mean different things depending on state the user cannot see.

**The agent's door names its vault, not the active one.** An agent session outlives a vault switch: it keeps running against its original vault's cwd while Holi displays another. So the Google ops bearer is minted **per session**, carries the vault it was spawned for, and is revoked on teardown — otherwise a backgrounded agent would read whatever vault is on screen, which is D87's own complaint arriving late and harder to notice. A side benefit: a dead session's bearer stops working, where the app-lifetime token never did.

**Why a different grant shape.** The device flow is right for GitHub and unavailable here: Google does not approve its limited-input device flow for the Gmail/Calendar scopes. Loopback + PKCE is Google's sanctioned desktop pattern — the system browser, a one-shot listener on an ephemeral `127.0.0.1` port, and a code bound to a secret this process invented. As with GitHub, **no confidential secret ships**: a desktop client's id (and the `client_secret` Google issues with it) are not secrets, and PKCE is what actually protects the grant.

**Token custody is stricter than GitHub's, deliberately.** Google returns a short-lived access token plus a refresh token that **rotates on use**, so two independent refreshers can invalidate each other. Therefore **Electron main is the sole token authority**: it is the only process that calls Google's token endpoint, it single-flights the refresh, and every other consumer — including the agent, which runs in its own process — asks *main* for results rather than holding a token. Tokens live in the OS keychain via `safeStorage`, in their own entry, keyed by the Google account's stable `sub` — a map from the first commit, which is why holding several accounts (D87) was additive rather than a storage migration (never the email — a Workspace address can be renamed and reassigned, the same reasoning that keys GitHub on `accountId`).

**Removing an account revokes.** It calls Google's `/revoke` and then clears the record; deleting only the local copy would leave a live grant on the user's account with nothing in Holi to show for it. A failed revoke still clears locally — the user asked for it. **Unlinking a vault does neither** (D87): another vault may be using that account, so a vault letting go of a connection must not reach for the grant behind it.

**Widening the scopes does not invalidate the grant, and that is a trap worth naming once.** The refresh token goes on minting access tokens for whatever was consented to *originally*, so a build that asks for more gets a working connection in which only the new calls 403 — which reads as a broken feature rather than a missing consent, and no amount of retrying fixes it. The cure needs someone to notice first, so the stored grant's scopes are recorded on connect and compared against the build's (`GoogleSession.missingScopes()`), and vault settings offers **Reconnect** when they differ. This has now bitten twice — mail widening to `gmail.modify`, then contacts and calendar writes — and the general shape, *a capability widened in code while the stored credential still reflects the old one*, will recur with every future scope change. A related detail that cost a debugging session: **Google does not echo the scope strings you sent** (`email` comes back as `.../auth/userinfo.email`), so the comparison must be done in Google's own vocabulary or it reports a perfectly good grant as incomplete.

## Access model

**One boundary: GitHub.** There is exactly one place that decides whether an action affects the shared vault — the remote, at push time.

| Surface | Where | Check |
|---|---|---|
| **Reading a vault** | local filesystem | None. The clone is on disk; the app opens it. |
| **Editing a vault** | local filesystem | None. Every local edit succeeds. |
| **Publishing** | GitHub, on `git push` | GitHub's repo permissions. A rejected push is the enforcement. |
| **Pulling** | GitHub, on `git fetch` | GitHub's repo permissions. |
| **The agent** | local | Whatever the user can do. It runs as them, on their files, with their credential. **One exception**: sending mail reaches someone outside this boundary entirely, so it is gated by a hook that asks every time — see [`agent.md`](agent.md) §Permissions. |

Key properties:

- **No client-side authorization, by design.** The previous design's central rule — "the client is never trusted for authorization" — is preserved, not abandoned: the way to preserve it without a server is to *put no authorization in the client at all*. A permission check running on the machine of the person it restricts is not a boundary, and shipping one would create the illusion of protection.
- **Native tool prompts are UX, not security.** Claude's interactive file/bash prompts control local file actions; they were never the authorization boundary and still aren't.
- **The agent has no authority the user lacks** — it uses the user's credential and the user's clone.
- **Revocation is GitHub's**, and takes effect on the next network operation rather than on a live connection, because there is no live connection to close.

---

## Edge cases & risks

- **The token is a broad `repo` grant.** It can read and write *every* repo the user has, not just their vaults. This is a real widening versus a server-mediated deploy key, and it is inherent to a desktop client acting as the user. Mitigations: the token stays in main and in the keychain, and Holi only ever runs git against its own managed clones. A **fine-grained personal access token** scoped to selected repos is a supported alternative for users who want it, and the sign-in screen says so, with a link to GitHub's own instructions — the mitigation is worth nothing if the only place it is written down is this document. **A GitHub App would be tighter still** — per-repo installation and short-lived tokens, a materially narrower grant than `repo` — and it is not what v1 uses, because it complicates the "any repo you own is a vault" story and adds an installation step per repo. That trade is worth revisiting if the broad grant proves uncomfortable in practice; until then the fine-grained PAT is the documented escape hatch.
- **Renderer compromise.** `contextIsolation: true`, no `nodeIntegration`; the token never crosses to the renderer. A fully compromised main process can read the keychain — out of scope to defend for v1, unchanged from before.
- **A private repo made public** exposes vault contents. The members panel therefore shows the repo's **visibility**, and shows `public` in amber — a vault silently becoming public is the highest-severity thing that can happen to it, and nothing else in the product would surface it.
- **Login rename / account reuse** — keyed on `accountId`, so display updates and identity does not.
- **`USER.local.md` or `.holi/settings/app.local.yaml` committed by accident** — the seed `.gitignore` prevents it, but an *adopted* repo (or one created before the seed changed) would lack the entries. So the check is active and runs on **every vault open**, not at creation: `gitignoreWithLocalOnly` merges the required lines **line-wise**, leaving an adopted repo's own ignores alone and doing nothing at all when they are already there. It does not ask, because there is no version of this the user would decline, and it replaces a boundary the server used to enforce structurally.
- **Org SSO enforcement.** A GitHub org with SAML SSO requires the token to be authorized for the org, and an unauthorized token fails with a specific error. It is surfaced as itself: main appends the **SSO authorization URL** GitHub returns to the message, because that URL is advice for a human and a generic auth failure sends them nowhere.
- **Rate limits.** Repo and collaborator lists are cheap but not free; cache them and refresh on demand rather than per render.
- **Two machines, one vault, diverged** — normal git divergence, handled by the sync engine, not by identity.
- **A user with no GitHub account** cannot use Holi. Given the standing assumption that every employee is a developer, this is acceptable and should be stated rather than worked around.

---

## Dependencies

- **[`../architecture.md`](../architecture.md)** — the sync engine that uses the credential this PRD obtains.
- **[`agent.md`](agent.md)** — the agent runs with the user's identity in the clone this PRD manages.
- **Platform:** Electron `safeStorage` / OS keychain (macOS Keychain, Windows Credential Vault, libsecret); system-browser launch from main; a GitHub OAuth app configured as a **public client with device flow enabled**.

---
