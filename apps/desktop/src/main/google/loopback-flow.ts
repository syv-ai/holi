/**
 * The Google grant: **authorization code + PKCE, redirected to loopback**.
 *
 * This is deliberately a *sibling* of `github/device-flow.ts`, not a reuse of
 * it. GitHub uses the device-code grant; Google's limited-input device flow is
 * not approved for the Gmail/Calendar scopes we need, so the sanctioned desktop
 * pattern is this one: open the system browser, catch the redirect on a
 * short-lived listener bound to `127.0.0.1`, and exchange the code for tokens.
 *
 * What *does* port verbatim is the shape, because it is what makes the flow
 * testable at zero wall-clock cost and with no network or browser:
 * everything from the outside — `fetch`, `now`, `openBrowser`, the listener,
 * even the random bytes — is injected, and a flow **outcome** never rejects.
 * A network or protocol fault still throws, because those are not outcomes.
 */
import { challengeFor, createVerifier, randomState, type RandomBytes } from './pkce'

/** Everything a connected account needs, as the exchange returns it. */
export interface GoogleTokens {
  accessToken: string
  /** The durable half. Google returns it only when asked correctly — see
   *  `AUTH_PARAMS` and the `prompt=consent` note there. */
  refreshToken: string
  /** Epoch ms. The session refreshes against it, with a skew margin. */
  expiresAt: number
  scopes: string[]
  /** Google's stable account id — the identity key, never the email. An email
   *  can be renamed or reassigned; `sub` cannot. */
  sub: string
  email: string
}

export type LoopbackFlowResult =
  | { kind: 'granted'; tokens: GoogleTokens }
  /** The user pressed Cancel on Google's consent screen. A normal outcome. */
  | { kind: 'denied' }
  /** We stopped: a closed window, or a second connect superseding this one. */
  | { kind: 'cancelled' }
  /** Nobody completed the consent before the deadline. */
  | { kind: 'timeout' }

export interface LoopbackFlow {
  /** Where the browser was sent. Surfaced so the UI can offer "open it again"
   *  when the automatic launch is swallowed by the desktop environment. */
  readonly authUrl: string
  /** Resolves once. */
  wait(): Promise<LoopbackFlowResult>
  cancel(): void
}

/**
 * The redirect catcher, behind a seam.
 *
 * A real one binds a `node:http` server (see `loopback-server.ts`); a test one
 * is three lines and a promise. This is the difference between a flow that is
 * unit-testable and one that needs a browser.
 */
export interface LoopbackServer {
  /** The **assigned** port — bind `:0` and read it back. A fixed port collides
   *  with whatever else is listening, and the failure looks like a broken app. */
  readonly port: number
  /** The redirect's query params, once the browser arrives. */
  waitForRedirect(): Promise<Record<string, string>>
  close(): void
}

export type Listen = () => Promise<LoopbackServer>

export interface LoopbackFlowDeps {
  clientId: string
  /**
   * Google issues one even for "Desktop app" clients. It is **not
   * confidential** — it ships in the binary and PKCE is the actual protection —
   * and it is optional here: sent only when the registration requires it.
   */
  clientSecret?: string
  scopes: string[]
  listen: Listen
  openBrowser: (url: string) => Promise<void>
  fetch?: typeof globalThis.fetch
  now?: () => number
  random?: RandomBytes
  /** How long to wait for a human. Injected so a test does not wait. */
  timeoutMs?: number
  /** Injected so a test can await the timeout without wall-clock cost. */
  setTimer?: (fn: () => void, ms: number) => { cancel: () => void }
}

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const TOKEN_URL = 'https://oauth2.googleapis.com/token'

/** A hung socket must not stall a connect with no error and nothing to cancel. */
const REQUEST_TIMEOUT_MS = 15_000

/** Long enough to find the browser window, read the consent, and pick an
 *  account; short enough that an abandoned flow releases the port. */
const DEFAULT_TIMEOUT_MS = 5 * 60_000

/** What the user sees in the tab that catches the redirect. Kept deliberately
 *  plain — it is a courtesy page, and it must render with no network. */
const CLOSE_PAGE = 'Holi is connected. You can close this tab.'

export async function startLoopbackFlow(deps: LoopbackFlowDeps): Promise<LoopbackFlow> {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const now = deps.now ?? (() => Date.now())
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number) => {
      const id = setTimeout(fn, ms)
      return { cancel: () => clearTimeout(id) }
    })

  const verifier = createVerifier(deps.random)
  const challenge = challengeFor(verifier)
  const state = randomState(deps.random)

  const server = await deps.listen()
  // Built once and reused for the exchange: the `redirect_uri` presented at
  // authorization and the one presented at exchange must match **exactly**, and
  // rebuilding the string twice is how they come to differ by a slash.
  const redirectUri = `http://127.0.0.1:${server.port}`

  const authUrl = `${AUTH_URL}?${new URLSearchParams({
    client_id: deps.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: deps.scopes.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    // Without BOTH of these a *re-connect* yields an access token and no
    // refresh token: Google hands the durable half over on the first consent
    // only, unless consent is forced. The failure is silent and shows up an
    // hour later as a session that cannot renew.
    access_type: 'offline',
    prompt: 'consent',
  }).toString()}`

  await deps.openBrowser(authUrl)

  let settled = false
  let cancelled = false
  let outcome: Promise<LoopbackFlowResult> | null = null
  const stops: Array<() => void> = []

  /** Every exit runs through here: the listener must not outlive the flow, or
   *  an abandoned connect holds a port open for the life of the app. */
  const finish = <T>(value: T): T => {
    if (!settled) {
      settled = true
      for (const stop of stops) stop()
      server.close()
    }
    return value
  }

  async function run(): Promise<LoopbackFlowResult> {
    // Cancelled before anyone awaited it — the listener is already down, so
    // racing on a dead server would hang forever.
    if (cancelled) return { kind: 'cancelled' }

    const timeout = new Promise<LoopbackFlowResult>((resolve) => {
      const timer = setTimer(() => resolve({ kind: 'timeout' }), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      stops.push(() => timer.cancel())
    })
    const abandoned = new Promise<LoopbackFlowResult>((resolve) => {
      stops.push(() => {
        if (cancelled) resolve({ kind: 'cancelled' })
      })
    })

    const params = await Promise.race([
      server.waitForRedirect().then((p) => ({ redirect: p }) as const),
      timeout.then((r) => ({ done: r }) as const),
      abandoned.then((r) => ({ done: r }) as const),
    ])

    if ('done' in params) return finish(params.done)
    const query = params.redirect

    // Checked before anything is redeemed. A response carrying someone else's
    // state is not this flow's response, and redeeming its code would be the
    // CSRF the parameter exists to prevent.
    if (query.state !== state) {
      finish(undefined)
      throw new Error('Google returned a mismatched state parameter — the sign-in was not completed')
    }

    if (query.error !== undefined) {
      // Cancel is a normal thing a person does, not a failure to report.
      if (query.error === 'access_denied') return finish({ kind: 'denied' })
      finish(undefined)
      throw new Error(`Google refused the authorization: ${query.error}`)
    }

    const code = query.code
    if (code === undefined) {
      finish(undefined)
      throw new Error('Google returned no authorization code')
    }

    const body = await post(fetchImpl, TOKEN_URL, {
      client_id: deps.clientId,
      ...(deps.clientSecret === undefined ? {} : { client_secret: deps.clientSecret }),
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    })

    const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : null
    if (refreshToken === null) {
      finish(undefined)
      // Naming the cause matters: this is the `prompt=consent` failure above,
      // and without the hint it reads as a random Google hiccup.
      throw new Error(
        'Google returned no refresh token — the grant cannot be renewed. ' +
          'This usually means the authorization request omitted access_type=offline / prompt=consent.',
      )
    }

    const { sub, email } = identityFrom(body.id_token)

    return finish({
      kind: 'granted',
      tokens: {
        accessToken: String(body.access_token),
        refreshToken,
        expiresAt: now() + Number(body.expires_in) * 1000,
        // Google returns one space-separated string, not an array.
        scopes: String(body.scope ?? '').split(' ').filter(Boolean),
        sub,
        email,
      },
    })
  }

  return {
    authUrl,
    wait: () => (outcome ??= run()),
    cancel: () => {
      cancelled = true
      // Resolves the `abandoned` race and tears the listener down.
      if (!settled) {
        settled = true
        for (const stop of stops) stop()
        server.close()
      }
    },
  }
}

/**
 * Read `sub` and `email` out of the `id_token`.
 *
 * **The signature is deliberately not verified, and that is safe *here* and
 * only here:** this token came straight back from Google's token endpoint over
 * TLS, in response to a request we made, so there is no untrusted party in
 * between to forge it — Google's own documentation says a JWKS round-trip is
 * unnecessary in exactly this case. Do not copy this into a context where the
 * token arrives from a client; there it must be verified.
 */
function identityFrom(idToken: unknown): { sub: string; email: string } {
  if (typeof idToken !== 'string') throw new Error('Google returned no id_token')
  const payload = idToken.split('.')[1]
  if (payload === undefined) throw new Error('Google returned a malformed id_token')

  const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  if (claims === null || typeof claims !== 'object') {
    throw new Error('Google returned a malformed id_token')
  }
  const c = claims as Record<string, unknown>
  if (typeof c.sub !== 'string') throw new Error('Google returned an id_token with no subject')
  return { sub: c.sub, email: typeof c.email === 'string' ? c.email : '' }
}

export class GoogleHttpError extends Error {
  status: number
  constructor(status: number, body: string) {
    super(`Google returned ${status}: ${body}`)
    this.name = 'GoogleHttpError'
    this.status = status
  }
}

/** Form-encoded out, JSON back — Google's token endpoint speaks no other way. */
export async function post(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  if (!res.ok) throw new GoogleHttpError(res.status, await res.text().catch(() => ''))
  return (await res.json()) as Record<string, unknown>
}

export { CLOSE_PAGE }
