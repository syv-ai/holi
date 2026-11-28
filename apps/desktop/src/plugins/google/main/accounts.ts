import { googleConnectionId } from './connection-id'
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
  /** Only connections explicitly owned by this vault. */
  list(remote: string): ConnectedAccount[]
  legacyConnection(remote: string): { accountSub: string; connectionId: string } | null
  /** The session this vault should use, or null when it has never connected
   *  or the account it named is gone. Never throws: "not connected" is a
   *  state the UI already renders. */
  sessionFor(remote: string): Promise<GoogleSession | null>
  sessionForSub(sub: string): GoogleSession | null
  /** Full consent, then store the account **and** link it to `remote`. */
  connect(remote: string): Promise<LoopbackFlow>
  cancelConnect(remote: string): void
  /** Validate an existing owned choice. New ownership requires native consent. */
  link(remote: string, sub: string): Promise<void>
  /** Forget this vault's choice. Emphatically not a disconnect. */
  unlinkVault(remote: string): Promise<void>
  /** This vault's connection and its state, the one place that works it out. */
  overview(remote: string): Promise<GoogleAccountsOverview>
  /** Remove only this connection; revoke a physical grant only after its last owner leaves. */
  removeAccount(remote: string, sub: string): Promise<void>
  /** Fires for a connect, a removal, and a dead grant, naming the account that
   *  changed so a cache can be scoped to it. Null when nothing is connected. */
  onChange(
    cb: (
      sub: string | null,
      reason: 'connected' | 'expired' | 'removed' | 'unlinked',
    ) => void | Promise<void>,
  ): () => void
  /** The client in use and where it came from. The secret stays in main. */
  client(remote: string): Promise<{ id: string; source: GoogleClientSource }>
  /** Set this vault's future-connect client, or null for environment/shipped. */
  setClient(remote: string, own: GoogleClient | null): Promise<void>
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
  const listeners = new Set<
    (
      sub: string | null,
      reason: 'connected' | 'expired' | 'removed' | 'unlinked',
    ) => void | Promise<void>
  >()
  let connectRequest = 0
  let requestingRemote: string | null = null
  let connecting: {
    id: symbol
    clientId: string
    remote: string
    settled: Promise<void>
    flow: LoopbackFlow | null
    cancel: () => void
  } | null = null
  const accountEpochs = new Map<string, number>()
  const accountEpoch = (sub: string) => accountEpochs.get(sub) ?? 0
  const advanceAccountEpoch = (sub: string) => {
    const next = accountEpoch(sub) + 1
    accountEpochs.set(sub, next)
    return next
  }
  /** Bumped by every client change, so a consent that began under the old
   *  client knows its grant is not this machine's to keep. */
  const clientEpochs = new Map<string, number>()
  /** A client change in progress: a connect waits it out rather than starting
   *  under a client about to be replaced. Never rejects. */
  let switching: Promise<void> | null = null
  const own: GoogleClient | null = (await deps.clients?.read()) ?? null
  const vaultClients = new Map<string, GoogleClient | null>()
  const loadedVaultClients = new Set<string>()
  const ensureVaultClient = async (remote: string): Promise<void> => {
    if (loadedVaultClients.has(remote)) return
    const client = await deps.clients?.readVault(remote)
    if (loadedVaultClients.has(remote)) return
    vaultClients.set(remote, client ?? null)
    loadedVaultClients.add(remote)
  }
  const currentClient = (remote: string) =>
    resolveClient(vaultClients.get(remote) ?? null, deps.env)
  const emit = async (
    sub: string | null,
    reason: 'connected' | 'expired' | 'removed' | 'unlinked' = 'connected',
  ) => {
    const ids =
      sub === null
        ? [null]
        : [...connections.values()]
            .filter((connection) => connection.grant === sub)
            .map((connection) => connection.id)
    for (const id of ids) await notify(id, reason)
  }

  let writes: Promise<void> = Promise.resolve()
  let revoking: Promise<void> | null = null
  const serialize = (operation: () => Promise<void>): Promise<void> => {
    const write = writes.then(operation)
    writes = write.catch(() => undefined)
    return write
  }
  // Legacy records belong to the effective client at startup, even if a later
  // default change fails. Pin them durably before that default can change.
  const legacyClient = resolveClient(own, deps.env)
  const grantClient = (auth: StoredGoogleAuth) => auth.client ?? legacyClient
  const issuingClient = (auth: StoredGoogleAuth, remote: string) =>
    auth.issuingClients?.[remote] ?? grantClient(auth)
  type Connection = { grant: string; id: string; session?: GoogleSession; physical?: GoogleSession }
  const connections = new Map<string, Connection>()
  const vaultEpochs = new Map<string, number>()
  const notify = async (
    id: string | null,
    reason: 'connected' | 'expired' | 'removed' | 'unlinked',
  ) => {
    await Promise.all([...listeners].map((cb) => cb(id, reason)))
  }
  const physicalKey = (auth: StoredGoogleAuth) =>
    googleConnectionId('$grant', grantClient(auth).id, auth.sub)
  const pinned = Object.fromEntries(
    Object.values(accounts).map((auth) => [
      physicalKey(auth),
      { ...auth, client: grantClient(auth) },
    ]),
  )
  if (
    Object.entries(accounts).some(
      ([key, auth]) => key !== physicalKey(auth) || auth.client === undefined,
    )
  ) {
    await deps.store.write(pinned)
    accounts = pinned
  }
  const links = await deps.vaults.all()
  for (const [remote, selected] of Object.entries(links)) {
    const candidates = Object.entries(accounts).filter(
      ([, auth]) =>
        googleConnectionId(remote, grantClient(auth).id, auth.sub) === selected ||
        auth.sub === selected,
    )
    if (candidates.length !== 1) continue
    const [grant, auth] = candidates[0]!
    const id = googleConnectionId(remote, grantClient(auth).id, auth.sub)
    if (selected === auth.sub && !auth.legacyVaults?.includes(remote)) {
      const migrated = {
        ...accounts,
        [grant]: { ...auth, legacyVaults: [...(auth.legacyVaults ?? []), remote] },
      }
      await deps.store.write(migrated)
      accounts = migrated
    }
    if (deps.clients && !(await deps.clients.hasVault(remote)))
      await deps.clients.writeVault(remote, own)
    await ensureVaultClient(remote)
    if (selected !== id) await deps.vaults.link(remote, id)
    connections.set(remote, { grant, id })
  }
  const retireGrantLinks = async (grant: string, reason: 'expired' | 'removed') => {
    for (const [remote, connection] of [...connections]) {
      if (connection.grant !== grant) continue
      connections.delete(remote)
      if (reason === 'expired') await deps.vaults.expireAccount(connection.id)
      else await deps.vaults.unlinkVault(remote)
      await notify(connection.id, reason)
    }
  }
  const persist = (change: (current: GoogleAccounts) => GoogleAccounts): Promise<void> =>
    serialize(async () => {
      const next = change(accounts)
      if (next === accounts) return
      await deps.store.write(next)
      accounts = next
    })
  // A newer consent owns its token before its queued disk write has landed.
  const pendingGrants = new Map<
    string,
    { refreshToken: string; clientId: string; epoch: number; owner: symbol }
  >()
  const revokeUnusedGrant = async (
    refreshToken: string,
    accountSub: string,
    clientId: string,
    owner: symbol,
  ): Promise<void> => {
    for (;;) {
      let later: Promise<void> | undefined
      await serialize(async () => {
        // A later exchange may have issued tokens before its response arrived.
        // Re-check at admission, then wait outside the token-write hold.
        if (connecting !== null && connecting.id !== owner && connecting.clientId === clientId) {
          later = connecting.settled
          return
        }
        if (Object.values(accounts).some((auth) => auth.refreshToken === refreshToken)) return
        const existing = accounts[accountSub]
        if (existing !== undefined && grantClient(existing).id === clientId) return
        if (
          [...pendingGrants].some(
            ([sub, grant]) =>
              (grant.refreshToken === refreshToken ||
                (sub === accountSub && grant.clientId === clientId)) &&
              grant.epoch === accountEpoch(sub) &&
              grant.owner === connecting?.id,
          )
        )
          return
        await revoke(refreshToken)
      })
      if (later === undefined) return
      await later
    }
  }

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
            : {
                ...latest,
                [sub]: {
                  ...latest[sub],
                  accessToken: auth.accessToken,
                  expiresAt: auth.expiresAt,
                  refreshToken: auth.refreshToken,
                },
              },
        )
      },
      async remove() {
        if (accountEpoch(sub) !== grantEpoch) return
        await dropTokens(sub)
        await retireGrantLinks(sub, 'removed')
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
        await retireGrantLinks(sub, 'expired')
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

  /** One physical session per issuing client and Google subject owns token refresh. */
  const physicalSession = (sub: string): GoogleSession | null => {
    if (accounts[sub] === undefined) return null
    let session = sessions.get(sub)
    if (session === undefined) {
      session = new GoogleSession({
        account: refFor(sub),
        client: () => grantClient(accounts[sub]!),
        fetch: deps.fetch,
        now: deps.now,
      })
      sessions.set(sub, session)
    }
    return session
  }

  const scopedSession = (remote: string): GoogleSession | null => {
    const connection = connections.get(remote)
    if (!connection) return null
    const physical = physicalSession(connection.grant)
    if (!physical) return null
    if (connection.physical !== physical) {
      connection.physical = physical
      connection.session = physical.scoped(
        connection.id,
        () => connections.get(remote) === connection,
        () => unlinkVault(remote),
        () => issuingClient(accounts[connection.grant]!, remote),
      )
    }
    return connection.session ?? null
  }
  const unlinkVault = async (remote: string): Promise<void> => {
    if (connecting?.remote === remote) cancelFlow()
    vaultEpochs.set(remote, (vaultEpochs.get(remote) ?? 0) + 1)
    const previous = connections.get(remote)
    connections.delete(remote)
    try {
      await deps.vaults.unlinkVault(remote)
    } catch (error) {
      if (previous) connections.set(remote, { grant: previous.grant, id: previous.id })
      throw error
    }
    await notify(previous?.id ?? null, 'unlinked')
  }
  return {
    list: (remote) => {
      const connection = connections.get(remote)
      const auth = connection && accounts[connection.grant]
      return auth && connection ? [{ sub: connection.id, email: auth.email }] : []
    },
    legacyConnection(remote) {
      const connection = connections.get(remote)
      const auth = connection && accounts[connection.grant]
      return auth?.legacyVaults?.includes(remote) && connection
        ? { accountSub: auth.sub, connectionId: connection.id }
        : null
    },
    sessionForSub(id) {
      for (const [remote, connection] of connections)
        if (connection.id === id) return scopedSession(remote)
      return null
    },
    async sessionFor(remote) {
      return scopedSession(remote)
    },

    async connect(remote) {
      const request = ++connectRequest
      requestingRemote = remote
      const epoch = clientEpochs.get(remote) ?? 0
      const startingVaultEpoch = vaultEpochs.get(remote) ?? 0
      await ensureVaultClient(remote)
      let awaited: Promise<void> | null
      let revoked: Promise<void> | null
      do {
        awaited = switching
        revoked = revoking
        await Promise.all([awaited, revoked])
      } while (awaited !== switching || revoked !== revoking)
      if (
        request !== connectRequest ||
        epoch !== (clientEpochs.get(remote) ?? 0) ||
        startingVaultEpoch !== (vaultEpochs.get(remote) ?? 0)
      )
        throw new Error('Google consent was cancelled before it started')
      // Consent is machine-wide: the newest requester owns the one active flow.
      cancelFlow()
      const startingAccountEpochs = new Map(accountEpochs)
      if (deps.clients && !(await deps.clients.hasVault(remote)))
        await deps.clients.writeVault(remote, vaultClients.get(remote) ?? null)
      if (
        request !== connectRequest ||
        epoch !== (clientEpochs.get(remote) ?? 0) ||
        startingVaultEpoch !== (vaultEpochs.get(remote) ?? 0)
      )
        throw new Error('Google consent was cancelled before it started')
      const consentClient = currentClient(remote)
      const { id, secret } = consentClient
      let settle!: () => void
      const settled = new Promise<void>((resolve) => {
        settle = resolve
      })
      const reservation = {
        id: Symbol('google-connect'),
        flow: null as LoopbackFlow | null,
        cancelled: false,
      }
      connecting = {
        id: reservation.id,
        clientId: id,
        remote,
        settled,
        flow: null,
        cancel: () => {
          reservation.cancelled = true
          reservation.flow?.cancel()
        },
      }
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
        settle()
        throw error
      }
      reservation.flow = flow
      if (reservation.cancelled || connecting?.id !== reservation.id) {
        flow.cancel()
      }
      const complete = async () => {
        const result = await flow.wait()
        if (result.kind !== 'granted') {
          if (connecting?.id === reservation.id) connecting = null
          return result
        }

        const { tokens } = result
        const sub = googleConnectionId('$grant', id, tokens.sub)
        const connectionId = googleConnectionId(remote, id, tokens.sub)
        const stale = () =>
          request !== connectRequest ||
          reservation.cancelled ||
          startingVaultEpoch !== (vaultEpochs.get(remote) ?? 0) ||
          epoch !== (clientEpochs.get(remote) ?? 0) ||
          connecting?.id !== reservation.id ||
          (startingAccountEpochs.get(sub) ?? 0) !== accountEpoch(sub)
        if (stale()) {
          await revokeUnusedGrant(tokens.refreshToken, sub, id, reservation.id)
          return { kind: 'cancelled' } as const
        }
        let accepted = false
        let uncertain = false
        pendingGrants.set(sub, {
          refreshToken: tokens.refreshToken,
          clientId: id,
          epoch: accountEpoch(sub),
          owner: reservation.id,
        })
        try {
          await serialize(async () => {
            if (stale()) return
            const prior = accounts[sub]
            const next = {
              ...accounts,
              [sub]: {
                sub: tokens.sub,
                legacyVaults: prior?.legacyVaults,
                email: tokens.email,
                refreshToken: tokens.refreshToken,
                accessToken: tokens.accessToken,
                expiresAt: tokens.expiresAt,
                scopes: tokens.scopes,
                client: prior === undefined ? consentClient : grantClient(prior),
                issuingClients: {
                  ...prior?.issuingClients,
                  ...Object.fromEntries(
                    [...connections].flatMap(([owner, connection]) =>
                      owner !== remote && connection.grant === sub && prior !== undefined
                        ? [[owner, issuingClient(prior, owner)]]
                        : [],
                    ),
                  ),
                  [remote]: consentClient,
                },
              },
            }
            await deps.store.write(next)
            let undoLink: (() => Promise<void>) | undefined
            try {
              if (stale()) return
              undoLink = await deps.vaults.link(remote, connectionId)
              if (stale()) return
              accounts = next
              connections.set(remote, { grant: sub, id: connectionId })
              advanceAccountEpoch(sub)
              sessions.delete(sub)
              accepted = true
            } finally {
              if (!accepted) {
                try {
                  await undoLink?.()
                  await deps.store.write(accounts)
                } catch (error) {
                  // The staged grant may still be durable. Keep it owned,
                  // notify data handles, and never revoke uncertain tokens.
                  accounts = next
                  advanceAccountEpoch(sub)
                  sessions.delete(sub)
                  uncertain = true
                  await emit(sub)
                  throw error
                }
              }
            }
          })
        } finally {
          if (pendingGrants.get(sub)?.owner === reservation.id) pendingGrants.delete(sub)
          if (!accepted && !uncertain)
            await revokeUnusedGrant(tokens.refreshToken, sub, id, reservation.id)
          if (connecting?.id === reservation.id) connecting = null
        }
        if (!accepted) return { kind: 'cancelled' } as const
        await emit(sub)
        return result
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
        wait: () => completion,
      }
      if (connecting?.id === reservation.id)
        connecting = {
          id: reservation.id,
          clientId: id,
          remote,
          settled,
          flow,
          cancel: wrapped.cancel,
        }
      const completion = complete()
      const finished = () => {
        if (connecting?.id === reservation.id) connecting = null
        settle()
      }
      void completion.then(finished, finished)
      return wrapped
    },

    cancelConnect(remote) {
      if (requestingRemote === remote) connectRequest++
      if (connecting?.remote === remote) cancelFlow()
    },

    async link(remote, sub) {
      const connection = connections.get(remote)
      if (!connection || connection.id !== sub || !accounts[connection.grant])
        throw new Error('that Google connection does not belong to this vault')
    },
    unlinkVault,

    async overview(remote) {
      await ensureVaultClient(remote)
      const selected = connections.get(remote)
      const sub = selected?.id ?? null
      const stored = selected ? accounts[selected.grant] : undefined
      const { id, source } =
        stored === undefined ? currentClient(remote) : issuingClient(stored, remote)
      const client = { id, source }
      if (sub === null || stored === undefined) {
        return {
          remote,
          state:
            sub !== null ||
            (await deps.vaults.subFor(remote)) !== null ||
            (await deps.vaults.needsReconnect(remote))
              ? 'needs-reconnect'
              : 'not-connected',
          account: null,
          client,
        }
      }
      const missingScopes = scopedSession(remote)?.missingScopes() ?? []
      return {
        remote,
        state: missingScopes.length > 0 ? 'missing-scope' : 'connected',
        account: {
          sub,
          email: stored.email,
          missingScopes,
          otherVaults: 0,
        },
        client,
      }
    },

    async removeAccount(remote, id) {
      const connection = connections.get(remote)
      if (!connection || connection.id !== id)
        throw new Error('that Google connection does not belong to this vault')
      await unlinkVault(remote)
      if (![...connections.values()].some((other) => other.grant === connection.grant))
        await removeAccount(connection.grant)
      await notify(id, 'removed')
    },

    onChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },

    async client(remote) {
      await ensureVaultClient(remote)
      const { id, source } = currentClient(remote)
      return { id, source }
    },

    async setClient(remote, next) {
      const clients = deps.clients
      if (clients === undefined)
        return Promise.reject(new Error('no store for an own Google client'))
      const epoch = clientEpochs.get(remote) ?? 0
      clientEpochs.set(remote, epoch + 1)
      await ensureVaultClient(remote)
      if (connecting?.remote === remote) cancelFlow()
      const change = (switching ?? Promise.resolve()).then(() =>
        serialize(async () => {
          const replacement = resolveClient(next, deps.env)
          const pinned = Object.fromEntries(
            Object.entries(accounts).map(([sub, auth]) => [
              sub,
              { ...auth, client: grantClient(auth) },
            ]),
          )
          // Pin legacy provenance independently: even a rejected default save
          // must not reinterpret an old grant using a later startup default.
          const selectedSub = connections.get(remote)?.grant
          const migrated = Object.fromEntries(
            Object.entries(pinned).map(([sub, auth]) => {
              const issuingClients = { ...auth.issuingClients }
              if (sub === selectedSub && auth.client.id === replacement.id) {
                issuingClients[remote] = replacement
              }
              return [sub, { ...auth, issuingClients }]
            }),
          )
          await deps.store.write(migrated)
          try {
            await clients.writeVault(remote, next)
          } catch (error) {
            await deps.store.write(pinned)
            throw error
          }
          accounts = migrated
          vaultClients.set(remote, next)
          loadedVaultClients.add(remote)
        }),
      )
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
    const previous = revoking
    const request = (previous ?? Promise.resolve()).then(async () => {
      await (deps.fetch ?? globalThis.fetch)(REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: refreshToken }).toString(),
        signal: AbortSignal.timeout(30_000),
      }).catch(() => undefined)
    })
    revoking = request.catch(() => undefined)
    await revoking
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
    await retireGrantLinks(sub, 'removed')
  }
}
