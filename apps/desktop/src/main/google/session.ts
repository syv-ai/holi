/**
 * The connected Google account — and **the only thing in Holi allowed to mint
 * an access token** (D67).
 *
 * That exclusivity is the whole design, not a tidiness preference. Google
 * *rotates* refresh tokens: a refresh may return a new one and invalidate the
 * old. Two independent refreshers — main and, later, the `holi-google` CLI —
 * racing on one stored refresh token therefore invalidate each other, and the
 * symptom is an intermittent "reconnect Google" that nobody can reproduce. So
 * every consumer asks *this* object for a token; nothing else calls Google's
 * token endpoint, and nothing else reads the keychain.
 *
 * The same rule applies *within* this object: `getAccessToken()` single-flights,
 * so ten concurrent callers produce one refresh, not ten.
 *
 * Modelled on `github/session.ts` — `account` is a getter with no tokens in it,
 * for the same reason `viewer` is.
 */
import { post, startLoopbackFlow, TOKEN_URL, type Listen, type LoopbackFlow } from './loopback-flow'
import { GoogleTokenStore, type GoogleAccounts, type StoredGoogleAuth } from './token-store'

/**
 * The OAuth client id for Holi's Google app — an **existing registration**
 * (D67), reused rather than minted.
 *
 * A desktop client's id is not a secret, and neither is the `client_secret`
 * Google issues alongside it: for an installed app both ship in the binary and
 * **PKCE** is what actually protects the grant. This is the same premise
 * `github/session.ts` documents for its own public client id.
 *
 * `HOLI_GOOGLE_CLIENT_ID` / `HOLI_GOOGLE_CLIENT_SECRET` in the environment
 * override both, which is how you point a dev build at a different app without
 * editing source.
 */
export const GOOGLE_CLIENT_ID = '132910330015-4ror8qtmhh69d1ms1s3s99tot5gm551q.apps.googleusercontent.com'

/**
 * The desktop `client_secret` Google issued alongside the id above.
 *
 * **Committed on purpose, and it is not a credential.** Google's own docs say
 * the secret for an installed app "is obviously not treated as a secret" — it
 * ships in every copy of the binary and anyone can read it out. Google requires
 * it on the token exchange for a Desktop-type client, so it has to be here; the
 * thing that actually stops a stolen authorization code being redeemed is
 * **PKCE** (`pkce.ts`), which binds the exchange to a verifier that never
 * leaves this process.
 *
 * The consequence to be clear-eyed about: this pair identifies *Holi*, not a
 * user. It grants nothing on its own — every token still requires the user to
 * complete consent in their own browser. Rotating it is a config change, not an
 * incident.
 */
export const GOOGLE_CLIENT_SECRET = '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'

/**
 * **Mail is read-write within a bounded set; calendar stays read-only** (D68,
 * amending D67 §4).
 *
 * `gmail.modify` replaces `gmail.readonly` — it is a superset, so asking for
 * both is redundant. It buys the four things a mailbox is actually triaged
 * with: read state, star, archive and trash.
 *
 * **Two boundaries, and only one of them is Google's.**
 *
 * - *Permanent delete is impossible.* It needs `https://mail.google.com/`,
 *   which is not requested and will not be. Trash is recoverable; that is what
 *   makes it not-delete.
 * - *Sending is merely unbuilt.* `gmail.modify` permits `messages.send`, and no
 *   lesser scope grants `threads.modify` — so there is no way to buy archive
 *   without also buying send. Nothing here stops a send; the absence of a
 *   function that sends does. Do not write a comment claiming otherwise: this
 *   is a code boundary wearing a scope boundary's clothes, and the agent's
 *   `Bash(holi-google …)` gate (D67 §5) is now the only wall, not the second.
 *
 * **Contacts is two scopes, not one**, and that is not a belt-and-braces
 * duplicate. `contacts.readonly` covers `people/me/connections` — the contacts
 * someone explicitly saved. The auto-collected ones, which is what an address
 * book is actually made of, live at `otherContacts` and are covered only by
 * `contacts.other.readonly`. Asking for the first alone yields an address book
 * that answers every request successfully and is empty for most Workspace
 * accounts; the 403 is swallowed by `people.ts`'s `[]` policy, so nothing says
 * so. See the module note there.
 *
 * `openid`/`email` are what make the `id_token` carry the `sub` we key on.
 */
export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/contacts.other.readonly',
]

const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'

/**
 * The scopes Google grants under a different name than you request them.
 *
 * **A token response does not echo the strings you sent.** Ask for `email` and
 * the grant comes back as `https://www.googleapis.com/auth/userinfo.email`;
 * `profile` expands the same way. Everything else — `openid`, and every
 * `.../auth/…` URL — is returned verbatim.
 *
 * Comparing the request against the grant without this reports `email` missing
 * on a grant that is entirely correct, and settings then demands a reconnect
 * that cannot possibly help: the mismatch is in the comparison, not the token.
 * That is exactly how it failed in real use.
 *
 * Checked in both directions, because which side holds the short form is a
 * detail of how the list was written rather than a fact worth relying on.
 */
const SCOPE_ALIASES: Record<string, string> = {
  email: 'https://www.googleapis.com/auth/userinfo.email',
  profile: 'https://www.googleapis.com/auth/userinfo.profile',
}

/**
 * Refresh this long before the token actually dies.
 *
 * Refreshing at exact expiry loses the race against clock skew and the flight
 * time of the request that is about to use it — the symptom is a 401 on maybe
 * one call in fifty, which reads as a flaky API rather than a clock problem.
 */
const EXPIRY_SKEW_MS = 60_000

/** What the renderer is allowed to know: no tokens, ever. */
export interface GoogleAccount {
  email: string
}

/** The grant is gone on Google's side — revoked, expired, or password-changed.
 *  Distinct from a network failure because only this one means "reconnect". */
export class GoogleReconnectRequiredError extends Error {
  constructor() {
    super('the Google connection has expired or been revoked — connect Google again')
    this.name = 'GoogleReconnectRequiredError'
  }
}

export interface GoogleSessionDeps {
  store: GoogleTokenStore
  listen: Listen
  openBrowser: (url: string) => Promise<void>
  clientId?: string
  clientSecret?: string
  fetch?: typeof globalThis.fetch
  now?: () => number
}

export class GoogleSession {
  #deps: GoogleSessionDeps
  #accounts: GoogleAccounts
  #listeners = new Set<(account: GoogleAccount | null) => void>()
  /** The in-flight refresh, if any — the single-flight latch. */
  #refreshing: Promise<string> | null = null

  private constructor(deps: GoogleSessionDeps, accounts: GoogleAccounts) {
    this.#deps = deps
    this.#accounts = accounts
  }

  /** Reads the keychain and nothing else. **No network** — a vault opens fully
   *  offline, and a stale access token is refreshed on first use, not at boot. */
  static async load(deps: GoogleSessionDeps): Promise<GoogleSession> {
    return new GoogleSession(deps, await deps.store.read())
  }

  /**
   * The connected account, or `null`.
   *
   * v1 connects one (D67); the store is a map so a second is additive. Until
   * then "the account" is "the only entry", and this getter is the one place
   * that assumption lives.
   */
  get account(): GoogleAccount | null {
    const auth = this.#current()
    return auth === null ? null : { email: auth.email }
  }

  /**
   * Scopes this build needs that the stored grant does not carry.
   *
   * **Widening `GOOGLE_SCOPES` does not invalidate an existing grant**, and that
   * is the trap this exists for. The refresh token keeps minting access tokens
   * for whatever was consented to originally, so a build that asks for more
   * gets a working connection whose every new call 403s with
   * `insufficientPermissions` — a failure that looks like a bug in the feature
   * rather than a missing consent, and that no amount of retrying fixes. The
   * one cure is to send the user back through consent, which needs someone to
   * notice first.
   *
   * `scopes` had been written on every connect since the connector landed and
   * read by nothing until this.
   *
   * Empty with no account: "not connected" is a different state, and the UI
   * already renders it.
   */
  missingScopes(): string[] {
    const auth = this.#current()
    if (auth === null) return []
    const granted = new Set(auth.scopes)
    const has = (scope: string): boolean => {
      if (granted.has(scope)) return true
      const alias = SCOPE_ALIASES[scope]
      if (alias !== undefined && granted.has(alias)) return true
      // The other direction too: a short form in the grant against a URL here.
      return Object.entries(SCOPE_ALIASES).some(
        ([short, url]) => url === scope && granted.has(short),
      )
    }
    return GOOGLE_SCOPES.filter((scope) => !has(scope))
  }

  /**
   * Google's stable id for the connected account, or `null`.
   *
   * **Main only** — deliberately not on `GoogleAccount`, which is what the
   * renderer is allowed to know. What needs it is the cache, which must be
   * scoped to an account by something that does not change: an email address
   * can be renamed, and `sub` is what the token store already keys on.
   */
  get accountSub(): string | null {
    return this.#current()?.sub ?? null
  }

  /**
   * Starts the grant. Returns as soon as the browser is open, so the UI can
   * say "waiting for your browser" — but the returned `wait()` is **wrapped**:
   * on a grant, the tokens are persisted before the promise settles, so a
   * caller that re-renders on resolution cannot beat the write.
   */
  async connect(): Promise<LoopbackFlow> {
    const flow = await startLoopbackFlow({
      clientId: this.#clientId(),
      clientSecret: this.#clientSecret(),
      scopes: GOOGLE_SCOPES,
      listen: this.#deps.listen,
      openBrowser: this.#deps.openBrowser,
      fetch: this.#deps.fetch,
      now: this.#deps.now,
    })

    return {
      authUrl: flow.authUrl,
      cancel: () => flow.cancel(),
      wait: async () => {
        const result = await flow.wait()
        if (result.kind !== 'granted') return result

        const { tokens } = result
        // v1 is single-account: a new connect *replaces* rather than accrues,
        // so reconnecting as someone else does not silently leave the previous
        // account's grant sitting in the keychain.
        this.#accounts = {
          [tokens.sub]: {
            sub: tokens.sub,
            email: tokens.email,
            refreshToken: tokens.refreshToken,
            accessToken: tokens.accessToken,
            expiresAt: tokens.expiresAt,
            scopes: tokens.scopes,
          },
        }
        await this.#deps.store.write(this.#accounts)
        this.#emit()
        return result
      },
    }
  }

  /**
   * A valid access token, refreshing if needed. **The only way to get one.**
   *
   * Single-flighted: concurrent callers share one in-flight refresh. Without
   * this, opening the agenda while a mail fetch is running fires two refreshes
   * against a rotating refresh token — which is the exact race this class
   * exists to make impossible.
   */
  async getAccessToken(): Promise<string> {
    const auth = this.#current()
    if (auth === null) throw new GoogleReconnectRequiredError()

    const now = this.#now()
    if (now < auth.expiresAt - EXPIRY_SKEW_MS) return auth.accessToken

    // `??=` is the latch: the first caller starts the refresh, everyone else
    // awaits the same promise.
    this.#refreshing ??= this.#refresh(auth).finally(() => {
      this.#refreshing = null
    })
    return this.#refreshing
  }

  /**
   * Revoke at Google, **then** forget locally.
   *
   * Revoking server-side is the point: deleting only the local copy leaves a
   * live grant on someone's Google account with nothing in Holi to show for it.
   * A failed revoke still clears locally — the user asked to disconnect, and
   * refusing to because Google is unreachable would trap them.
   */
  async disconnect(): Promise<void> {
    const auth = this.#current()
    if (auth !== null) {
      await post(this.#fetch(), REVOKE_URL, { token: auth.refreshToken }).catch(() => undefined)
    }
    this.#accounts = {}
    this.#refreshing = null
    await this.#deps.store.clear()
    this.#emit()
  }

  /** Fires on connect, disconnect, and a dead grant. */
  onChange(cb: (account: GoogleAccount | null) => void): () => void {
    this.#listeners.add(cb)
    return () => this.#listeners.delete(cb)
  }

  async #refresh(auth: StoredGoogleAuth): Promise<string> {
    let body: Record<string, unknown>
    try {
      body = await post(this.#fetch(), TOKEN_URL, {
        client_id: this.#clientId(),
        ...(this.#clientSecret() === undefined ? {} : { client_secret: this.#clientSecret()! }),
        refresh_token: auth.refreshToken,
        grant_type: 'refresh_token',
      })
    } catch (err) {
      // `invalid_grant` is the one refusal that means the grant itself is dead
      // (revoked, expired, password changed) — everything else is transient and
      // must NOT drop a working connection. Google reports it as a 400.
      if (err instanceof Error && 'status' in err && err.status === 400) {
        this.#accounts = {}
        await this.#deps.store.clear()
        this.#emit()
        throw new GoogleReconnectRequiredError()
      }
      throw err
    }

    const updated: StoredGoogleAuth = {
      ...auth,
      accessToken: String(body.access_token),
      expiresAt: this.#now() + Number(body.expires_in) * 1000,
      // **Rotation.** Google may hand back a new refresh token; when it does,
      // the old one is dead and persisting it would break the next refresh.
      // When it does not, the existing one stays valid.
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : auth.refreshToken,
    }

    this.#accounts = { ...this.#accounts, [updated.sub]: updated }
    await this.#deps.store.write(this.#accounts)
    return updated.accessToken
  }

  #current(): StoredGoogleAuth | null {
    return Object.values(this.#accounts)[0] ?? null
  }

  #emit(): void {
    const account = this.account
    for (const cb of this.#listeners) cb(account)
  }

  #now(): number {
    return (this.#deps.now ?? (() => Date.now()))()
  }

  #fetch(): typeof globalThis.fetch {
    return this.#deps.fetch ?? globalThis.fetch
  }

  #clientId(): string {
    return this.#deps.clientId ?? process.env.HOLI_GOOGLE_CLIENT_ID ?? GOOGLE_CLIENT_ID
  }

  #clientSecret(): string | undefined {
    return this.#deps.clientSecret ?? process.env.HOLI_GOOGLE_CLIENT_SECRET ?? GOOGLE_CLIENT_SECRET
  }
}
