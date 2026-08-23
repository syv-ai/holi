# Per-vault Google (D87) Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A vault connects to its own Google account, and an agent keeps reading its own vault's mail no matter which vault is on screen.

**Architecture:** `GoogleSession` stops being one machine-wide instance that guesses its account and becomes one instance per `sub`, holding a reference to its own record rather than the whole map. A new `accounts.ts` owns the token store, memoizes those sessions, and resolves `remote → sub → session` through a new `vault-accounts.ts` map. The renderer resolves by active vault; the agent resolves by a vault named in an ops bearer minted per session.

**Tech Stack:** TypeScript, Electron main, `node:sqlite`, `safeStorage`, tRPC, Vitest (`node` project for main, `dom` for renderer).

**Spec:** [`../specs/2026-08-24-per-vault-google-design.md`](../specs/2026-08-24-per-vault-google-design.md)

---

## What the spec settled, restated as constraints

- No storage migration. `google-auth.enc` is already `Record<sub, StoredGoogleAuth>`.
- No migration at all: `google-vault-accounts.json` starts empty, every vault asks on first use, and the stale `google-cache.db` is **deleted** on first launch.
- One cache file per account. Not composite keys, not wipe-on-switch.
- Disconnect is two actions: unlink this vault, or remove the account everywhere.
- `google/` keeps **exactly one** file importing Electron (`electron.ts`). `accounts.ts` must not become the second, or the suite stops running under plain Node.

## Decisions this plan locks (not in the spec)

- **`connect()` moves off `GoogleSession` onto the accounts manager.** A connect creates an account whose `sub` is unknown until the grant returns, so it cannot belong to an object identified by its `sub`. This is the one public-API break; `router.ts:1558` calls `googleSession().connect()` today.
- **`GoogleSession` stops holding the accounts map.** N sessions each holding a copy of the whole map would clobber each other on `store.write`. Each session gets an `AccountRef` — read/write/remove for *its* record — and `accounts.ts` is the sole owner and serialiser.
- **`vault-accounts.ts` reads from disk per call**, matching `calendar-prefs.ts` exactly rather than caching in memory. That file already does a read per agenda call, so it is within the established tolerance, and it removes cache invalidation from a file two processes' worth of code writes.
- **`sessionFor` returns `null` for an unmapped vault**, never throws. "Not connected" is a state the UI already renders; the `google.*` procedures already refuse with a precondition failure when there is no session, and that path is reused verbatim.

## File structure

| File | Responsibility |
|---|---|
| `google/vault-accounts.ts` (create) | `Record<remote, sub>` on disk. Nothing else. |
| `google/accounts.ts` (create) | Owns the token store. Memoizes one `GoogleSession` per `sub`. Resolves `remote → session`. Owns connect, link, unlink, remove. |
| `google/session.ts` (modify) | Per-account. Loses the map and `connect`; keeps refresh, `getAccessToken`, `missingScopes`, `disconnect`. |
| `google/cache.ts` (modify) | `useAccount(sub)` narrows to `ensureShape()` — accounts are separated by file now, schema still needs checking. |
| `google/data.ts` (modify) | Follows the cache rename. |
| `google/ops-server.ts` (modify) | `mintToken(remote)` / `revoke(token)`; ops resolved per request from the token's vault. |
| `google/electron.ts` (modify) | Builds the accounts manager instead of one session. Still the only Electron import in `google/`. |
| `agent/agent-manager.ts` (modify) | Mints the ops bearer at spawn, revokes at teardown. |
| `main/index.ts` (modify) | Wiring; per-`sub` cache memo; deletes the stale `google-cache.db`. |
| `main/router.ts` (modify) | `google.*` resolves by active vault; gains account-list / link / unlink / remove procedures. |
| `renderer/state/google.ts` + `features/google/GoogleConnection.tsx` (modify) | Account picker, and the two disconnects. |

Test commands:

```bash
pnpm -C apps/desktop exec vitest run --project node test/<file>.test.ts
pnpm -C apps/desktop exec vitest run --project dom src/renderer/**/<file>.test.tsx
```

Bare `node`/`npx` do not work in this shell. Always `pnpm exec`. Run every command from the repo root.

---

### Task 1: The vault → account map

**Files:**
- Create: `apps/desktop/src/main/google/vault-accounts.ts`
- Test: `apps/desktop/test/google-vault-accounts.test.ts`

**Contract:**

```ts
export interface VaultAccountsStore {
  /** The account this vault uses, or null for one that has never connected. */
  subFor(remote: string): Promise<string | null>
  /** Snapshot for the settings UI and for `removeAccount`. */
  all(): Promise<Record<string, string>>
  link(remote: string, sub: string): Promise<void>
  /** Forget this vault's choice. The account and its tokens are untouched. */
  unlinkVault(remote: string): Promise<void>
  /** Forget every vault pointing at `sub`. Used when an account is removed. */
  unlinkAccount(sub: string): Promise<void>
}

export function createVaultAccounts(path: string): VaultAccountsStore
```

Follow `calendar-prefs.ts` line for line: read per call, no in-memory copy, `tmp` + `rename` on write, and **a corrupt or unreadable file reads as `{}`**. Drop any entry whose value is not a string, for the reason that file gives — a hand-edit gone wrong should cost one link, not every link.

**Gotchas:**
- Plain JSON, deliberately unencrypted. It holds account ids, not credentials — the same call `calendar-prefs.ts` makes, and its docblock is the argument to copy.
- `remote` is `owner/repo` and goes in as a **key**, unslugged. This is JSON, not a filesystem path; D86's slug does not apply.

- [ ] **Step 1: Write the failing tests**
  - a missing file: `subFor` is null, `all()` is `{}`.
  - `link` then `subFor` returns it; a second `link` for the same remote replaces.
  - two remotes may share one `sub` (the many-to-one the spec requires).
  - `unlinkVault` drops one and leaves the other.
  - `unlinkAccount` drops every remote pointing at that `sub` and leaves remotes pointing elsewhere.
  - corrupt JSON reads as `{}` rather than throwing.
  - a non-string value is dropped and its siblings survive.
  - a crash-safe write: after `link`, no `.tmp` file is left behind.

- [ ] **Step 2: Run and watch it fail**

`pnpm -C apps/desktop exec vitest run --project node test/google-vault-accounts.test.ts`
Expected: FAIL, `createVaultAccounts is not a function`.

- [ ] **Step 3: Implement it**

- [ ] **Step 4: Green**

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/google/vault-accounts.ts apps/desktop/test/google-vault-accounts.test.ts
git commit -m "feat(google): a vault says which account it uses"
```

---

### Task 2: One session per account, and the manager that owns them

The core change. Larger than the others on purpose: splitting it leaves the tree un-typecheckable between commits, because `GoogleSession`'s constructor and `index.ts`'s wiring have to move together.

**Files:**
- Modify: `apps/desktop/src/main/google/session.ts`
- Create: `apps/desktop/src/main/google/accounts.ts`
- Modify: `apps/desktop/src/main/google/electron.ts`, `apps/desktop/src/main/index.ts`, `apps/desktop/src/main/router.ts`
- Test: `apps/desktop/test/google-session.test.ts` (exists), `apps/desktop/test/google-accounts.test.ts` (create)

**Contracts:**

```ts
// session.ts — what a session is handed instead of the whole map.
export interface AccountRef {
  read(): StoredGoogleAuth | null
  write(auth: StoredGoogleAuth): Promise<void>
  remove(): Promise<void>
}

export interface GoogleSessionDeps {
  account: AccountRef          // replaces `store`
  fetch?: typeof globalThis.fetch
  now?: () => number
  clientId?: string
  clientSecret?: string
}

// Unchanged in shape: account, missingScopes, accountSub, getAccessToken,
// disconnect, onChange. `connect` and `static load` are GONE.
export class GoogleSession { constructor(deps: GoogleSessionDeps) }
```

```ts
// accounts.ts — the owner.
export interface GoogleAccountsManager {
  /** email + sub for every connected account, for the picker. */
  list(): { sub: string; email: string }[]
  /** The session this vault should use, or null when it has never connected. */
  sessionFor(remote: string): Promise<GoogleSession | null>
  sessionForSub(sub: string): GoogleSession | null
  /** Full loopback consent, then store the account AND link it to `remote`. */
  connect(remote: string): Promise<LoopbackFlow>
  cancelConnect(): void
  /** Point a vault at an account already in the store. No consent. */
  link(remote: string, sub: string): Promise<void>
  unlinkVault(remote: string): Promise<void>
  /** Revoke at Google, drop from the store, unlink every vault. */
  removeAccount(sub: string): Promise<void>
  /** Fires for a connect, a removal, and a dead grant. Carries the sub so the
   *  cache can be scoped to the account that changed. */
  onChange(cb: (sub: string | null) => void): () => void
}

export function createGoogleAccounts(deps: {
  store: GoogleTokenStore
  listen: Listen
  openBrowser: (url: string) => Promise<void>
  vaults: VaultAccountsStore
  fetch?: typeof globalThis.fetch
  now?: () => number
}): Promise<GoogleAccountsManager>
```

**Gotchas:**
- **`#refreshing` is why sessions are per account, not a `sub` parameter.** It is a single-flight latch; one latch shared across accounts serialises unrelated refreshes and lets one account's failure be observed by another. Memoize the instance, never re-create it per call.
- **`accounts.ts` must not import `electron`.** It is on the test path. `electron.ts` stays the only one, and `google-session.test.ts` failing to load is how you will find out you broke it.
- **`connect` cannot live on a session** — the `sub` is unknown until the grant returns. It stores the account *and* writes the vault link before the returned `wait()` settles, matching the existing promise-wrapping comment: a caller that re-renders on resolution must not beat the write.
- **`disconnect()` on a session still means "revoke and forget this account"**, and it is now reached only through `removeAccount`. Unlinking a vault must never call it.
- `store.write` takes the whole map. The manager holds it and is the only writer; sessions mutate through their `AccountRef`.
- `missingScopes()` and the `SCOPE_ALIASES` logic move unchanged. The bug they exist for (a widened `GOOGLE_SCOPES` against an older grant) is now per account and the existing tests must still pass.

- [ ] **Step 1: Rewrite `google-session.test.ts` onto `AccountRef`**

Every `GoogleSession.load({ store })` becomes a constructor over a fake ref. Keep every existing assertion — refresh-on-expiry, the single-flight latch, `GoogleReconnectRequiredError` on a dead grant, `missingScopes` in both alias directions, revoke-then-forget. Add: a session whose ref reads `null` reports `account === null` and `accountSub === null`.

- [ ] **Step 2: Run and watch it fail**

`pnpm -C apps/desktop exec vitest run --project node test/google-session.test.ts`

- [ ] **Step 3: Rework `session.ts`** — delete `#accounts`, `#current()`, `static load` and `connect`; read through `deps.account`.

- [ ] **Step 4: Green on the session suite**

- [ ] **Step 5: Write `google-accounts.test.ts`**
  - `sessionFor` on an unmapped remote is `null`, and does not throw.
  - two remotes linked to one `sub` get the **same session instance** (the latch).
  - two remotes linked to different subs get different instances.
  - `link` to an unknown `sub` is refused rather than writing a dangling mapping.
  - `unlinkVault` leaves the account in `list()` and leaves a second vault working.
  - `removeAccount` revokes, empties `list()`, and leaves both vaults unmapped.
  - `connect(remote)` stores the account and links the remote before `wait()` resolves.
  - `onChange` fires with the `sub` on connect and on removal, and with `null` when the last account goes.

- [ ] **Step 6: Run and watch it fail**

- [ ] **Step 7: Implement `accounts.ts`**

- [ ] **Step 8: Green**

- [ ] **Step 9: Rewire `electron.ts`, `index.ts` and `router.ts` so the tree typechecks**

`createGoogleSession` becomes `createGoogleAccounts` (same file, same Electron-only role). In `router.ts`, `deps.googleSession` becomes `deps.googleAccounts` and each `google.*` procedure resolves `deps.host.active()?.remote` → `sessionFor(remote)`. The existing "refuse with a clear precondition failure" path is what a `null` session takes; do not invent a second failure mode.

- [ ] **Step 10: Typecheck**

`pnpm -C apps/desktop typecheck` → clean.

- [ ] **Step 11: Commit**

```bash
git commit -am "feat(google): one session per account, and an owner that resolves them"
```

---

### Task 3: One cache file per account

**Files:**
- Modify: `apps/desktop/src/main/google/cache.ts`, `apps/desktop/src/main/google/data.ts`, `apps/desktop/src/main/index.ts`
- Test: `apps/desktop/test/google-cache.test.ts`, `apps/desktop/test/google-data.test.ts`

**Contract:**

```ts
// cache.ts — `useAccount(sub)` is replaced. Accounts are separated by FILE now;
// what remains is the schema check that was doing double duty inside it.
export interface GoogleCache {
  /** Wipes if the stored SHAPE_VERSION differs. Call before first use. */
  ensureShape(): void
  // …everything else unchanged
}
```

In `index.ts`, cache openers are memoized per `sub`:
`google-cache-<sub>.db`, opened on first use for that account and kept.

**Gotchas:**
- **Keep `SHAPE_VERSION`.** It is a schema migration, a different job from account separation, and dropping it with `useAccount` would leave a cache from an older shape being read as current. The `meta.account` row goes; the `meta.shape` row stays.
- **`scopeGoogleCache` keeps its `onChange` wiring and narrows.** The existing comment is the reason and it still holds: it is hung off `onChange` rather than off the disconnect button because `onChange` also fires for a **dead grant**, which is just as much "this mail is no longer yours to hold". Now it forgets the cache of the `sub` that changed, not the only cache.
- `sub` goes into a **filename**. It is a Google numeric-string id, but do not assume — reject anything outside `[A-Za-z0-9_-]` rather than building a path from it.

- [ ] **Step 1: Write the failing tests**
  - `ensureShape` on a fresh db is a no-op that leaves it usable.
  - a db whose `meta.shape` differs is wiped by `ensureShape`.
  - a db whose shape matches is **not** wiped, and rows written before survive (the regression `useAccount` used to cause on every switch).
  - two caches at two paths hold different rows and neither wipes the other.
  - `data.ts`: `forget()` still empties the cache it was given.

- [ ] **Step 2: Run and watch it fail**

`pnpm -C apps/desktop exec vitest run --project node test/google-cache.test.ts test/google-data.test.ts`

- [ ] **Step 3: Implement** — narrow `useAccount` to `ensureShape`, drop the `meta.account` row, memoize the opener in `index.ts`.

- [ ] **Step 4: Green**

- [ ] **Step 5: Delete the stale machine-wide cache in `index.ts`**

Unconditional `rm(join(userDataDir, 'google-cache.db'), { force: true })` at startup, with a comment saying why it is a delete and not a rename: it holds mail for an account no vault is pointed at yet, and leaving it on disk is worse than the re-fetch. `force: true` makes it a no-op on a fresh install.

- [ ] **Step 6: Typecheck and commit**

```bash
git commit -am "feat(google): a cache per account, and the shape check that was hiding inside the account check"
```

---

**Checkpoint.** Main resolves Google per vault. The UI still shows whatever the active vault maps to, which is nothing until Task 6 gives it a way to connect. Stop here for review if you want one.

---

### Task 4: The ops door names its vault

**Files:**
- Modify: `apps/desktop/src/main/google/ops-server.ts`
- Test: `apps/desktop/test/google-ops-server.test.ts`

**Contract:**

```ts
export interface GoogleOpsServer {
  start(): Promise<void>
  stop(): Promise<void>
  port(): number | null
  /** A bearer bound to one vault, for one agent session. */
  mintToken(remote: string): string
  revoke(token: string): void
}

// The single `ops` object becomes a resolver.
export function createGoogleOpsServer(opsFor: (remote: string) => GoogleOps): GoogleOpsServer
```

The `?t=` check becomes a `Map<string, string>` lookup (token → remote). A token not in the map is the same 403 as a wrong token today.

**Gotchas:**
- **The order of the token check and the body read is load-bearing** and must not move. The current comment says it: *"The body is read only after the token has been checked, so an unauthenticated caller never gets to hand this process JSON to parse."*
- **The 400 / 413 / 502 split must survive.** The agent reads those apart — one means "fix the request", the other "Google is unreachable, retry" — and collapsing them makes it retry the one that can never work.
- A vault with no account resolves to an `ops` whose calls fail with a message naming the fix ("this vault has no Google account connected"), **not** a 403. 403 means "you are not allowed to ask"; this is "there is nothing to ask".
- `token()` is gone. Anything still calling it will not typecheck, which is the point.

- [ ] **Step 1: Write the failing tests**
  - a minted token reaches `opsFor` with **its own** remote, while a second token reaches a different one — the per-vault claim, asserted directly.
  - a revoked token gets 403.
  - an unknown token gets 403 and `opsFor` is never called.
  - the 403 happens **before** any body is read (assert with a POST whose body would throw if parsed).
  - a vault with no account gets a 502-class error naming the fix, not a 403.

- [ ] **Step 2: Run and watch it fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Green**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(google): the agent's door is bound to the vault that opened it"
```

---

### Task 5: The agent mints at spawn and revokes at teardown

**Files:**
- Modify: `apps/desktop/src/main/agent/agent-manager.ts`, `apps/desktop/src/main/index.ts`
- Test: `apps/desktop/test/agent-manager.test.ts`

**Contract change on `AgentManagerDeps`:**

```ts
// WAS: googleToken?: () => string | null
/** Mint a bearer for THIS vault, for THIS session (D87). Revoked on teardown,
 *  so a dead session's token stops working. */
mintGoogleToken?: (remote: string) => string | null
revokeGoogleToken?: (token: string) => void
```

`start()` mints after the vault is resolved and puts the result in `buildAgentEnv`'s existing `googleToken`. `teardown()` revokes it and clears it.

**Gotchas:**
- This is the hazard the spec was written around, and it was **found by hand**: an agent session outlives a vault switch. That is exactly why the token is minted per session and not read from a getter — a getter would answer for whatever is active *now*.
- `teardown()` runs at the head of every `start()`, so a restart revokes the old token before minting the new one. Revoking twice must be harmless.
- Keep the env key `HOLI_GOOGLE_TOKEN`. The generated `holi-google` script reads it by name and the send gate (D70) matches on the command text; neither changes.

- [ ] **Step 1: Write the failing tests**
  - the token minted for the active vault's remote lands in `spawn.opts.env.HOLI_GOOGLE_TOKEN`.
  - a second `start()` in another vault mints against **that** remote.
  - `kill()` revokes the token it minted.
  - a restart revokes the first token before the second spawn.
  - no minter supplied (tests, and only tests) → no `HOLI_GOOGLE_TOKEN`, and the spawn still happens.

- [ ] **Step 2: Run and watch it fail**

- [ ] **Step 3: Implement, and rewire `index.ts`**

- [ ] **Step 4: Green**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(agent): the Google bearer is minted per session, for one vault"
```

---

### Task 6: The procedures, and the two disconnects

**Files:**
- Modify: `apps/desktop/src/main/router.ts`
- Test: `apps/desktop/test/router.test.ts`

**New `google.*` procedures:**

| procedure | does |
|---|---|
| `accounts` | `{ sub, email }[]` from `list()`, plus the active vault's current `sub` |
| `useAccount({ sub })` | links the **active vault** to an account already in the store. No consent |
| `disconnectVault` | unlinks the active vault. Tokens untouched |
| `removeAccount({ sub })` | revokes, drops, unlinks everywhere, deletes that cache file |

`connect` / `awaitConnect` / `cancelConnect` keep their names and their two-phase shape; `connect` now links the active vault on grant.

**Gotchas:**
- **`disconnect` is being split, and the old name is the dangerous one.** Whatever `google.disconnect` is called by today must land on `disconnectVault`, not `removeAccount` — the destructive one has to be chosen deliberately. Rename rather than repurpose, so an unmigrated caller fails to typecheck instead of silently revoking.
- Every procedure resolves the active vault through `deps.host.active()?.remote`. No vault open → the existing precondition failure.
- `removeAccount` must delete `google-cache-<sub>.db` too, or the next connect to the same account reads a stale cache.

- [ ] **Step 1: Write the failing tests** — one per row above, plus: `disconnectVault` on a vault sharing an account leaves the other vault's session working, and `removeAccount` takes both down.

- [ ] **Step 2: Run and watch it fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Green**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(google): connect a vault to an account, and unlink without revoking"
```

---

### Task 7: The settings UI

**Files:**
- Modify: `apps/desktop/src/renderer/src/features/google/GoogleConnection.tsx`, `apps/desktop/src/renderer/src/state/google.ts`
- Test: `apps/desktop/src/renderer/src/features/google/__tests__/GoogleConnection.test.tsx` (create)

The panel gains, above the existing connect button:

- **the account this vault uses**, or "No Google account for this vault".
- **a list of accounts already connected on this machine**, each a one-click "Use in this vault" — no consent round trip, because the grant exists.
- **"Connect a different account…"** — today's flow, unchanged.
- **"Disconnect this vault"**, and per account **"Remove from Holi"**, worded so the destructive one reads as destructive.

**Gotchas:**
- **Whether an account is connected lives in `state/google.ts`, not in the component.** The file says so, and says why: a `useState` meant connecting left the chips missing until a reload. The per-vault mapping goes in the same store for the same reason.
- The store must refresh **on a vault switch**, not only on connect. A vault switch changes the answer to "which account is this", and nothing about the account itself changed — so `useGoogleAccount` needs the active remote as a dependency.
- Connecting is still two-phase (`connect` then `awaitConnect`) and unmounting still cancels. Do not simplify it; it mirrors `SignIn` deliberately.
- No em dashes in the copy.

- [ ] **Step 1: Write the failing component tests**
  - a vault with no account renders the empty state and the connected-accounts list.
  - clicking "Use in this vault" calls `useAccount` with that `sub` and updates without a reload.
  - "Disconnect this vault" calls `disconnectVault`, not `removeAccount`.
  - switching the active vault re-reads the mapping.

- [ ] **Step 2: Run and watch it fail**

`pnpm -C apps/desktop exec vitest run --project dom src/renderer/src/features/google/__tests__/GoogleConnection.test.tsx`

- [ ] **Step 3: Implement**

- [ ] **Step 4: Green**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(google): a vault says which account it uses, and says it in settings"
```

---

### Task 8: Full suite, then the app, then the docs

- [ ] **Step 1: Full desktop suite**

`pnpm -C apps/desktop test` — both projects. `typecheck` misses fake-preload gaps, so this runs before anything is called done.

- [ ] **Step 2: Workspace typecheck**

`pnpm typecheck`

- [ ] **Step 3: Verify in the running app**

`pnpm dev:debug`, then drive over CDP (`apps/desktop/cdp.mjs`, port 9333). The five things only a real run shows:
  1. On first launch, `google-vault-accounts.json` is absent or `{}`, `google-cache.db` is gone, and mail in every vault says "no account".
  2. Connecting in one vault links only that vault.
  3. A second vault offers the account with one click and no browser round trip.
  4. Two vaults, two accounts, both caches present as separate files, and switching between them does **not** re-fetch.
  5. An agent spawned in vault A, then the user switches to vault B: `holi-google threads` in that agent still returns **A's** mail. This is the hazard the design exists for and it cannot be tested any other way.

- [ ] **Step 4: Docs**

`docs/decisions.md` D87 goes from *designed, not built* to built, recording what the build settled that the design did not. `docs/prd/google-mail-calendar.md` and `docs/prd/auth-identity.md` both state the machine-level assumption and need correcting; `docs/prd/agent.md` §Tool surface should say the ops bearer is per session and names its vault. Add D87 to `docs/upcoming.md`.

- [ ] **Step 5: Commit**

```bash
git add docs apps && git commit -m "docs: D87 is built, and a vault's Google account is its own"
```

---

## Out of scope, deliberately

- **Per-vault calendar and image-sender preferences.** Both stay keyed to the account, which the spec leaves open on purpose.
- **The bounded cache window shared by two vaults on one account.** Worth measuring before it is worth designing.
- **Anything about D86.** Its config directories are done and this touches none of them.

## Self-review notes

Spec coverage checked section by section: storage (Tasks 1, 3), singleton → resolver (Task 2), renderer resolves by active vault (Tasks 2, 6, 7), agent resolves by ops token (Tasks 4, 5), connect without a second consent (Tasks 2, 6, 7), two-flavoured disconnect (Tasks 2, 6, 7), cache per account with `SHAPE_VERSION` kept (Task 3), no migration plus the stale-db delete (Task 3), and every "must not regress" invariant is pinned by a test named in Tasks 2–5. The three Open questions are listed above as out of scope rather than silently dropped.
