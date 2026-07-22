# GitHub Auth Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `apps/desktop/src/main/github/` — the OAuth device flow, a token in the OS keychain, and the three GitHub reads the product needs (viewer, repos, collaborators), so onboarding can sign a user in and hand `git.ts` a credential.

**Architecture:** Four small modules with one composition point. `device-flow.ts` is a polling state machine over two documented endpoints; `api.ts` is a thin typed REST client; `token-store.ts` owns encryption and disk; `session.ts` composes them and exposes the lazy `token()` getter that `GitDeps` already expects. Everything lives in **main** — the token never crosses the IPC seam (FR-5). No Electron API is imported outside a port, so the whole thing is unit-testable under plain Node.

**Tech Stack:** Node's global `fetch` (Electron 43 → Node 22), Electron `safeStorage` behind an interface, Vitest. **No new dependencies** — not Octokit: we make five requests, and the client that wraps them would be larger than they are.

**PRD:** [`docs/prd/auth-identity.md`](../prd/auth-identity.md) — FR-1/2/3/4 (the flow), FR-5 (keychain), FR-6/7/8 (viewer, repo list, repo creation), FR-10 (collaborators), FR-14/15 (token lifecycle), and §Edge cases (broad grant, SAML SSO, rate limits, login rename).

---

## Decisions taken into this plan

Answered by Nicolai 2026-07-22, before writing:

1. **No OAuth app exists yet.** The client id is a constant in source with an env override, and registering the app is a checklist item (see [Before this can run for real](#before-this-can-run-for-real)) rather than a blocker. A public client's id is not a secret — that is the premise of the device flow — so a constant is the correct home for it, not a build secret.
2. **Vaults live under both personal accounts and orgs.** This decides the scopes and the picker; see the note on `read:org` below.
3. Unrelated to this plan but now settled: `prd/tasks.md` §Concurrency was narrowed in `90dcaf3`.

### Scopes — and why `read:org` earns its place

`repo`, `read:user`, `read:org`.

The tempting mistake is to add `read:org` "for org vaults". It is not needed for that: `GET /user/repos` defaults `affiliation` to `owner,collaborator,organization_member`, so **org repos already appear in the picker under the `repo` scope alone**, and `GET /repos/{owner}/{repo}/collaborators` needs push access rather than an org scope.

`read:org` is needed for exactly one thing: **FR-8's "New vault" owner picker**. Creating a repo under `syv-ai` posts to `/orgs/{org}/repos`, and offering the user that choice means listing their orgs with `GET /user/orgs`, which `read:org` gates. Ask for it because a feature uses it, and be able to name the feature.

---

## Why mocking `fetch` is right here, when mocking `execFile` was wrong

The git plan forbade mocking the subprocess, and that rule does not transfer. It existed because git's *refusal* to merge is the load-bearing behaviour — a mock would have tested the plan's idea of git rather than git, and there is a real git on the machine to test against instead.

Neither half holds for GitHub. The load-bearing behaviour here is **our** state machine over a documented wire protocol, and there is no local GitHub to run. So `fetch` is injected and tests drive it.

Two rules keep that honest:

- **Fixtures are verbatim response bodies and headers** from GitHub's documented shapes — including the ones that are easy to get wrong, like `authorization_pending` arriving as an HTTP **200**.
- **Tests assert on the requests we send**, not only on how we parse replies: method, URL, `Accept`, `Authorization`, and body. A client that parses correctly but asks wrongly passes a reply-only test and fails against GitHub.

No test in this plan touches the network.

---

## File structure

| File | Responsibility |
|---|---|
| `apps/desktop/src/main/github/device-flow.ts` | The two-phase device grant: request a code, then poll. Knows `interval`, `slow_down`, and expiry. |
| `apps/desktop/src/main/github/token-store.ts` | Encrypt with `safeStorage`, write to disk, read back. The only file that knows a keychain exists. |
| `apps/desktop/src/main/github/api.ts` | Viewer, repos, collaborators, create-repo. Pagination and error classification. |
| `apps/desktop/src/main/github/session.ts` | Composition: who is signed in, `token()` for `GitDeps`, sign-in, sign-out, and what a 401 does. |
| `apps/desktop/test/github-device-flow.test.ts` | |
| `apps/desktop/test/github-token-store.test.ts` | |
| `apps/desktop/test/github-api.test.ts` | |
| `apps/desktop/test/github-session.test.ts` | |
| `apps/desktop/src/main/router.ts` (modify) | `auth.*` and `github.*` procedures, so the renderer has something to call. |

Four files rather than one — the opposite of `git.ts`'s deliberate single file, and for the opposite reason. `git.ts` is one file because `runGit` and its operations change together. These four change independently: the flow is fixed by an RFC, the store by an OS API, the client by GitHub's REST surface. They share only the token.

---

## Contracts

```ts
// ─── device-flow.ts ────────────────────────────────────────────────────────

/** What the renderer shows. The `device_code` deliberately never appears here —
 *  it is the half of the pair that authenticates, and the UI has no use for it. */
export interface DeviceCode {
  userCode: string
  verificationUri: string
  /** Epoch ms. The UI counts down against it and the poller stops at it. */
  expiresAt: number
}

export type DeviceFlowResult =
  | { kind: 'granted'; token: string; scopes: string[] }
  | { kind: 'denied' }     // the user pressed Cancel on github.com
  | { kind: 'expired' }    // FR-4: offer to restart
  | { kind: 'cancelled' }  // we aborted locally — a closed window, a second sign-in

export interface DeviceFlow {
  readonly code: DeviceCode
  /** Resolves once; never rejects for a flow outcome. Network faults still throw. */
  wait(): Promise<DeviceFlowResult>
  cancel(): void
}

/** Two-phase on purpose: FR-2 requires showing the user code *while* polling,
 *  and a one-shot `signIn(): Promise<token>` cannot surface it until it is
 *  already spent. */
export function startDeviceFlow(deps: DeviceFlowDeps): Promise<DeviceFlow>

export interface DeviceFlowDeps {
  clientId: string
  scopes: string[]
  fetch?: typeof globalThis.fetch
  now?: () => number
  /** Injected so the poll interval costs a test nothing. */
  sleep?: (ms: number) => Promise<void>
}

// ─── token-store.ts ────────────────────────────────────────────────────────

/** The whole record is encrypted, not just the token. The login and avatar are
 *  not secret, but a second plaintext format would exist only to leak them —
 *  and if the keychain cannot be read, the token is gone too, so there is
 *  nothing to display anyway. */
export interface StoredAuth {
  token: string
  /** FR-6: the identity key. Never `login` — a login can be renamed by its
   *  owner and the freed name claimed by someone else. */
  accountId: number
  login: string
  name?: string
  avatarUrl?: string
  /** What was actually granted, so an error can say which scope is missing
   *  instead of guessing. */
  scopes: string[]
}

/** Exactly Electron `safeStorage`'s shape, so production passes it straight
 *  through and no adapter exists to drift. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

export class TokenStore {
  constructor(file: string, storage: SafeStorageLike)
  /** `null` for "signed out" — including when the file is corrupt or was
   *  written by a format we do not know. Never throws for bad content. */
  read(): Promise<StoredAuth | null>
  /** Throws `EncryptionUnavailableError` rather than writing plaintext. */
  write(auth: StoredAuth): Promise<void>
  clear(): Promise<void>
}

export class EncryptionUnavailableError extends Error {}

// ─── api.ts ────────────────────────────────────────────────────────────────

export interface Viewer {
  accountId: number
  login: string
  name?: string
  avatarUrl?: string
}

export interface Repo {
  /** `owner/repo` — the same identity `VaultEntry` and `cloneRepo` use. */
  remote: string
  private: boolean
  /** ISO. The picker's sort key (FR-7: "sorted by recent push"). */
  pushedAt: string
  defaultBranch: string
  /** `permissions.push`. A repo you cannot push to would become a vault that
   *  cannot publish — the picker offers it greyed, never silently. */
  canPush: boolean
  owner: { login: string; kind: 'user' | 'org' }
}

export interface Org {
  login: string
  avatarUrl?: string
}

export class GitHubApi {
  constructor(deps: ApiDeps)
  viewer(): Promise<Viewer>
  /** Every page, newest push first. */
  repos(): Promise<Repo[]>
  /** One repo. Exists so the members panel can show visibility without
   *  listing every repo the user has to read one field. */
  repo(remote: string): Promise<Repo>
  orgs(): Promise<Org[]>
  collaborators(remote: string): Promise<Collaborator[]>   // Collaborator is @holi/shared's
  /** FR-8. Always private. `owner` omitted → the viewer's own account. */
  createRepo(args: { name: string; owner?: string }): Promise<Repo>
}

export interface ApiDeps {
  /** A getter, not a string — the same reason `GitDeps.token` is one. */
  token: () => string | null
  /** FR-14: called on a 401 and on nothing else. See the gotcha. */
  onUnauthorized?: () => void
  fetch?: typeof globalThis.fetch
  /** Tests point this at a fake origin; production leaves it. */
  baseUrl?: string
}

export class GitHubApiError extends Error {
  status: number
  /** The five that change what the user is told. Everything else is 'other'. */
  kind: 'unauthorized' | 'forbidden' | 'saml-required' | 'rate-limited' | 'not-found' | 'other'
  /** `saml-required` only: the URL from `X-GitHub-SSO`, which is the one thing
   *  that makes the error actionable. */
  ssoUrl?: string
}

// ─── session.ts ────────────────────────────────────────────────────────────

export class GitHubSession {
  static load(deps: SessionDeps): Promise<GitHubSession>
  /** `null` when signed out. Renderer-safe: no token, by construction. */
  readonly viewer: Viewer | null
  readonly api: GitHubApi
  /** The closure `openRepo(root, { token: () => session.token() })` wants. */
  token(): string | null
  /** Starts the grant and returns immediately with the code to display.
   *  Awaiting `flow.wait()` is the caller's job; on `granted` the session
   *  stores the token and fetches the viewer before the promise settles. */
  signIn(): Promise<DeviceFlow>
  /** FR-15: clears the keychain entry. Clones are left on disk, untouched. */
  signOut(): Promise<void>
  /** Fires on sign-out and on a 401. Plan 4's orchestrator stops sync on it. */
  onChange(cb: (viewer: Viewer | null) => void): () => void
}

export interface SessionDeps {
  store: TokenStore
  clientId?: string   // defaults to HOLI_GITHUB_CLIENT_ID ?? the constant
  fetch?: typeof globalThis.fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}
```

---

## Gotchas — read before writing code

**The device flow**

- **`authorization_pending` arrives as HTTP 200.** The error is a field in the JSON body, not a status. Branching on `res.ok` alone polls forever and never notices the grant was denied either. Parse the body's `error` on every response.
- **Send `Accept: application/json` to both device endpoints.** Without it GitHub replies **form-urlencoded** and `res.json()` throws on a response that was actually fine.
- **`slow_down` carries a new `interval`** — adopt it, and note GitHub also expects the extra ~5s. Ignoring it gets the flow rate-limited out entirely, which surfaces as a sign-in that mysteriously stops working after a retry.
- **Stop at `expires_in`** (~900s). A poller with no deadline holds a request loop alive for the life of the process.
- **The device-flow grant must be enabled on the OAuth app.** If it is not, `POST /login/device/code` returns **404**, which reads like a wrong URL and is not. Say so in the error message.
- **`cancel()` must actually stop the loop**, not just resolve the promise — a second sign-in attempt with a first still polling burns the rate limit and can settle the wrong grant.

**The keychain**

- **`safeStorage.isEncryptionAvailable()` can be `false`**: on Linux with no keyring, and on some platforms before `app.whenReady()`. Never fall back to plaintext — throw `EncryptionUnavailableError` and let sign-in say the keychain is unavailable. A token in a plaintext file is the exact thing FR-5 exists to prevent.
- **`decryptString` takes a `Buffer`**, not a `Uint8Array`. Read the file as one.
- **A corrupt or unknown-version file reads as `null`, not a throw** — the same policy `registry.ts` follows, for the same reason: a bad file must not brick the app into a state with no way back. Wrap the ciphertext in a `{ v: 1, data: <base64> }` envelope so a future format change has somewhere to be detected.

**The API**

- **A 401 clears the session. A 403 does not.** A 403 is a repo you lack access to, a rate limit, or SAML — none of them mean your token is dead, and signing someone out because they clicked an org repo they cannot read is a bug that looks like a security feature. This is the same discipline `classifyPushFailure` follows: when the cause is not certain, do not assert one.
- **SAML SSO** returns 403 with `X-GitHub-SSO: required; url=https://github.com/orgs/<org>/sso?authorization_request=…`. Parse the URL out and carry it — "authorize this token for your org" with a link is actionable; "403 Forbidden" is not (PRD §Edge cases).
- **Rate limiting** is a 403 (or 429) with `x-ratelimit-remaining: 0`. Check that header **before** classifying a 403 as a permission problem.
- **Follow the `Link` header's `rel="next"`.** With `per_page=100` and no pagination, a user with more than 100 repos loses the tail — and the vault they are hunting for is disproportionately likely to be in it.
- **Never let the token reach a log, a message, or an error.** `GitHubApiError` may carry a response body; it must never carry request headers.
- **Send `Accept: application/vnd.github+json` and `X-GitHub-Api-Version: 2022-11-28`** on every API request. The version header is what stops a future default from quietly reshaping a response.
- **Give every request an `AbortSignal.timeout`.** A hung socket during polling stalls sign-in with no error and nothing to cancel.

**The seam**

- **No router procedure may return the token** (FR-5). The renderer gets `{ login, name, avatarUrl }` and nothing more. Assert this in a test, because it is the kind of thing a later convenience field re-adds.
- **Cache repos and collaborators; do not fetch per render** (PRD §Edge cases). A cache with an explicit refresh belongs at the router edge, not inside `GitHubApi` — a client that caches is a client you cannot reason about.

---

## Task 1: `TokenStore` — the keychain, behind a port

**Files:**
- Create: `apps/desktop/src/main/github/token-store.ts`
- Create: `apps/desktop/test/github-token-store.test.ts`

- [x] **Step 1: Write the failing tests**

A `fakeStorage()` helper for the whole file: implements `SafeStorageLike` with a reversible transform (base64 of the plaintext, prefixed with a marker) and a settable `available` flag. It must **not** be the identity function — a store that "works" by writing plaintext would pass an identity-backed test, which is the one failure this module exists to prevent.

`describe('TokenStore')`:
- `round-trips an auth record` — write then read returns a deep-equal `StoredAuth`.
- `writes no plaintext token to disk` — write, then read the file's raw bytes and assert the token string does not appear in them. This is the test that actually pins FR-5.
- `reads null when the file does not exist` — first launch is signed out, not an error.
- `reads null when the file is corrupt` — write garbage, expect `null`.
- `reads null when the envelope version is unknown` — `{ v: 99, data: '…' }`.
- `reads null when decryption fails` — a fake whose `decryptString` throws (a keychain re-keyed by an OS upgrade). Signed out, not a crash on launch.
- `throws EncryptionUnavailableError rather than writing plaintext` — `available = false`; assert the type **and** that no file was created.
- `clear removes the entry` — write, clear, read is `null`; and clearing when nothing is stored is a no-op, because sign-out can be pressed twice.

- [x] **Step 2: Run and watch fail**

Run: `pnpm exec vitest run test/github-token-store.test.ts --root apps/desktop`
Expected: FAIL — `TokenStore is not a constructor`.

- [x] **Step 3: Implement**

`{ v: 1, data: base64 }` JSON envelope over `encryptString(JSON.stringify(auth))`. Write via the temp-file-then-`rename` dance `registry.ts` already uses, so a crash mid-write cannot leave a half-file. `read` returns `null` for every parse or decrypt failure.

- [x] **Step 4: Run and watch pass**

- [x] **Step 5: Commit**

```bash
git add apps/desktop/src/main/github/token-store.ts apps/desktop/test/github-token-store.test.ts
git commit -m "feat(desktop): the token lives in the keychain or it does not live"
```

---

## Task 2: `startDeviceFlow`

**Files:**
- Create: `apps/desktop/src/main/github/device-flow.ts`
- Create: `apps/desktop/test/github-device-flow.test.ts`

- [x] **Step 1: Write the failing tests**

A `fakeFetch(script)` helper for the whole file: takes an array of `{ status, body, headers? }` handed out in order, and records every request (`url`, `method`, `headers`, `body`) for assertion. Later files reuse this shape — keep it simple enough to copy rather than exporting a shared test util that three suites then couple to.

`describe('startDeviceFlow')`:
- `requests a device code with the client id and scopes` — assert the POST goes to `/login/device/code`, carries `Accept: application/json`, and includes both the client id and the space-joined scopes. Request-shape assertion, not reply-parsing.
- `returns the user code and verification uri without polling yet` — after `startDeviceFlow` resolves, exactly **one** request has been made. FR-2's whole point is that the code is displayable before the grant exists.
- `computes expiresAt from expires_in and now()` — injected `now`, assert the exact epoch ms.
- `polls until the token arrives` — `authorization_pending` at **status 200**, then a grant. Assert `{ kind: 'granted' }` and the parsed scopes (GitHub returns `scope` as a comma-separated string, not an array).
- `waits the returned interval between polls` — record the `sleep` calls; assert the first one is the `interval` from the code response, in **ms**, not seconds.
- `backs off on slow_down and adopts the new interval` — assert the sleep after a `slow_down` uses the new value.
- `returns denied on access_denied` — not a throw. A user pressing Cancel is a normal outcome.
- `returns expired on expired_token`.
- `returns expired when the deadline passes without a verdict` — advance the injected clock past `expiresAt`; assert it stops polling rather than looping forever.
- `returns cancelled and stops polling after cancel()` — assert **no further requests** are made after the call. The count is the assertion; a resolved promise over a live loop passes a weaker test.
- `surfaces a 404 on the device-code endpoint as advice` — assert the message names the device-flow setting on the OAuth app, because this is what an unconfigured app looks like and it reads like a typo.

- [x] **Step 2: Run and watch fail**

- [x] **Step 3: Implement**

`POST https://github.com/login/device/code`, then poll `POST https://github.com/login/oauth/access_token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`. Both with `Accept: application/json`. Branch on the body's `error` field on every response regardless of status; treat an unrecognised `error` as a throw, since an unknown grant state is not a state to guess at. `cancel()` flips a flag the loop checks after each sleep **and** before each request.

- [x] **Step 4: Run and watch pass**

- [x] **Step 5: Commit** — `feat(desktop): sign in with a code you read off the screen`

---

## Task 3: `GitHubApi` — viewer, repos, and honest errors

**Files:**
- Create: `apps/desktop/src/main/github/api.ts`
- Create: `apps/desktop/test/github-api.test.ts`

- [x] **Step 1: Write the failing tests**

`describe('GitHubApi')` — requests:
- `sends the token, the accept header and the api version` — assert all three on a `viewer()` call.
- `sends no Authorization header when signed out` — the getter returns `null`; the request still goes out unauthenticated rather than throwing, so a public-repo read is possible and the 401 path is the one that reports it.
- `reads the token lazily on every request` — a getter returning different values on successive calls produces different headers. This is what makes sign-out take effect immediately rather than at restart.

`viewer()`:
- `maps the viewer response` — `id` → `accountId`, `avatar_url` → `avatarUrl`, and `name: null` (which GitHub does send) becomes `undefined`, not the string `"null"`.

`repos()`:
- `requests 100 per page sorted by pushed` — assert the query string.
- `follows the Link header to the next page` — two pages, second has no `next`; assert both pages' repos appear and exactly two requests were made.
- `maps owner kind from the owner type` — `"Organization"` → `'org'`, `"User"` → `'user'`. Both must work: this is the grouping the picker uses.
- `carries canPush from permissions.push`.
- `returns them newest push first`.

Errors:
- `classifies 401 as unauthorized and calls onUnauthorized`.
- `classifies a plain 403 as forbidden and does NOT call onUnauthorized` — the sharpest assertion in this file. A repo you cannot read must not sign you out.
- `classifies 403 with x-ratelimit-remaining: 0 as rate-limited` — checked before the permission reading.
- `classifies 403 with X-GitHub-SSO as saml-required and extracts the url` — feed the header verbatim; assert `ssoUrl` is the full authorization-request URL.
- `classifies 404 as not-found`.
- `never puts the token in the error` — assert the thrown error's `message` and `JSON.stringify(err)` contain no part of the token.

- [x] **Step 2: Run and watch fail**

- [x] **Step 3: Implement**

One private `request()` doing headers, timeout, status classification and JSON parsing; one `paginate()` over it following `Link`. Public methods are mappers. Classify in this order: **401 → rate-limit → SAML → other 403 → 404 → other**, because two of those are 403s and the order is the correctness.

- [x] **Step 4: Run and watch pass**

- [x] **Step 5: Commit** — `feat(desktop): read GitHub, and say which kind of no it was`

---

## Task 4: `collaborators`, `orgs`, `createRepo`

**Files:** modify `api.ts`, `github-api.test.ts`

- [x] **Step 1: Write the failing tests**

`collaborators()`:
- `maps a collaborator list to the shared Collaborator type` — `permissions` → the single `permission` string. GitHub returns **both** a `permissions` object and a `role_name`; take the highest true permission from the object so the mapping is total and does not depend on a role vocabulary GitHub can extend.
- `paginates` — same `Link` behaviour as repos.
- `rejects a remote that is not owner/repo` — reuse `isRemote` from `vault/registry.ts` rather than writing a second validator. The value goes into a URL path.

`repo(remote)` — a single repo, added for one reason: the members panel must show **visibility**. PRD §Edge cases calls a vault silently becoming public the highest-severity thing that can happen to it, and nothing else in the product would surface it. The panel cannot get it from `repos()` without listing every repo to read one field.
- `returns a single repo with its visibility`.
- `surfaces a 404 as not-found` — a repo deleted or renamed on GitHub while a clone of it sits on disk.

`orgs()`:
- `lists the viewer's orgs` — this is what `read:org` was requested for, and the only thing.

`createRepo()`:
- `creates a private repo under the viewer by default` — assert `POST /user/repos` with `private: true`. Private is not a default the caller may override; a vault created public is the highest-severity thing in the PRD's edge cases.
- `creates under an org when one is given` — assert `POST /orgs/{org}/repos`.
- `surfaces a name collision as a plain error` — GitHub returns 422; assert the message names the repo, since "already exists" is a thing the user can fix themselves.

- [x] **Step 2: Run and watch fail**
- [x] **Step 3: Implement** — three mappers over the existing `request`/`paginate`.
- [x] **Step 4: Run and watch pass**
- [x] **Step 5: Commit** — `feat(desktop): a repo is a vault, and its collaborators are its members`

---

## Task 5: `GitHubSession`

**Files:**
- Create: `apps/desktop/src/main/github/session.ts`
- Create: `apps/desktop/test/github-session.test.ts`

This is where FR-14 and FR-15 actually happen; the earlier tasks only make them possible.

- [x] **Step 1: Write the failing tests**

`describe('GitHubSession')`:
- `loads signed out when the store is empty` — `viewer` is `null`, `token()` is `null`.
- `loads the cached viewer offline` — a stored record with a `fetch` that always rejects; `viewer` is still populated. FR-6: identity is cached for offline display, and a vault must open with no network at all (FR-16).
- `signIn returns the code before the grant exists` — assert `flow.code` is present and the store is still empty.
- `signIn stores the token and viewer on grant` — drive the fake through to `granted`; after `wait()` resolves, `token()` returns it and `viewer.accountId` is set. Assert the store was written **before** `wait()` settled, so a caller that navigates on resolution cannot beat the persist.
- `signIn leaves the session signed out on denied` — store untouched, `token()` still `null`.
- `signOut clears the store and the viewer` — and `token()` returns `null` immediately, not after a reload.
- `signOut does not touch the clone paths` — assert the registry is unchanged. FR-15: someone's unpushed commits are not a sign-out side effect.
- `a 401 from the api signs the session out` — make an API call return 401; assert `viewer` is `null`, the store is cleared, and `onChange` fired.
- `a 403 from the api does NOT sign the session out` — the mirror assertion, and the one that will regress.
- `onChange fires on sign-in, sign-out and a 401, and unsubscribes` — plan 4's sync orchestrator hangs off this.
- `token() is a live getter` — capture `const t = () => session.token()` **before** sign-in, assert it returns the token after. This is precisely how `openRepo` will hold it, so it is the shape worth testing.

- [x] **Step 2: Run and watch fail**

- [x] **Step 3: Implement**

`load()` reads the store; `signIn()` calls `startDeviceFlow`, wraps `wait()` so a `granted` result fetches the viewer, writes the store and fires `onChange` before resolving. `onUnauthorized` (401 only) clears store and viewer and fires `onChange`. The client id resolves as `deps.clientId ?? process.env.HOLI_GITHUB_CLIENT_ID ?? CLIENT_ID`, with `CLIENT_ID` an exported constant carrying a comment that it is a placeholder until the OAuth app is registered.

- [x] **Step 4: Run and watch pass**

- [x] **Step 5: Commit** — `feat(desktop): one session, and a sign-out that takes effect now`

---

## Task 6: Expose it through the router

**Files:**
- Modify: `apps/desktop/src/main/router.ts`
- Modify: `apps/desktop/test/router.test.ts`

Without this the plan builds a module nobody can call. `RouterDeps` already carries `registry`; add **`session`** and **`openExternal: (url: string) => Promise<void>`**. `safeStorage` stays out of it entirely.

`openExternal` is injected rather than imported because it is Electron's `shell.openExternal`, and `router.ts` typechecks and tests under plain Node today — that is worth keeping. It covers two requirements that would otherwise have no home: **FR-2** (main opens `github.com/login/device` in the *system* browser, so the grant reuses the user's existing GitHub session and no credential ever enters the app's web context) and **FR-11** ("add someone" deep-links to the repo's collaborators settings page, because Holi does not implement invitation).

- [x] **Step 1: Write the failing tests**

In `router.test.ts`, a `describe('auth')` against a session built on a fake store and fake fetch, with a recording `openExternal`:
- `auth.status returns the viewer, or null when signed out`.
- `auth.status never returns the token` — assert on the serialized result, not on the type. A type says what we meant; the assertion says what we shipped.
- `auth.signIn returns the user code and verification uri`.
- `auth.signIn opens the verification uri in the system browser` — assert `openExternal` was called with the URI GitHub returned, not a hardcoded one; GitHub is free to change it and the code on screen belongs to whatever it says.
- `auth.signOut clears the session`.
- `github.repos lists repos, pushable ones flagged`.
- `github.collaborators returns the shared Collaborator shape, with the repo's visibility`.
- `github.openCollaboratorSettings opens the repo's GitHub settings page` — assert the exact URL (`https://github.com/<owner>/<repo>/settings/access`) and that the remote is validated first, since it is interpolated into a URL.
- `github.repos surfaces saml-required with its url` — assert the TRPCError carries the SSO URL, because a generic FORBIDDEN here is the unhelpful message the PRD calls out by name.
- `github.repos fails clearly when signed out` — UNAUTHORIZED, not an unauthenticated request that 401s its way to the same place by accident.

- [x] **Step 2: Run and watch fail**

- [x] **Step 3: Implement**

Eight procedures. Map `GitHubApiError.kind` → `TRPCError` codes in one place at the router edge; the `ssoUrl` rides in the message, since it is advice for a human. **The renderer-facing type must be a hand-written projection** (`{ login, name, avatarUrl }`), never `StoredAuth` minus a field — an `Omit<StoredAuth, 'token'>` silently re-includes whatever is added to `StoredAuth` later.

Both `openExternal` call sites validate before they interpolate. `auth.signIn` passes through a URL GitHub gave us; `github.openCollaboratorSettings` builds one from a remote the renderer supplied, so it goes through `isRemote` first — the same rule every path from the renderer already follows in `safe()`.

- [x] **Step 4: Run and watch pass**

- [x] **Step 5: Commit** — `feat(desktop): the renderer can ask who you are, and nothing more`

---

## Task 7: Wire the real `safeStorage` and the vault root

**Files:** modify `apps/desktop/src/main/index.ts` **only if it already compiles** — see below.

- [x] **Step 1: Check whether `main/index.ts` is repairable**

Run: `cd apps/desktop && pnpm exec tsc --noEmit 2>&1 | grep 'main/index.ts'`

It carries 7 errors and imports several modules that no longer exist. **If it does not compile, stop and do not repair it here** — it is plan 4's rewrite, and dragging it forward turns this plan into that one. Instead:

- [x] **Step 2: Leave a construction site plan 4 can pick up**

Add to `session.ts` a documented factory — `createSession(userDataDir)` — that builds `new TokenStore(join(userDataDir, 'github-auth.enc'), safeStorage)` with `safeStorage` imported from `electron`. Keep it the **only** line in the package that imports `electron`, and keep it out of every path the tests take, so the suite still runs under plain Node.

Note in a comment that it must be called **after `app.whenReady()`** — `isEncryptionAvailable()` is not reliable before it, and a sign-in that fails on the first launch of the day and works on the second is a miserable bug to find.

- [x] **Step 3: Verify the suite still runs under Node**

Run: `pnpm exec vitest run --root apps/desktop`
Expected: all green, no `electron` import error.

- [x] **Step 4: Commit** — `feat(desktop): the keychain the app will actually use`

---

## Outcome — completed 2026-07-22

**85 new tests, all green.** Suite went 394 → 479 (`packages/shared` 113 · `apps/desktop` 366). Typecheck **still exactly 106 errors**, in the same fourteen files, none of them new.

Five things the plan did not anticipate, corrected in place:

1. **`createSession` moved out of `session.ts` into `github/electron.ts`.** The plan put it at the bottom of `session.ts`, which the suite imports — and a static `import … from 'electron'` is a module-load side effect. It *passed*, because Electron's Node entry point resolves and exports a path string, so `app` and `safeStorage` come back undefined and nothing calls them. That is luck, not isolation: it would break on an image where the resolution differs, for a reason with nothing to do with the code. A separate file makes the property structural. The definition of done below is amended accordingly.
2. **`onUnauthorized` is awaited.** The plan had it as `() => void`, fired and forgotten. Then the ordering of "the 401 rejection surfaces" against "the session has actually cleared" depends on how the caller happens to yield, which is not something a test should have to know. Awaiting it inside `#send` means a caller handling the rejection always sees a session that already reflects the sign-out.
3. **Sign-in needed four procedures, not one.** The device flow is two-phase and a tRPC procedure returns once, so `signIn` stashes the flow and `awaitSignIn` long-polls it, with `cancelSignIn` to stop. The plan's eight procedures became ten.
4. **`Repo.visibility` needed a fallback.** GitHub sends `visibility` and `private` both; an unrecognised `visibility` now falls back to the boolean rather than defaulting to a string, because "public" is the wrong guess to make about a repo GitHub called private.
5. **One test of mine was wrong and the code was right.** `status never returns the accountId` searched the serialized result for `583231` — which fails no matter what, because GitHub embeds the account id in the avatar URL (`/u/583231?v=4`). Replaced with an assertion on the projection's keys, which is what the claim actually was.

One honest note on the TDD loop: **four of Task 4's eleven tests passed the moment they were written.** Task 3 had to implement `collaborators()` for its "a 403 does not sign you out" test, so the mapping already existed. Seven were red.

`main/index.ts` was confirmed a corpse (Task 7 Step 1) and left alone — it imports `./events/user-stream`, `./reminders/notifier`, `./server-client` and `./session`, none of which exist. That is plan 4.

## Definition of done

- `pnpm exec vitest run --root apps/desktop` green, with the four new suites covering every behaviour above.
- `pnpm -r typecheck` shows **no new errors**. The `github/` modules are new files whose only in-repo dependents are `router.ts` (which typechecks clean today) — so they must typecheck clean too, and the count must not rise above 106.
- No test makes a network request.
- The token appears in no router result, no error message, and no log line.
- ~~`main/github/session.ts`~~ **`main/github/electron.ts`** is the only file in `github/` that imports `electron`, and no test imports it. (Amended — see Outcome 1.)

## Not in this plan

- **The onboarding UI** — the three-act ritual, the code display, the repo picker. Plan 5. This plan gives it everything it needs to call.
- **Cloning the chosen repo and registering the vault.** `cloneRepo` (plan 1) and `VaultRegistry` (already built) both exist; the flow that calls them in order is the orchestrator's, in plan 4.
- **FR-8's seeding** — the `.gitignore`, `.claude/` scaffold and first commit. `createRepo` lands here; what goes *in* the repo belongs with `main/agent/seed-content.ts`, in plan 4.
- **The `.gitignore` check on vault open** (PRD §Edge cases) — a real check, and it belongs where vaults are opened.
- **Caching repo and collaborator lists.** Noted as a gotcha with a home (the router edge); build it when a rate limit is observed rather than before, per the same rule that kept a task index out of `prd/tasks.md`.
- **Fine-grained PAT paste-in** as an alternative to the device flow (PRD §Edge cases). Worth having; not worth a second sign-in path before the first one runs.
- **Multiple accounts** — PRD open question 4, leaning one account per install. Nothing here forbids a second later; nothing here builds one.
- **Reporting a git credential failure as a sign-out** (FR-14's other half), and **surfacing a permission-rejected push as "you no longer have write access"** (FR-13). Both are already possible — `classifyPushFailure` distinguishes the cases and returns `null` when it cannot tell — and both are wiring between the sync orchestrator and `session.signOut()`, which is plan 4.

## Before this can run for real

Not code, and not blocking any task above — every test passes without it. Needed before plan 5's onboarding can sign anyone in:

1. Register a **GitHub OAuth app** (Settings → Developer settings → OAuth Apps).
2. **Enable device flow** on it. This is a checkbox, it is off by default, and without it `POST /login/device/code` returns a 404 that reads like a broken URL.
3. Put its client id in `CLIENT_ID` in `session.ts`, replacing the placeholder.
4. Decide whether the app is owned by `syv-ai` or a personal account — it affects nothing technical here, but it decides who can rotate it.
