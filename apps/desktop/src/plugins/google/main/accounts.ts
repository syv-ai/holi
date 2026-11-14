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
import { GoogleSession, type AccountRef, type GoogleAccount, GOOGLE_SCOPES } from './session'
import { startLoopbackFlow, type Listen, type LoopbackFlow } from './loopback-flow'
import {
  resolveClient,
  sameClient,
  type GoogleClient,
  type GoogleClientSource,
  type GoogleClientStore,
} from './credentials'
import type { GoogleAccounts, GoogleTokenStore, StoredGoogleAuth } from './token-store'
import type { VaultAccountsStore } from './vault-accounts'

const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'

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

export interface GoogleAccountsManager {
  /** Every connected account, for the picker. */
  list(): ConnectedAccount[]
  /** The session this vault should use, or null when it has never connected
   *  or the account it named is gone. Never throws: "not connected" is a
   *  state the UI already renders. */
  sessionFor(remote: string): Promise<GoogleSession | null>
  sessionForSub(sub: string): GoogleSession | null
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
  /** Revoke at Google, drop the record, unlink every vault pointing at it. */
  removeAccount(sub: string): Promise<void>
  /** Fires for a connect, a removal, and a dead grant, naming the account that
   *  changed so a cache can be scoped to it. Null when nothing is connected. */
  onChange(cb: (sub: string | null) => void): () => void
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
  let accounts: GoogleAccounts = await deps.store.read()
  const sessions = new Map<string, GoogleSession>()
  const listeners = new Set<(sub: string | null) => void>()
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
  /** A client change in progress: a connect waits it out rather than starting
   *  under a client about to be replaced. Never rejects. */
  let switching: Promise<void> | null = null
  /** The person's own client, loaded once: main is its only writer. */
  let own: GoogleClient | null = (await deps.clients?.read()) ?? null
  const currentClient = () => resolveClient(own, deps.env)

  const emit = (sub: string | null) => {
    for (const cb of listeners) cb(sub)
  }

  let writes: Promise<void> = Promise.resolve()
  const serialize = (operation: () => Promise<void>): Promise<void> => {
    const write = writes.then(operation)
    writes = write.catch(() => undefined)
    return write
  }
  const persist = (change: (current: GoogleAccounts) => GoogleAccounts): Promise<void> =>
    serialize(async () => {
      const next = change(accounts)
      if (next === accounts) return
      await deps.store.write(next)
      accounts = next
    })
  // A newer consent owns its token before its queued disk write has landed.
  const pendingGrants = new Map<string, { refreshToken: string; epoch: number }>()
  const revokeUnusedGrant = (refreshToken: string): Promise<void> =>
    serialize(async () => {
      if (Object.values(accounts).some((auth) => auth.refreshToken === refreshToken)) return
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
      read: () => (accountEpoch(sub) === grantEpoch ? (accounts[sub] ?? null) : null),
      generation: () => accountEpoch(sub),
      async write(auth, expectedGeneration) {
        if (accounts[sub] === undefined || accountEpoch(sub) !== expectedGeneration) return
        await persist((latest) =>
          latest[sub] === undefined || accountEpoch(sub) !== expectedGeneration
            ? latest
            : { ...latest, [sub]: auth },
        )
      },
      async remove() {
        if (accountEpoch(sub) !== grantEpoch) return
        await dropTokens(sub)
        await deps.vaults.unlinkAccount(sub)
        emit(sub)
      },
      async expire(expectedGeneration) {
        let removed = false
        await persist((current) => {
          const row = current[sub]
          if (row === undefined || accountEpoch(sub) !== expectedGeneration) return current
          const next = { ...current }
          delete next[sub]
          removed = true
          return next
        })
        if (!removed) return
        advanceAccountEpoch(sub)
        sessions.delete(sub)
        await deps.vaults.expireAccount(sub)
        emit(sub)
      },
    }
  }

  const dropTokens = async (sub: string): Promise<void> => {
    advanceAccountEpoch(sub)
    await persist((current) => {
      const next = { ...current }
      delete next[sub]
      return next
    })
    sessions.delete(sub)
  }

  /** Memoized: two vaults on one account must share ONE session, because
   *  `#refreshing` is that session's single-flight latch. */
  const sessionForSub = (sub: string): GoogleSession | null => {
    if (accounts[sub] === undefined) return null
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
      Object.values(accounts).map((a: StoredGoogleAuth) => ({ sub: a.sub, email: a.email })),

    sessionForSub,

    async sessionFor(remote) {
      const sub = await deps.vaults.subFor(remote)
      return sub === null ? null : sessionForSub(sub)
    },

    async connect(remote) {
      await switching
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
        wait: async () => {
          const result = await flow.wait()
          if (result.kind !== 'granted') {
            if (connecting?.id === reservation.id) connecting = null
            return result
          }

          const { tokens } = result
          // A cancel or a client change that arrived while the code was being
          // exchanged: the flow cannot stop a request already sent, so the
          // grant comes back anyway. Keeping it would save an account the
          // person let go of, or one made under a client no longer in use.
          if (
            reservation.cancelled ||
            epoch !== clientEpoch ||
            connecting?.id !== reservation.id ||
            (startingAccountEpochs.get(tokens.sub) ?? 0) !== accountEpoch(tokens.sub)
          ) {
            await revokeUnusedGrant(tokens.refreshToken)
            if (connecting?.id === reservation.id) connecting = null
            return { kind: 'cancelled' } as const
          }
          // Additive: another vault may be using an account already in the store.
          const grantEpoch = advanceAccountEpoch(tokens.sub)
          let accepted = false
          pendingGrants.set(tokens.sub, { refreshToken: tokens.refreshToken, epoch: grantEpoch })
          try {
            await persist((current) => {
              if (
                reservation.cancelled ||
                connecting?.id !== reservation.id ||
                epoch !== clientEpoch ||
                grantEpoch !== accountEpoch(tokens.sub)
              )
                return current
              accepted = true
              return {
                ...current,
                [tokens.sub]: {
                  sub: tokens.sub,
                  email: tokens.email,
                  refreshToken: tokens.refreshToken,
                  accessToken: tokens.accessToken,
                  expiresAt: tokens.expiresAt,
                  scopes: tokens.scopes,
                },
              }
            })
          } finally {
            if (pendingGrants.get(tokens.sub)?.epoch === grantEpoch)
              pendingGrants.delete(tokens.sub)
          }
          if (!accepted) {
            await revokeUnusedGrant(tokens.refreshToken)
            if (connecting?.id === reservation.id) connecting = null
            return { kind: 'cancelled' } as const
          }
          sessions.delete(tokens.sub)
          // A client switch can start while the serialized store write is in
          // flight, after the guard inside persist has already accepted it.
          // Remove only this exact grant generation; never a later reconnect.
          const discardAcceptedGrant = async (): Promise<boolean> => {
            let discarded = false
            await persist((current) => {
              if (accountEpoch(tokens.sub) !== grantEpoch || current[tokens.sub] === undefined)
                return current
              const next = { ...current }
              delete next[tokens.sub]
              discarded = true
              return next
            })
            if (discarded) advanceAccountEpoch(tokens.sub)
            return discarded
          }
          // Verify the operation still owns this link after the serialized disk write.
          if (
            reservation.cancelled ||
            epoch !== clientEpoch ||
            accountEpoch(tokens.sub) !== grantEpoch ||
            accounts[tokens.sub]?.refreshToken !== tokens.refreshToken
          ) {
            await discardAcceptedGrant()
            await revokeUnusedGrant(tokens.refreshToken)
            if (connecting?.id === reservation.id) connecting = null
            return { kind: 'cancelled' } as const
          }
          await deps.vaults.link(remote, tokens.sub)
          if (
            reservation.cancelled ||
            epoch !== clientEpoch ||
            grantEpoch !== accountEpoch(tokens.sub) ||
            accounts[tokens.sub]?.refreshToken !== tokens.refreshToken
          ) {
            if (await discardAcceptedGrant()) await deps.vaults.unlinkVault(remote)
            await revokeUnusedGrant(tokens.refreshToken)
            if (connecting?.id === reservation.id) connecting = null
            return { kind: 'cancelled' } as const
          }
          emit(tokens.sub)
          if (connecting?.id === reservation.id) connecting = null
          return result
        },
      }
      if (connecting?.id === reservation.id)
        connecting = { id: reservation.id, flow, cancel: wrapped.cancel }
      return wrapped
    },

    cancelConnect() {
      cancelFlow()
    },

    async link(remote, sub) {
      if (accounts[sub] === undefined) {
        throw new Error(`that Google account is not connected on this machine (${sub})`)
      }
      await deps.vaults.link(remote, sub)
      emit(sub)
    },

    async unlinkVault(remote) {
      await deps.vaults.unlinkVault(remote)
      emit(null)
    },

    async overview(remote) {
      const links = await deps.vaults.all()
      const sub = links[remote] ?? null
      const stored = sub === null ? undefined : accounts[sub]
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
        if (!sameClient(currentClient(), resolveClient(next, deps.env))) {
          clientEpoch += 1
          cancelFlow()
          const subs = Object.keys(accounts)
          await Promise.all(subs.map((sub) => revokeAccount(sub)))
          for (const sub of subs) await dropAccount(sub)
        }
        await clients.write(next)
        own = next
      })
      switching = change.then(
        () => undefined,
        () => undefined,
      )
      return change
    },
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

  async function revokeAccount(sub: string): Promise<void> {
    const auth = accounts[sub]
    if (auth !== undefined) await revoke(auth.refreshToken)
  }

  async function removeAccount(sub: string): Promise<void> {
    // Invalidate consent/refresh immediately, even before the first disk write.
    // Deletion must still queue behind a write that already accepted this grant.
    advanceAccountEpoch(sub)
    // Revoking server-side is the point: dropping only the local copy leaves a
    // live grant on someone's Google account with nothing in Holi to show for
    // it. A failed revoke still clears locally: the user asked for this, and
    // refusing because Google is unreachable would trap them.
    await revokeAccount(sub)
    await dropAccount(sub)
  }

  async function dropAccount(sub: string): Promise<void> {
    await dropTokens(sub)
    await deps.vaults.unlinkAccount(sub)
    emit(sub)
  }
}
