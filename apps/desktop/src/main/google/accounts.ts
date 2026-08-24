/**
 * Who Holi is connected to at Google, and which vault uses whom (D87).
 *
 * This is the owner. It holds the accounts map — **the only thing that does** —
 * hands out one `GoogleSession` per account, and resolves a vault to the session
 * it should use. D67 kept one machine-wide connection; D87 makes a vault's Google
 * account its own, and this is where that resolution lives.
 *
 * **`connect` is here rather than on a session**, and that is forced rather than
 * chosen: a connect creates an account whose `sub` is unknown until the grant
 * comes back, so it cannot belong to an object identified by its `sub`.
 *
 * **No `electron` import**, like every file in `google/` except `electron.ts`.
 * That is what keeps the suite running under plain Node, and it is a structural
 * fact rather than a lucky one only while nobody adds the second import.
 */
import {
  GoogleSession,
  type AccountRef,
  type GoogleAccount,
  GOOGLE_SCOPES,
} from './session'
import { startLoopbackFlow, type Listen, type LoopbackFlow } from './loopback-flow'
import { resolveClientId, resolveClientSecret } from './credentials'
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
  /** The session this vault should use, or null when it has never connected —
   *  or when the account it named is gone. Never throws: "not connected" is a
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
}

export interface GoogleAccountsDeps {
  store: GoogleTokenStore
  vaults: VaultAccountsStore
  listen: Listen
  openBrowser: (url: string) => Promise<void>
  clientId?: string
  clientSecret?: string
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
        clientId: deps.clientId,
        clientSecret: deps.clientSecret,
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
      const flow = await startLoopbackFlow({
        clientId: resolveClientId(deps.clientId),
        clientSecret: resolveClientSecret(deps.clientSecret),
        scopes: GOOGLE_SCOPES,
        listen: deps.listen,
        openBrowser: deps.openBrowser,
        fetch: deps.fetch,
        now: deps.now,
      })
      connecting = flow

      return {
        authUrl: flow.authUrl,
        cancel: () => {
          connecting = null
          flow.cancel()
        },
        // Wrapped: the tokens are persisted AND the vault is linked before this
        // resolves, so a caller that re-renders on resolution cannot beat the
        // write and show "not connected" for a tick.
        wait: async () => {
          const result = await flow.wait()
          connecting = null
          if (result.kind !== 'granted') return result

          const { tokens } = result
          // Additive, unlike D67's single-account connect which replaced: another
          // vault may be using the account already in the store.
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
    },

    cancelConnect() {
      connecting?.cancel()
      connecting = null
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

    async removeAccount(sub) {
      const auth = accounts[sub]
      if (auth === undefined) return
      // Revoking server-side is the point: dropping only the local copy leaves a
      // live grant on someone's Google account with nothing in Holi to show for
      // it. A failed revoke still clears locally — the user asked for this, and
      // refusing because Google is unreachable would trap them.
      await (deps.fetch ?? globalThis.fetch)(REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: auth.refreshToken }).toString(),
      }).catch(() => undefined)

      const next = { ...accounts }
      delete next[sub]
      await persist(next)
      sessions.delete(sub)
      await deps.vaults.unlinkAccount(sub)
      emit(sub)
    },

    onChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}
