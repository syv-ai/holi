/**
 * Who is signed in — the composition point for the device flow, the keychain
 * and the API client.
 *
 * There is no Holi session in the old sense, because there is no Holi server to
 * hold one (auth PRD, §Summary). This class is only the answer to three
 * questions: is there a token, whose is it, and what happens when it stops
 * working. Everything above it — the router, the sync orchestrator, `git.ts` —
 * asks one of those three.
 *
 * `token()` is a **getter**, not a value, because that is what makes a
 * sign-out take effect on the next operation rather than the next restart.
 * `openRepo(root, { token: () => session.token() })` is the intended shape and
 * the one the tests pin.
 */
import { GitHubApi, type Viewer } from './api'
import { startDeviceFlow, type DeviceFlow, type DeviceFlowResult } from './device-flow'
import { TokenStore, type StoredAuth } from './token-store'

/**
 * The OAuth app's client id — `Holi`, owned by the **syv-ai** org.
 *
 * A public client's id is not a secret; that is the premise of the device flow,
 * and it ships inside the binary either way. A constant is its correct home.
 *
 * Owned by the org rather than by a person so it outlives any one account, and
 * so it stays auto-approved for `syv-ai` if third-party application access
 * restrictions are ever turned on there — where the vaults live.
 *
 * **If the device-code endpoint ever answers 404, the *Enable Device Flow*
 * checkbox has been un-ticked.** It is off by default, the 404 reads exactly
 * like a wrong URL, and that misreading cost this project several sessions.
 * The one-line check:
 *
 *     curl -s -X POST https://github.com/login/device/code \
 *       -H "Accept: application/json" -d "client_id=$CLIENT_ID&scope=repo"
 */
export const CLIENT_ID = 'Ov23liwgXQvw5gAGwqAL'

/**
 * `repo` for the vault, `read:user` for the identity in the UI, and `read:org`
 * for exactly one feature: offering an organization as the owner when creating
 * a new vault. Listing org-owned repos never needed it — `affiliation` covers
 * that — and a scope nobody can trace to a feature is a scope to drop.
 */
export const SCOPES = ['repo', 'read:user', 'read:org']

export interface SessionDeps {
  store: TokenStore
  clientId?: string
  fetch?: typeof globalThis.fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export class GitHubSession {
  #deps: SessionDeps
  #auth: StoredAuth | null
  #listeners = new Set<(viewer: Viewer | null) => void>()
  readonly api: GitHubApi

  private constructor(deps: SessionDeps, auth: StoredAuth | null) {
    this.#deps = deps
    this.#auth = auth
    this.api = new GitHubApi({
      token: () => this.token(),
      // FR-14, and only on a 401. Every other refusal leaves the session alone.
      onUnauthorized: () => this.#forget(),
      fetch: deps.fetch,
    })
  }

  /** Reads the keychain and nothing else. **No network** — FR-16 says a vault
   * opens fully offline, and FR-6 caches the identity precisely so that a
   * signed-in user still has a name to show with the wifi off. */
  static async load(deps: SessionDeps): Promise<GitHubSession> {
    return new GitHubSession(deps, await deps.store.read())
  }

  /** `null` when signed out. Renderer-safe by construction: no token in it. */
  get viewer(): Viewer | null {
    if (this.#auth === null) return null
    const { accountId, login, name, avatarUrl } = this.#auth
    return { accountId, login, name, avatarUrl }
  }

  token(): string | null {
    return this.#auth?.token ?? null
  }

  /**
   * Starts the grant and returns as soon as there is a code to display.
   *
   * Awaiting `flow.wait()` is the caller's job — but the wait it gets back is
   * wrapped: on a grant, the token is stored and the viewer fetched *before*
   * the promise settles, so a caller that navigates on resolution cannot beat
   * the write.
   */
  async signIn(): Promise<DeviceFlow> {
    const flow = await startDeviceFlow({
      clientId: this.#clientId(),
      scopes: SCOPES,
      fetch: this.#deps.fetch,
      now: this.#deps.now,
      sleep: this.#deps.sleep,
    })

    return {
      code: flow.code,
      cancel: () => flow.cancel(),
      wait: async (): Promise<DeviceFlowResult> => {
        const result = await flow.wait()
        if (result.kind !== 'granted') return result
        await this.#adopt(result.token, result.scopes)
        return result
      },
    }
  }

  /** FR-15. The keychain entry goes; **the clones stay on disk**, untouched —
   * deleting files that may hold unpushed commits is not a side effect anyone
   * asked for. This class does not know the vault registry exists. */
  async signOut(): Promise<void> {
    await this.#forget()
  }

  /** Fires on sign-in, sign-out, and a 401. Plan 4's sync orchestrator hangs
   * off this to stop touching remotes. */
  onChange(cb: (viewer: Viewer | null) => void): () => void {
    this.#listeners.add(cb)
    return () => this.#listeners.delete(cb)
  }

  /**
   * A token is worth nothing without the account it belongs to: `accountId` is
   * the identity key (FR-6), and it only comes from the viewer call. So the
   * fetch happens before anything is persisted, and a failure leaves the
   * session exactly as signed out as it was — a half-stored token with no
   * identity would be indistinguishable from a corrupt keychain later.
   */
  async #adopt(token: string, scopes: string[]): Promise<void> {
    const previous = this.#auth
    // Set in memory first so `api.viewer()` can read it through the getter.
    this.#auth = { token, accountId: -1, login: '', scopes }

    let viewer: Viewer
    try {
      viewer = await this.api.viewer()
    } catch (err) {
      this.#auth = previous
      throw err
    }

    this.#auth = { token, scopes, ...viewer }
    await this.#deps.store.write(this.#auth)
    this.#emit()
  }

  async #forget(): Promise<void> {
    this.#auth = null
    await this.#deps.store.clear()
    this.#emit()
  }

  #emit(): void {
    const viewer = this.viewer
    for (const cb of this.#listeners) cb(viewer)
  }

  #clientId(): string {
    return this.#deps.clientId ?? process.env.HOLI_GITHUB_CLIENT_ID ?? CLIENT_ID
  }
}
