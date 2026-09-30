# Auth

Holi signs in with GitHub and nothing else. There is no Holi server, session, user table or role model: identity is a GitHub account, access to a vault is access to its repo, and the only enforcement point is `git push`. Holi owns one flow, getting and holding a GitHub token, and uses that token to identify the user, list and create repos, list a repo's collaborators and authenticate git.

## How it works

- **Device flow.** Main requests a device and user code, opens GitHub's verification URL in the system browser, and polls at the returned interval. The renderer shows the code with a copy button. `authorization_pending` keeps polling, `slow_down` backs off, `expired_token` offers a new code, `access_denied` returns to the sign-in screen.
- **Scopes:** `repo` (the vaults), `read:user` (identity) and `read:org`, which exists only so "New vault" can offer an org as owner. Listing org repos needs no scope; `affiliation=owner,collaborator,organization_member` is stated explicitly on the repo listing so a changed default cannot hide org vaults.
- **Token custody.** The token is encrypted with Electron `safeStorage` into `userData/github-auth.enc`, held in main, and never crosses to the renderer, which gets `{accountId, login, name, avatarUrl}` only. If the platform cannot encrypt, the store refuses to write rather than falling back to plaintext.
- **Identity is `accountId`**, never `login`: a login can be renamed and a freed one reclaimed by someone else.
- **Git gets the token through `GIT_ASKPASS`**, a small script answering `x-access-token` and `$HOLI_GIT_TOKEN`. It never goes into argv or a remote URL, where it would leak to other processes or persist in `.git/config`. The token is read lazily per operation, so sign-out takes effect on the next pull.
- **Refusals are classified.** GitHub says no in several ways that all arrive as 401 or 403. The API client sorts them into `unauthorized`, `forbidden`, `saml-required`, `rate-limited` and `not-found`. Only a 401 signs the user out. A SAML refusal carries the org's SSO authorization URL from `X-GitHub-SSO`, because that URL is the one thing the user can act on. A push refused for permissions shows the vault as **no write access**, separate from offline and from a merge conflict ([vaults-sync](vaults-sync.md)).
- **Members panel** (vault settings) lists the repo's collaborators read-only, with permission level, plus the repo's visibility. `public` shows in amber: a vault silently becoming public is the worst thing that can happen to it and nothing else would surface it. "Add someone" deep-links to the repo's GitHub access settings. The list comes from the same ten-minute cache as an app's `holi.members()` (`github/members-cache.ts`), dropped when "Add someone" is used, when you leave, and at sign-out, so a member can take up to ten minutes to appear; the visibility is always asked fresh.
- **Sign-out** deletes the keychain entry and stops sync. Clones stay on disk. An optional "also delete local clones" lists clones with unpushed commits first, then moves each clone to the OS trash rather than deleting it.
- **Offline needs no session check**: only pull and push wait for the network.

## Rules

- No authorization checks in the client. A check running on the machine of the person it restricts is not a boundary, and shipping one would suggest protection that does not exist.
- Removing someone stops their future sync; it does not reach back into what they already cloned. Say so rather than imply otherwise.
- A permission failure must never be reported as a network or merge failure, and an unrecognised failure stays unrecognised. Each sends the user to a different fix.
- New repos are always private. `createRepo` has no parameter to say otherwise.
- The GitHub token and the Google grant never touch. Signing out of GitHub leaves Google connected, and the reverse ([google](google.md)).
- One GitHub account per install. The token store's shape makes more accounts additive later.
- The `repo` grant reaches every repo the user has, not just vaults. It stays in main and the keychain, and git only ever runs in Holi-managed clones. The sign-in screen links GitHub's fine-grained token docs as the tighter option.

## Rejected

- Google Workspace SSO: identity only has to unlock the repos, and that is GitHub's account; a second identity means maintaining a mapping between who signs in and who can push.
- A Holi membership or role model: GitHub's push permission is the only distinction that changes what you can do.
- An invite flow: adding a collaborator is a GitHub action.
- A GitHub App: tighter per-repo grants, but an installation step per repo and a harder "any repo you own is a vault" story. Revisit if the broad `repo` grant proves uncomfortable.

## Code

- `apps/desktop/src/main/github/device-flow.ts`: the device-flow poller.
- `apps/desktop/src/main/github/session.ts`: `CLIENT_ID`, `SCOPES`, sign-in, sign-out, adopt a token.
- `apps/desktop/src/main/github/token-store.ts`: the `safeStorage` store.
- `apps/desktop/src/main/github/api.ts`: the REST calls and refusal classification.
- `apps/desktop/src/main/git.ts`: askpass, `classifyPushFailure`.
- `apps/desktop/src/main/router.ts`: `auth`, `github`, `vaults.unpushed`, `vaults.deleteClones`.
- `apps/desktop/src/renderer/src/features/auth/SignIn.tsx`; members panel in `features/settings/VaultSection.tsx`.
