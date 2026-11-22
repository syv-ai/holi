/**
 * Who is signed in: the composition point for the device flow, the keychain
 * and the API client. There is no Holi server, so this class only answers
 * three questions: is there a token, whose is it, and what happens when it
 * stops working (docs/features/auth.md).
 *
 * `token()` is a **getter**, not a value, so a sign-out takes effect on the
 * next operation rather than the next restart.
 */
import { GitHubApi, type Viewer } from './api'
import { startDeviceFlow, type DeviceFlow, type DeviceFlowResult } from './device-flow'
import { TokenStore, type StoredAuth } from './token-store'

/**
 * The OAuth app's client id: `Holi`, owned by the **syv-ai** org so it outlives
 * any one account. A public client's id is not a secret; that is the premise of
 * the device flow.
 *
 * **If the device-code endpoint ever answers 404, the *Enable Device Flow*
 * checkbox has been un-ticked.** It is off by default and the 404 reads exactly
 * like a wrong URL. The one-line check:
 *
 *     curl -s -X POST https://github.com/login/device/code \
 *       -H "Accept: application/json" -d "client_id=$CLIENT_ID&scope=repo"
 */
const CLIENT_ID = 'Ov23liwgXQvw5gAGwqAL'

/**
 * `repo` for the vault, `read:user` for the identity in the UI, and `read:org`
 * for exactly one feature: offering an organization as the owner when creating
 * a new vault. A scope nobody can trace to a feature is a scope to drop.
 */
const SCOPES = ['repo', 'read:user', 'read:org']

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
  #generationListeners = new Set<() => void>()
  #generation = 0
  #storeWork: Promise<void> = Promise.resolve()
  #attempt: { generation: number; invalidated: boolean; flow?: DeviceFlow } | null = null
  readonly api: GitHubApi

  private constructor(deps: SessionDeps, auth: StoredAuth | null) {
    this.#deps = deps
    this.#auth = auth
    this.api = new GitHubApi({
      token: () => this.token(),
      credentialIdentity: () => this.#auth,
      // Only on a 401. Every other refusal leaves the session alone. Object
      // identity distinguishes a fresh validation of the same bearer token.
      onUnauthorized: (_token, identity) => {
        if (identity !== null && this.#auth === identity) return this.#forget(false)
      },
      fetch: deps.fetch,
    })
  }

  /** Reads the keychain and nothing else. **No network**: a vault opens fully
   * offline, and the identity is cached so a signed-in user still has a name
   * to show with the wifi off. */
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

  /** Changes on every account adoption attempt and logout, including same-account relogin. */
  get generation(): number {
    return this.#generation
  }

  /**
   * Starts the grant and returns as soon as there is a code to display.
   *
   * The wait it gets back is wrapped: on a grant, the token is stored and the
   * viewer fetched *before* the promise settles, so a caller that navigates on
   * resolution cannot beat the write.
   */
  async signIn(): Promise<DeviceFlow> {
    const attempt = this.#beginAttempt()
    const flow = await startDeviceFlow({
      clientId: this.#clientId(),
      scopes: SCOPES,
      fetch: this.#deps.fetch,
      now: this.#deps.now,
      sleep: this.#deps.sleep,
    })
    attempt.flow = flow
    if (attempt.invalidated) flow.cancel()

    let wait: Promise<DeviceFlowResult> | null = null
    return {
      code: flow.code,
      cancel: () => {
        this.#invalidate(attempt)
        flow.cancel()
      },
      wait: () => {
        if (wait !== null) return wait
        wait = (async (): Promise<DeviceFlowResult> => {
          const result = await flow.wait()
          if (!this.#isCurrent(attempt)) return { kind: 'cancelled' }
          if (result.kind !== 'granted') return result
          return this.#adopt(attempt, result.token, result.scopes)
        })()
        return wait
      },
    }
  }

  /** The keychain entry goes; **the clones stay on disk**, untouched: they may
   * hold unpushed commits. This class does not know the vault registry exists. */
  async signOut(): Promise<void> {
    await this.#forget()
  }

  /** Fires on sign-in, sign-out, and a 401. */
  onChange(cb: (viewer: Viewer | null) => void): () => void {
    this.#listeners.add(cb)
    return () => this.#listeners.delete(cb)
  }

  /** Synchronous invalidation before an account generation starts changing. */
  onGenerationChange(cb: () => void): () => void {
    this.#generationListeners.add(cb)
    return () => this.#generationListeners.delete(cb)
  }

  /**
   * Every sign-in attempt owns a generation from before device-code lookup.
   * Its credential is staged encrypted, then synchronously published only if
   * that attempt still owns the session; memory adoption happens in the same
   * turn. Store mutations are serialized so sign-out cannot race publication.
   */
  #beginAttempt(): { generation: number; invalidated: boolean; flow?: DeviceFlow } {
    if (this.#attempt !== null) this.#invalidate(this.#attempt)
    for (const cb of this.#generationListeners) cb()
    const attempt = { generation: ++this.#generation, invalidated: false } as {
      generation: number
      invalidated: boolean
      flow?: DeviceFlow
    }
    this.#attempt = attempt
    return attempt
  }

  #invalidate(attempt: { generation: number; invalidated: boolean; flow?: DeviceFlow }): void {
    if (attempt.invalidated) return
    attempt.invalidated = true
    attempt.flow?.cancel()
    if (this.#attempt === attempt) {
      for (const cb of this.#generationListeners) cb()
      this.#generation++
      this.#attempt = null
    }
  }

  #isCurrent(attempt: { generation: number; invalidated: boolean }): boolean {
    return (
      !attempt.invalidated && this.#attempt === attempt && attempt.generation === this.#generation
    )
  }

  async #adopt(
    attempt: { generation: number; invalidated: boolean },
    token: string,
    scopes: string[],
  ): Promise<DeviceFlowResult> {
    const lookup = new GitHubApi({ token: () => token, fetch: this.#deps.fetch })
    const viewer = await lookup.viewer()
    if (!this.#isCurrent(attempt)) return { kind: 'cancelled' }
    const auth = { token, scopes, ...viewer }

    return this.#serializeStore(async () => {
      if (!this.#isCurrent(attempt)) return { kind: 'cancelled' } as const
      const prepared = await this.#deps.store.prepare(auth)
      if (!this.#isCurrent(attempt)) {
        await prepared.discard()
        return { kind: 'cancelled' } as const
      }
      try {
        prepared.publish()
      } catch (error) {
        await prepared.discard()
        throw error
      }
      // The candidate is now durable. Retire work opened during the pending
      // attempt before exposing the new credential, even for same-account login.
      for (const cb of this.#generationListeners) cb()
      this.#generation++
      this.#auth = auth
      this.#attempt = null
      this.#emit()
      return { kind: 'granted', token, scopes }
    })
  }

  async #forget(cancelAttempt = true): Promise<void> {
    if (cancelAttempt && this.#attempt !== null) this.#invalidate(this.#attempt)
    for (const cb of this.#generationListeners) cb()
    this.#generation++
    if (!cancelAttempt && this.#attempt !== null) this.#attempt.generation = this.#generation
    this.#auth = null
    await this.#serializeStore(() => {
      if (!cancelAttempt && this.#auth !== null) return Promise.resolve()
      return this.#deps.store.clear()
    })
    this.#emit()
  }

  #serializeStore<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#storeWork.then(operation)
    this.#storeWork = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  #emit(): void {
    const viewer = this.viewer
    for (const cb of this.#listeners) cb(viewer)
  }

  #clientId(): string {
    return this.#deps.clientId ?? process.env.HOLI_GITHUB_CLIENT_ID ?? CLIENT_ID
  }
}
