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
export interface ConnectedAccount extends GoogleAccount {
  sub: string
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
  let connecting: LoopbackFlow | null = null
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

  const persist = async (next: GoogleAccounts): Promise<void> => {
    accounts = next
    await deps.store.write(accounts)
  }

  /** A session's window onto its own row. Writes go through here so the map has
   *  exactly one writer even while several sessions are refreshing. */
  const refFor = (sub: string): AccountRef => ({
    read: () => accounts[sub] ?? null,
    async write(auth) {
      // A refresh that was in flight when the account was removed must not
      // bring it back: the grant is revoked and the vaults unlinked.
      if (accounts[sub] === undefined) return
      await persist({ ...accounts, [sub]: auth })
    },
    async remove() {
      const next = { ...accounts }
      delete next[sub]
      // A dead grant reaches here (session.#refresh on a 400), so the cache
      // scoping hung off `onChange` fires for it too, not only for a button.
      await persist(next)
      sessions.delete(sub)
      await deps.vaults.unlinkAccount(sub)
      emit(sub)
    },
  })

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
      const epoch = clientEpoch
      const { id, secret } = currentClient()
      let cancelled = false
      const flow = await startLoopbackFlow({
        clientId: id,
        clientSecret: secret,
        scopes: GOOGLE_SCOPES,
        listen: deps.listen,
        openBrowser: deps.openBrowser,
        fetch: deps.fetch,
        now: deps.now,
      })
      const wrapped: LoopbackFlow = {
        authUrl: flow.authUrl,
        cancel: () => {
          cancelled = true
          connecting = null
          flow.cancel()
        },
        // Wrapped: the tokens are persisted AND the vault is linked before this
        // resolves, so a caller that re-renders on resolution cannot beat the
        // write and show "not connected" for a tick.
        wait: async () => {
          const result = await flow.wait()
          if (connecting === wrapped) connecting = null
          if (result.kind !== 'granted') return result

          const { tokens } = result
          // A cancel or a client change that arrived while the code was being
          // exchanged: the flow cannot stop a request already sent, so the
          // grant comes back anyway. Keeping it would save an account the
          // person let go of, or one made under a client no longer in use.
          if (cancelled || epoch !== clientEpoch) {
            await revoke(tokens.refreshToken)
            return { kind: 'cancelled' } as const
          }
          // Additive: another vault may be using an account already in the store.
          await persist({
            ...accounts,
            [tokens.sub]: {
              sub: tokens.sub,
              email: tokens.email,
              refreshToken: tokens.refreshToken,
              accessToken: tokens.accessToken,
              expiresAt: tokens.expiresAt,
              scopes: tokens.scopes,
            },
          })
          // A reconnect as the same account must pick up the new grant, not the
          // session built over the old row.
          sessions.delete(tokens.sub)
          await deps.vaults.link(remote, tokens.sub)
          emit(tokens.sub)
          return result
        },
      }
      connecting = wrapped
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

    removeAccount,

    onChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },

    client() {
      const { id, source } = currentClient()
      return { id, source }
    },

    async setClient(next) {
      const clients = deps.clients
      if (clients === undefined) throw new Error('no store for an own Google client')
      await switching
      const change = (async () => {
        if (!sameClient(currentClient(), resolveClient(next, deps.env))) {
          // Every grant here was made under the client being replaced, and a
          // consent in flight would land one more. They go BEFORE the switch:
          // a refresh meanwhile still presents the client its grant belongs
          // to, rather than meeting a 400 under the new one and dropping the
          // account unrevoked.
          clientEpoch += 1
          cancelFlow()
          const subs = Object.keys(accounts)
          await Promise.all(subs.map((sub) => revokeAccount(sub)))
          // One at a time: each write is the whole store.
          for (const sub of subs) await dropAccount(sub)
        }
        await clients.write(next)
        own = next
      })()
      const latch = change.then(
        () => undefined,
        () => undefined,
      )
      switching = latch
      try {
        await change
      } finally {
        if (switching === latch) switching = null
      }
    },
  }

  function cancelFlow(): void {
    connecting?.cancel()
    connecting = null
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
    if (accounts[sub] === undefined) return
    // Revoking server-side is the point: dropping only the local copy leaves a
    // live grant on someone's Google account with nothing in Holi to show for
    // it. A failed revoke still clears locally: the user asked for this, and
    // refusing because Google is unreachable would trap them.
    await revokeAccount(sub)
    await dropAccount(sub)
  }

  async function dropAccount(sub: string): Promise<void> {
    if (accounts[sub] === undefined) return
    const next = { ...accounts }
    delete next[sub]
    await persist(next)
    sessions.delete(sub)
    await deps.vaults.unlinkAccount(sub)
    emit(sub)
  }
}
