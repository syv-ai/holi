/**
 * Who Holi is connected to at Google, and which vault uses whom.
 *
 * This is the owner. It holds the accounts map (**the only thing that does**),
 * hands out one `GoogleSession` per account, and resolves a vault to the session
 * it should use.
 *
 * **`connect` is here rather than on a session**, and that is forced: a connect
 * creates an account whose `sub` is unknown until the grant comes back, so it
 * cannot belong to an object identified by its `sub`.
 *
 * **No `electron` import**, like every file in `google/` except `electron.ts`.
 */
import { createHash, randomUUID } from 'node:crypto'
import { GoogleSession, type AccountRef, type GoogleAccount, GOOGLE_SCOPES } from './session'
import { startLoopbackFlow, type Listen, type LoopbackFlow } from './loopback-flow'
import {
  resolveClient,
  sameClient,
  type GoogleClient,
  type GoogleClientSource,
  type GoogleClientStore,
} from './credentials'
import type { GoogleTokenStore, StoredGoogleAuth } from './token-store'
import type { VaultAccountsStore } from './vault-accounts'

const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'

// Kept in the encrypted row itself, so a restart between token and link writes
// (or after failed cleanup) cannot expose that grant through any vault link.
// The token store preserves row fields on read. Rows without the marker,
// including existing installations' rows, are committed.
type AccountRow = StoredGoogleAuth & { pendingConsent?: true }
type AccountRows = Record<string, AccountRow>

/** What the settings picker needs: enough to name an account, no tokens. */
interface ConnectedAccount extends GoogleAccount {
  sub: string
}

/**
 * A vault's Google connection as Holi knows it without asking Google: a grant
 * Google refuses is dropped at the next call that meets it, and each vault
 * that used it is remembered as needing a reconnect, as is one still linked to
 * an account that is gone.
 */
type GoogleConnectionState = 'connected' | 'missing-scope' | 'needs-reconnect' | 'not-connected'

/** One vault's connection, for its own agent: its account alone, never
 *  another vault's name or account, and no tokens. */
export interface GoogleAccountsOverview {
  remote: string
  state: GoogleConnectionState
  /** The account this vault uses, while it is connected. */
  account:
    | (ConnectedAccount & {
        missingScopes: string[]
        /** How many vaults on this machine besides this one use it. A count,
         *  never their names: vaults are isolated. */
        otherVaults: number
      })
    | null
  client: { id: string; source: GoogleClientSource }
}

type GoogleAccountBinding = {
  session: GoogleSession
  revision: string
  isCurrent(): boolean
}

export interface GoogleAccountsManager {
  /** Every connected account, for the picker. */
  list(): ConnectedAccount[]
  /** The session this vault should use, or null when it has never connected
   *  or the account it named is gone. Never throws: "not connected" is a
   *  state the UI already renders. */
  sessionFor(remote: string): Promise<GoogleSession | null>
  sessionForSub(sub: string): GoogleSession | null
  /** Stable for this link and grant only; a token refresh is not a new grant. */
  bindingFor(remote: string): Promise<GoogleAccountBinding | null>
  /** Full consent, then store the account **and** link it to `remote`. */
  connect(remote: string): Promise<LoopbackFlow>
  cancelConnect(): void
  /** Point a vault at an account already in the store. No consent: the grant
   *  exists, so using it in a second vault is a mapping and nothing more. */
  link(remote: string, sub: string): Promise<void>
  /** Forget this vault's choice. Emphatically not a disconnect. */
  unlinkVault(remote: string): Promise<void>
  /** This vault's connection and its state, the one place that works it out. */
  overview(remote: string): Promise<GoogleAccountsOverview>
  /** Drop the record and its vault links, then try to revoke at Google. */
  removeAccount(sub: string): Promise<void>
  /** Fires for a connect, a removal, and a dead grant, naming the account that
   *  changed so a cache can be scoped to it. Null when nothing is connected. */
  onChange(
    cb: (
      sub: string | null,
      reason: 'connected' | 'expired' | 'removed' | 'unlinked',
    ) => void | Promise<void>,
  ): () => void
  /** The client in use and where it came from. The secret stays in main. */
  client(): { id: string; source: GoogleClientSource }
  /**
   * Set this machine's own client, or `null` to go back to the environment's
   * or the shipped one. **A grant belongs to the client that made it**, so a
   * change that reaches Google as a different client removes every account,
   * revoking each, exactly as `removeAccount` does. Saving the client in use
   * again changes nothing.
   */
  setClient(own: GoogleClient | null): Promise<void>
}

export interface GoogleAccountsDeps {
  store: GoogleTokenStore
  vaults: VaultAccountsStore
  listen: Listen
  openBrowser: (url: string) => Promise<void>
  /** This machine's own client, if the person set one. Without a store
   *  there is no own client and `setClient` refuses. */
  clients?: GoogleClientStore
  /** The environment `resolveClient` reads. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  fetch?: typeof globalThis.fetch
  now?: () => number
}

export async function createGoogleAccounts(
  deps: GoogleAccountsDeps,
): Promise<GoogleAccountsManager> {
  /** The one copy. Sessions reach it through their `AccountRef`, never directly. */
  let accounts: AccountRows = await deps.store.read()
  const sessions = new Map<string, GoogleSession>()
  const listeners = new Set<
    (
      sub: string | null,
      reason: 'connected' | 'expired' | 'removed' | 'unlinked',
    ) => void | Promise<void>
  >()
  let connecting: { id: symbol; flow: LoopbackFlow | null; cancel: () => void } | null = null
  const accountEpochs = new Map<string, number>()
  const accountEpoch = (sub: string) => accountEpochs.get(sub) ?? 0
  const advanceAccountEpoch = (sub: string) => {
    const next = accountEpoch(sub) + 1
    accountEpochs.set(sub, next)
    return next
  }
  /** Bumped by every client change, so a consent that began under the old
   *  client knows its grant is not this machine's to keep. */
  let clientEpoch = 0
  const bindingNamespace = randomUUID()
  /** A client change in progress: a connect waits it out rather than starting
   *  under a client about to be replaced. Never rejects. */
  let switching: Promise<void> | null = null
  /** Non-null from epoch invalidation through publication of the new client.
   * Keep unfinished retirements across failures, including rows whose tokens
   * were deleted but whose vault links still need to be removed. */
  let retiring: Set<string> | null = null
  // A failed removal stays closed until retry; concurrent removals share the
  // same cleanup so neither can unlink or revoke a later grant.
  const removals = new Map<string, { run?: Promise<void>; refreshToken?: string }>()
  const isRetiring = (sub: string) => retiring !== null || removals.has(sub)
  /** The person's own client, loaded once: main is its only writer. */
  let own: GoogleClient | null = (await deps.clients?.read()) ?? null
  const currentClient = () => resolveClient(own, deps.env)

  const emit = async (
    sub: string | null,
    reason: 'connected' | 'expired' | 'removed' | 'unlinked' = 'connected',
  ) => {
    await Promise.all([...listeners].map((cb) => cb(sub, reason)))
  }

  // Serialize local token and vault-link mutations together. In particular a
  // failed consent must retire its links before a newer grant can reuse its sub.
  let writes: Promise<void> = Promise.resolve()
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const write = writes.then(operation)
    writes = write.then(
      () => undefined,
      () => undefined,
    )
    return write
  }
  const writeAccounts = async (next: AccountRows) => {
    await deps.store.write(next)
    accounts = next
  }
  // A newer consent owns its token before its queued disk write has landed.
  const pendingGrants = new Map<string, { refreshToken: string; epoch: number }>()
  const usableAuth = (sub: string): StoredGoogleAuth | undefined => {
    const row = accounts[sub]
    return isRetiring(sub) ||
      row?.pendingConsent ||
      pendingGrants.get(sub)?.epoch === accountEpoch(sub)
      ? undefined
      : row
  }
  const revokeUnusedGrant = (refreshToken: string): Promise<void> =>
    serialize(async () => {
      if (Object.values(accounts).some((auth) => auth.refreshToken === refreshToken)) return
      if ([...removals.values()].some((removal) => removal.refreshToken === refreshToken)) return
      if (
        [...pendingGrants].some(
          ([sub, grant]) =>
            grant.refreshToken === refreshToken && grant.epoch === accountEpoch(sub),
        )
      )
        return
      await revoke(refreshToken)
    })

  /** A session's window onto its own row. Writes go through here so the map has
   *  exactly one writer even while several sessions are refreshing. */
  const refFor = (sub: string): AccountRef => {
    const grantEpoch = accountEpoch(sub)
    return {
      read: () => (accountEpoch(sub) === grantEpoch ? (usableAuth(sub) ?? null) : null),
      generation: () => accountEpoch(sub),
      async write(auth, expectedGeneration) {
        await serialize(async () => {
          if (usableAuth(sub) === undefined || accountEpoch(sub) !== expectedGeneration) return
          await writeAccounts({ ...accounts, [sub]: auth })
        })
      },
      async remove() {
        const removed = await serialize(async () => {
          if (accountEpoch(sub) !== grantEpoch || usableAuth(sub) === undefined) return false
          advanceAccountEpoch(sub)
          await retireLocalAccount(sub)
          return true
        })
        if (removed) await emit(sub)
      },
      async expire(expectedGeneration) {
        const expired = await serialize(async () => {
          if (usableAuth(sub) === undefined || accountEpoch(sub) !== expectedGeneration)
            return false
          await deleteAccountRow(sub)
          // An explicit removal that began during the write owns link cleanup.
          if (removals.has(sub)) return false
          if (accountEpoch(sub) === expectedGeneration) advanceAccountEpoch(sub)
          await deps.vaults.expireAccount(sub)
          return true
        })
        if (expired) await emit(sub, 'expired')
      },
    }
  }

  // Only inside the local writer. Keep an uncommitted row as a durable
  // quarantine until all its links are gone, even if deleting the row fails.
  async function retireLocalAccount(sub: string): Promise<void> {
    const pending = accounts[sub]?.pendingConsent
    if (!pending) await deleteAccountRow(sub)
    await deps.vaults.unlinkAccount(sub)
    if (pending) await deleteAccountRow(sub)
  }

  async function deleteAccountRow(sub: string): Promise<void> {
    if (accounts[sub] !== undefined) {
      const next = { ...accounts }
      delete next[sub]
      await writeAccounts(next)
    }
    sessions.delete(sub)
  }

  /** Memoized: two vaults on one account must share ONE session, because
   *  `#refreshing` is that session's single-flight latch. */
  const sessionForSub = (sub: string): GoogleSession | null => {
    if (usableAuth(sub) === undefined) return null
    let session = sessions.get(sub)
    if (session === undefined) {
      session = new GoogleSession({
        account: refFor(sub),
        client: currentClient,
        fetch: deps.fetch,
        now: deps.now,
      })
      sessions.set(sub, session)
    }
    return session
  }

  return {
    list: () =>
      Object.entries(accounts).flatMap(([sub, { email }]) =>
        usableAuth(sub) === undefined ? [] : [{ sub, email }],
      ),

    sessionForSub,

    async sessionFor(remote) {
      const binding = await deps.vaults.bindingFor(remote)
      // A read that races link cleanup must not lend a later grant through
      // the link that the cleanup just retired.
      return binding.sub === null || !deps.vaults.isCurrentBinding(remote, binding)
        ? null
        : sessionForSub(binding.sub)
    },

    async bindingFor(remote) {
      if (retiring !== null) return null
      const client = clientEpoch
      const binding = await deps.vaults.bindingFor(remote)
      const { sub } = binding
      // The link read yielded: do not pair a new client epoch with a grant
      // that still looks connected while its revocation is in flight.
      if (client !== clientEpoch || sub === null || !deps.vaults.isCurrentBinding(remote, binding))
        return null
      const session = sessionForSub(sub)
      if (!session?.account) return null
      const grant = accountEpoch(sub)
      return {
        session,
        revision: createHash('sha256')
          .update(JSON.stringify([bindingNamespace, remote, sub, binding.revision, grant, client]))
          .digest('hex'),
        isCurrent: () =>
          deps.vaults.isCurrentBinding(remote, binding) &&
          accountEpoch(sub) === grant &&
          clientEpoch === client &&
          sessions.get(sub) === session &&
          session.accountSub === sub,
      }
    },

    async connect(remote) {
      let queued: Promise<void> | null
      do {
        queued = switching
        await queued
      } while (queued !== switching)
      if (retiring !== null) throw new Error('Finish changing the Google client before connecting')
      // Consent is machine-wide: the newest requester owns the one active flow.
      cancelFlow()
      const epoch = clientEpoch
      const startingAccountEpochs = new Map(accountEpochs)
      const reservation = {
        id: Symbol('google-connect'),
        flow: null as LoopbackFlow | null,
        cancelled: false,
      }
      connecting = {
        id: reservation.id,
        flow: null,
        cancel: () => {
          reservation.cancelled = true
          reservation.flow?.cancel()
        },
      }
      const { id, secret } = currentClient()
      let flow: LoopbackFlow
      try {
        flow = await startLoopbackFlow({
          clientId: id,
          clientSecret: secret,
          scopes: GOOGLE_SCOPES,
          listen: deps.listen,
          openBrowser: deps.openBrowser,
          fetch: deps.fetch,
          now: deps.now,
        })
      } catch (error) {
        if (connecting?.id === reservation.id) connecting = null
        throw error
      }
      reservation.flow = flow
      if (reservation.cancelled || connecting?.id !== reservation.id) {
        flow.cancel()
        return { authUrl: flow.authUrl, cancel: () => flow.cancel(), wait: () => flow.wait() }
      }
      let outcome: ReturnType<LoopbackFlow['wait']> | undefined
      const wrapped: LoopbackFlow = {
        authUrl: flow.authUrl,
        cancel: () => {
          reservation.cancelled = true
          if (connecting?.id === reservation.id) connecting = null
          flow.cancel()
        },
        // Wrapped: the tokens are persisted AND the vault is linked before this
        // resolves, so a caller that re-renders on resolution cannot beat the
        // write and show "not connected" for a tick.
        wait: () =>
          (outcome ??= finishConsent().finally(() => {
            if (connecting?.id === reservation.id) connecting = null
          })),
      }
      if (connecting?.id === reservation.id)
        connecting = { id: reservation.id, flow, cancel: wrapped.cancel }
      return wrapped

      async function finishConsent(): ReturnType<LoopbackFlow['wait']> {
        const result = await flow.wait()
        if (result.kind !== 'granted') return result

        const { tokens } = result
        const { sub, refreshToken } = tokens
        const active = () =>
          !reservation.cancelled &&
          connecting?.id === reservation.id &&
          epoch === clientEpoch &&
          !isRetiring(sub)
        // The code exchange may finish after cancellation, replacement, or removal.
        if (!active() || (startingAccountEpochs.get(sub) ?? 0) !== accountEpoch(sub)) {
          await revokeUnusedGrant(refreshToken)
          return { kind: 'cancelled' }
        }
        const grantEpoch = advanceAccountEpoch(sub)
        if (!(await commitConsent(remote, tokens, grantEpoch, active))) return { kind: 'cancelled' }
        if (isRetiring(sub) || epoch !== clientEpoch || accountEpoch(sub) !== grantEpoch)
          return { kind: 'cancelled' }
        await emit(sub)
        return result
      }
    },

    cancelConnect() {
      cancelFlow()
    },

    async link(remote, sub) {
      const grant = accountEpoch(sub)
      const requireGrant = () => {
        if (usableAuth(sub) === undefined || accountEpoch(sub) !== grant) {
          throw new Error(`that Google account is not connected on this machine (${sub})`)
        }
      }
      requireGrant()
      await serialize(async () => {
        requireGrant()
        await deps.vaults.link(remote, sub)
      })
      await emit(sub)
    },

    async unlinkVault(remote) {
      await serialize(() => deps.vaults.unlinkVault(remote))
      await emit(null, 'unlinked')
    },

    async overview(remote) {
      const links = await deps.vaults.all()
      const sub = links[remote] ?? null
      const stored = sub === null ? undefined : usableAuth(sub)
      const { id, source } = currentClient()
      const client = { id, source }
      if (sub === null || stored === undefined) {
        return {
          remote,
          state:
            sub !== null || (await deps.vaults.needsReconnect(remote))
              ? 'needs-reconnect'
              : 'not-connected',
          account: null,
          client,
        }
      }
      const missingScopes = sessionForSub(sub)?.missingScopes() ?? []
      return {
        remote,
        state: missingScopes.length > 0 ? 'missing-scope' : 'connected',
        account: {
          sub,
          email: stored.email,
          missingScopes,
          otherVaults: Object.entries(links).filter(([r, s]) => r !== remote && s === sub).length,
        },
        client,
      }
    },

    removeAccount,

    onChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },

    client() {
      const { id, source } = currentClient()
      return { id, source }
    },

    setClient(next) {
      const clients = deps.clients
      if (clients === undefined)
        return Promise.reject(new Error('no store for an own Google client'))
      const change = (switching ?? Promise.resolve()).then(async () => {
        if (retiring !== null || !sameClient(currentClient(), resolveClient(next, deps.env))) {
          const remaining = (retiring ??= new Set<string>())
          clientEpoch += 1
          cancelFlow()
          // The epoch and gate stop later callbacks before they write. Drain
          // the writer before taking inventory: a consent that already passed
          // its guard can land a brand-new row or link while we are switching clients.
          await writes
          for (const sub of Object.keys(accounts)) remaining.add(sub)
          for (const sub of removals.keys()) remaining.add(sub)
          for (const sub of remaining) {
            await removeAccount(sub)
            remaining.delete(sub)
          }
        }
        try {
          await clients.write(next)
          own = next
        } finally {
          // If saving the client fails after retirement, there are no old
          // grants to bind. Consent can safely use the unchanged client.
          if (retiring?.size === 0) retiring = null
        }
      })
      switching = change.then(
        () => undefined,
        () => undefined,
      )
      return change
    },
  }

  async function commitConsent(
    remote: string,
    tokens: StoredGoogleAuth,
    grantEpoch: number,
    active: () => boolean,
  ): Promise<boolean> {
    const { sub, refreshToken } = tokens
    const stillOwned = () => active() && accountEpoch(sub) === grantEpoch
    pendingGrants.set(sub, { refreshToken, epoch: grantEpoch })
    sessions.delete(sub)
    const unused = new Set([refreshToken])
    try {
      return await serialize(async () => {
        if (!stillOwned()) return false
        const abandoned = accounts[sub]
        if (abandoned?.pendingConsent) {
          // Never reactivate an abandoned link by overwriting its quarantined row.
          await retireLocalAccount(sub)
          unused.add(abandoned.refreshToken)
          if (!stillOwned()) return false
        }
        await writeAccounts({ ...accounts, [sub]: { ...tokens, pendingConsent: true } })
        try {
          if (stillOwned()) {
            await deps.vaults.link(remote, sub)
            if (stillOwned()) {
              // Once the link has succeeded, starting this atomic write commits
              // consent. Removal and client replacement drain it before retiring.
              await writeAccounts({ ...accounts, [sub]: tokens })
              unused.delete(refreshToken)
              return true
            }
          }
        } catch (error) {
          try {
            if (!isRetiring(sub)) await retireLocalAccount(sub)
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              'Could not finish or retire Google consent',
            )
          }
          throw error
        }
        // An explicit account/client retirement takes over any staged row.
        if (!isRetiring(sub)) await retireLocalAccount(sub)
        return false
      })
    } finally {
      if (pendingGrants.get(sub)?.epoch === grantEpoch) pendingGrants.delete(sub)
      for (const token of unused) await revokeUnusedGrant(token)
    }
  }

  function cancelFlow(): void {
    const active = connecting
    connecting = null
    active?.cancel()
  }

  /** Revoking needs only the token, so it works whatever the client. A failed
   *  revoke is swallowed: see `removeAccount`. */
  async function revoke(refreshToken: string): Promise<void> {
    await (deps.fetch ?? globalThis.fetch)(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }).toString(),
    }).catch(() => undefined)
  }

  function removeAccount(sub: string): Promise<void> {
    const removal = removals.get(sub) ?? {}
    if (removal.run !== undefined) return removal.run
    removals.set(sub, removal)
    advanceAccountEpoch(sub)
    pendingGrants.delete(sub)
    const run = async () => {
      // Capture the latest durable grant, including a consent or rotation
      // whose disk write was already in flight. Retire it locally before any
      // network wait so a restart cannot lend it to a surviving vault link.
      await serialize(async () => {
        const auth = accounts[sub]
        if (auth !== undefined) removal.refreshToken = auth.refreshToken
        await retireLocalAccount(sub)
      })
      if (removal.refreshToken !== undefined) {
        await revoke(removal.refreshToken)
        delete removal.refreshToken
      }
      await emit(sub, 'removed')
      // Consent started during this removal is stale too. New consent must
      // start after the old grant and its links have both been retired.
      advanceAccountEpoch(sub)
      removals.delete(sub)
    }
    removal.run = run().finally(() => {
      delete removal.run
    })
    return removal.run
  }
}
