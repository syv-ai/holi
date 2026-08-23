# A vault's Google account is its own

**Date** 2026-08-24 · **Status** designed, not built · **Designs D87**
**Companion to** [`2026-08-23-per-vault-agent-silos-design.md`](2026-08-23-per-vault-agent-silos-design.md) (D86, built 2026-08-23)

D87 was agreed on 2026-08-23 and deliberately left undesigned, on the grounds
that it is the same shape as D86 — "an identity Holi currently holds per machine,
that a vault should hold for itself" — but a separate build. This is that design.

## The problem, unchanged

Google tokens live in `userData/google-auth.enc` (`main/google/electron.ts:25`),
machine-level by D67. Every vault on a machine therefore shows the same Gmail and
the same Calendar. Nobody saw it until a second vault existed, and what it looks
like is a brand-new work vault showing personal mail.

## What reading the code changed

The 2026-08-23 companion listed five costs. Two of them are not costs.

**The token store is already multi-account.** `StoredGoogleAuth` is persisted as
`Record<sub, StoredGoogleAuth>`, and `token-store.ts` says why in as many words:

> A map is the same amount of code as a single record here, and it is the
> difference between "multi-account is an additive change" and "multi-account is
> a storage migration". D67 chose single-account deliberately; it did not choose
> to make the second one expensive.

That bet pays out here. There is **no storage migration**. The single line that
assumes one account is `GoogleSession.#current()` returning
`Object.values(this.#accounts)[0]`, and its own comment already names itself as
the one place the assumption lives.

**`holi-google` needs no change.** It is a shell script that curls
`127.0.0.1:$HOLI_GOOGLE_PORT` with a bearer. It resolves no credentials at all —
it asks main. "The CLI has no notion of which vault it runs for" is true of
*main's answer*, not of the CLI, and it is fixed in main.

What remains genuinely costly is the cache, and one hazard the companion did not
know about.

## The decision

**A vault points at at most one Google account; an account may serve many
vaults.** Not a per-vault toggle over one shared account, which was the cheaper
option and was rejected on 2026-08-23: the ask is genuinely "this vault connects
to that account".

### Storage

| file | change |
|---|---|
| `userData/google-auth.enc` | **unchanged.** Already a map; it stops holding exactly one |
| `userData/google-vault-accounts.json` | **new.** `Record<remote, sub>` |
| `userData/google-cache-<sub>.db` | replaces `google-cache.db`, one per account |

The mapping is **machine-local and outside the vault**, keyed by remote (D60: a
vault's identity is its remote).

It is not in `.holi/settings.local.json`, and that was a real fork. That file
would have reused D85's resolver, its whitelist and its settings rows, and would
have let the agent edit it with ordinary file tools like every other setting.
Against it: the mapping dies with the working copy, so deleting and re-cloning a
vault silently unlinks its account; and every other decision about a *connected
account* already lives in `userData` — the calendar choices, the image-sender
allowances, the tokens themselves — under an argument `index.ts` states plainly
about the image prefs:

> In `userData` beside the calendar choices, not in a vault: this is a decision
> about the connected *account*, and a vault is a shared git repo.

Storage location and UI location are different questions. It is **surfaced in
vault settings**, where a user would look for it.

It is not inside `StoredGoogleAuth` either: that inverts the lookup actually
performed (vault → account) and puts vault identity inside an encrypted
credential blob.

### From a singleton to a resolver

A new `google/accounts.ts` owns the token store and hands out one
`GoogleSession` **per `sub`**, memoized. `GoogleSession` keeps its entire API and
loses only its guess: `#current()` becomes the account it was constructed for.

Per-account instances rather than one session taking a `sub` per call, for one
specific reason: `#refreshing` is a single-flight latch on the refresh, and it is
**per-account state**. One latch shared across accounts would serialise refreshes
that have nothing to do with each other, and a failure in one would be observed
by the other.

Everything then funnels through `sessionFor(remote)` — `mapping[remote]` → that
account's session, or `null` for a vault that has never connected.

### Who resolves how, and why the answers differ

**The renderer resolves by active vault.** Correct there: the UI shows one vault
and re-renders on a switch.

**The agent resolves by the vault named in its ops token.** This is the hazard
the companion did not know about, and it was found by hand while verifying D86 on
2026-08-23: **an agent session outlives a vault switch.** It keeps running against
its original vault's cwd while Holi displays another. Today that is invisible,
because every vault shares one Google account. Per vault it means a backgrounded
agent's next `holi-google` call reads whatever vault is *active* — which is
another vault's mail. That is precisely D87's complaint, arriving late instead of
at birth, and harder to notice because nothing on screen is wrong.

So `createGoogleOpsServer` grows `mintToken(remote)` and `revoke(token)`.
`agent-manager` mints at spawn and revokes at teardown — it already reads
`googleToken()` per spawn, so the seam exists. Every op resolves its vault from
the token it arrived with.

A second benefit worth stating: a token from a dead session stops working. Today
one bearer is minted per app run and is valid for as long as Holi is open.

**The child still gets a door, never a token** (D67). Nothing about that changes;
the door simply knows which room it opens onto.

### Connect and disconnect

Connecting offers the accounts already in the store. Picking one writes the
mapping and nothing else — **no second consent round trip**, because the grant
already exists. "Connect a different account…" runs the full loopback flow, which
is unchanged: PKCE, the system browser, main as sole token authority.

Disconnect is **two actions**, because they are two different things:

- **Disconnect this vault** — drops `mapping[remote]`. Tokens untouched, other
  vaults unaffected.
- **Remove account** — revokes at Google, drops it from the store, deletes its
  cache file, and clears every mapping pointing at it.

Refcounting was rejected: it makes one button mean different things depending on
state the user cannot see.

### The cache

One SQLite file per account, `openGoogleCache` memoized per `sub`.

Rejected: **keying every row by `sub`** (one file, composite primary keys) —
every query and every write changes, and it needs a real schema migration over an
existing cache, to buy a single file handle. And **keeping wipe-on-switch**, which
is free to build and charges the user a full re-fetch of mail and calendar on
every vault switch — worst exactly where two vaults are used side by side, which
is the case D87 exists for.

`useAccount(sub)`'s wipe-on-mismatch is no longer how accounts are kept apart, but
its `SHAPE_VERSION` check stays: that is schema migration, a different job. It
narrows to `ensureShape()`.

`scopeGoogleCache` — hung off `onChange` so that a **dead grant** forgets its
cache and not only a button press — keeps that property and narrows to the
account whose grant died.

## No migration, deliberately

Nothing is mapped on upgrade. `google-vault-accounts.json` starts empty and every
vault asks on first use.

The reconnect is not an OAuth round trip: the existing account is already in
`google-auth.enc`, so the settings UI offers it and picking it writes one line.

This was agreed after the alternatives were drawn. Mapping *every registered
vault* to the existing account would preserve today's behaviour exactly, and was
the initial recommendation; mapping *none* applies the fix retroactively at the
cost of disconnecting a working install. The reframe that dissolved it: only one
vault on the machine matters, and its content is portable, so the convenience
being bought is roughly one click.

The stale `google-cache.db` is **deleted** on first launch rather than renamed. It
holds mail for an account no vault is pointed at yet, and leaving it on disk is
worse than the re-fetch.

**Not writing a migration is the point, not a shortcut.** D86's migration is the
one piece of that build that shipped wrong: it chose the vault by `lastOpenedAt`,
which answers "which vault did you last look at" rather than "which vault used
this", and only running it against a real install caught it before it handed one
vault's history to another. A second guess of the same kind is worth more than
the click it saves.

The consequence is a simplification, not just an omission: **lazy connect becomes
the only path** into a vault's Google account. There is no first-launch special
case to reason about, and no second code path to test.

## What must not regress

Each of these is load-bearing today and is tested:

- The token store **never writes plaintext** — if the platform cannot encrypt,
  `write` throws rather than falling back.
- A file it cannot read is a **disconnect, not a crash**.
- `getAccessToken()` is the **only** way to get one, and single-flights — now per
  account.
- `missingScopes()` still catches a widened `GOOGLE_SCOPES` against an older
  grant, per account.
- The agent gets a **door, never a token** (D67).
- The send gate (D70) still matches on the `holi-google` command text.
- `google/` still has **exactly one file importing Electron** (`electron.ts`), so
  the suite runs under plain Node. `accounts.ts` must not become the second.

## Open

- **A vault whose account is removed** shows "connect a Google account" again,
  the same as a vault that never had one. Whether it should say something
  stronger — that it *had* one — is a UI question left to the build.
- **Two vaults, one account, both syncing** share a cache file and therefore its
  bounded window. Correct (it is one account's mail), but the bound is now
  contended by two vaults' usage patterns. Worth measuring before it is worth
  designing.
- **Per-vault calendar and image-sender preferences.** Both are keyed to the
  account today, which stays right, but `google-calendars.json` picking *which
  calendars show* is arguably a per-vault view rather than a per-account fact.
  Deliberately not decided here.
