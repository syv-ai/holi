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
- **Google Workspace SSO** — removed. Returns only if the phase-2 Gmail/Calendar work needs Google OAuth, and that grant is about *data access*, not sign-in.
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
8. **FR-8** **New vault** creates a **private** repo, seeds it (a `.gitignore` covering `.holi/settings.local.json` and `USER.md`, a `.claude/` scaffold, an empty `AGENTS.md`/`MEMORY.md`, a daily-note folder), commits, pushes, and opens it.
9. **FR-9** Vaults the user has added are remembered machine-locally, with their clone paths. This list is a *machine* fact, not an account fact — a second laptop starts empty and adds its own.

### Access
10. **FR-10** The members panel lists the repo's **collaborators** from the GitHub API, read-only, showing avatar, login, and permission level.
11. **FR-11** "Add someone" **deep-links** to the repo's GitHub settings page. Holi does not implement invitation.
12. **FR-12** Holi performs **no authorization checks**. Every user with the vault on disk can edit every file in it; whether the result reaches anyone else is decided by GitHub at push time.
13. **FR-13** A **push rejected for permissions** must be reported as exactly that — "you no longer have write access to this repo" — and must not be confused with a network failure or a merge conflict. This is the one place the access model becomes visible, so it is the one place the message must be right.

### Token lifecycle
14. **FR-14** A **401/403 from the API or a credential failure from git** puts the vault into a signed-out state and prompts re-authentication, preserving local work. Tokens are revoked from GitHub's side, not expired on a schedule Holi controls.
15. **FR-15** **Sign-out** deletes the keychain entry and stops all sync. **Clones are left on disk** and the user is told where they are — deleting someone's files (which may hold unpushed commits) is not a sign-out side effect. Offer an explicit "also delete local clones" with an unpushed-work warning.

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
As FR-8: create a private repo, seed, commit, push, open. Seeding matters more than it looks — the `.gitignore` is what keeps `USER.md` and the machine-local settings out of a shared repo, and that is now a **file**, not a server boundary.

### Losing access
1. A teammate is removed from the repo on GitHub.
2. Their next auto-pull or auto-push fails with a permission error.
3. Holi reports it plainly, stops syncing that vault, and leaves the clone and its unpublished commits alone. Their local copy still opens and still edits — it is a folder of markdown on their machine, and pretending otherwise would be theatre.

**This is the honest description of the access model** and it should be stated in the product, not just here: **removing someone stops future sync; it does not reach back and remove what they already have.** That was true of any git-backed system, and it was true of the old design too the moment a clone existed.

---

## Access model

**One boundary: GitHub.** There is exactly one place that decides whether an action affects the shared vault — the remote, at push time.

| Surface | Where | Check |
|---|---|---|
| **Reading a vault** | local filesystem | None. The clone is on disk; the app opens it. |
| **Editing a vault** | local filesystem | None. Every local edit succeeds. |
| **Publishing** | GitHub, on `git push` | GitHub's repo permissions. A rejected push is the enforcement. |
| **Pulling** | GitHub, on `git fetch` | GitHub's repo permissions. |
| **The agent** | local | Whatever the user can do. It runs as them, on their files, with their credential. |

Key properties:

- **No client-side authorization, by design.** The previous design's central rule — "the client is never trusted for authorization" — is preserved, not abandoned: the way to preserve it without a server is to *put no authorization in the client at all*. A permission check running on the machine of the person it restricts is not a boundary, and shipping one would create the illusion of protection.
- **Native tool prompts are UX, not security.** Claude's interactive file/bash prompts control local file actions; they were never the authorization boundary and still aren't.
- **The agent has no authority the user lacks** — it uses the user's credential and the user's clone.
- **Revocation is GitHub's**, and takes effect on the next network operation rather than on a live connection, because there is no live connection to close.

---

## Edge cases & risks

- **The token is a broad `repo` grant.** It can read and write *every* repo the user has, not just their vaults. This is a real widening versus a server-mediated deploy key, and it is inherent to a desktop client acting as the user. Mitigations: the token stays in main and in the keychain, and Holi only ever runs git against its own managed clones. A **fine-grained personal access token** scoped to selected repos is a supported alternative for users who want it, and the sign-in screen should say so.
- **Renderer compromise.** `contextIsolation: true`, no `nodeIntegration`; the token never crosses to the renderer. A fully compromised main process can read the keychain — out of scope to defend for v1, unchanged from before.
- **A private repo made public** exposes vault contents. Holi should surface repo visibility in the members panel, because a vault silently becoming public is the highest-severity thing that can happen to it and nothing else in the product would show it.
- **Login rename / account reuse** — keyed on `accountId`, so display updates and identity does not.
- **`USER.md` or `.holi/settings.local.json` committed by accident** — the seed `.gitignore` prevents it, but an *adopted* repo (or one created before the seed changed) may lack the entries. Holi should check on vault open and offer to add them. This replaces a boundary the server used to enforce structurally, so it deserves an active check rather than a hope.
- **Org SSO enforcement.** A GitHub org with SAML SSO requires the token to be authorized for the org; an unauthorized token fails with a specific error that must be surfaced as "authorize this token for your org", not as a generic auth failure.
- **Rate limits.** Repo and collaborator lists are cheap but not free; cache them and refresh on demand rather than per render.
- **Two machines, one vault, diverged** — normal git divergence, handled by the sync engine, not by identity.
- **A user with no GitHub account** cannot use Holi. Given the standing assumption that every employee is a developer, this is acceptable and should be stated rather than worked around.

---

## Dependencies

- **[`../architecture.md`](../architecture.md)** — the sync engine that uses the credential this PRD obtains.
- **[`agent.md`](agent.md)** — the agent runs with the user's identity in the clone this PRD manages.
- **Platform:** Electron `safeStorage` / OS keychain (macOS Keychain, Windows Credential Vault, libsecret); system-browser launch from main; a GitHub OAuth app configured as a **public client with device flow enabled**.

---

## Open questions

1. **OAuth app vs GitHub App.** A GitHub App gives per-repo installation and short-lived tokens — a materially tighter grant than `repo`. It also complicates the "any repo you own is a vault" story and adds an installation step per repo. Leaning OAuth app for v1, with fine-grained PATs documented as the tighter option; revisit if the broad grant proves uncomfortable.
2. **Org-owned vaults.** Do vaults live under `syv-ai/` or under personal accounts? This decides whether `read:org` is needed and whether "your repos" is the right vault picker.
3. **Should sign-out offer to delete clones?** FR-15 says leave them and offer explicitly. Confirm the unpushed-work warning is enough.
4. **Multiple accounts.** Personal GitHub for personal vaults, work account for shared ones — supported, or explicitly one account per Holi install? Leaning one, with the cost stated.
