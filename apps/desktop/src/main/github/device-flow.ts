/**
 * The OAuth **device flow** — the grant designed for clients that cannot hold a
 * client secret, which a desktop app cannot (auth PRD FR-2).
 *
 * Two phases, deliberately. `startDeviceFlow` resolves as soon as GitHub hands
 * back a user code, and polling only begins when the caller awaits `wait()`.
 * A one-shot `signIn(): Promise<token>` would hide the code until it was
 * already spent, and the code is the entire user-facing half of this flow.
 *
 * Everything the flow needs from the outside — `fetch`, `now`, `sleep` — is
 * injected, so the whole state machine is testable at zero wall-clock cost and
 * without a network.
 */

/** What the renderer shows. The `device_code` is deliberately absent: it is the
 * half of the pair that authenticates, and the UI has no use for it. */
export interface DeviceCode {
  userCode: string
  verificationUri: string
  /** Epoch ms. The UI counts down against it; the poller stops at it. */
  expiresAt: number
}

export type DeviceFlowResult =
  | { kind: 'granted'; token: string; scopes: string[] }
  /** The user pressed Cancel on github.com. A normal outcome, not a failure. */
  | { kind: 'denied' }
  /** The code timed out — GitHub said so, or the deadline passed. FR-4 offers
   * to restart. */
  | { kind: 'expired' }
  /** We stopped: a closed window, or a second sign-in superseding this one. */
  | { kind: 'cancelled' }

export interface DeviceFlow {
  readonly code: DeviceCode
  /** Resolves once. A flow *outcome* never rejects; a network or protocol
   * fault still throws, because those are not outcomes. */
  wait(): Promise<DeviceFlowResult>
  cancel(): void
}

export interface DeviceFlowDeps {
  clientId: string
  scopes: string[]
  fetch?: typeof globalThis.fetch
  now?: () => number
  /** Injected so the poll interval costs a test nothing. */
  sleep?: (ms: number) => Promise<void>
}

const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'

/** A hung socket during polling would stall sign-in with no error and nothing
 * to cancel. */
const REQUEST_TIMEOUT_MS = 15_000

/** GitHub's documented penalty for polling too fast, applied when a `slow_down`
 * response does not carry a replacement interval of its own. */
const SLOW_DOWN_PENALTY_MS = 5_000

export async function startDeviceFlow(deps: DeviceFlowDeps): Promise<DeviceFlow> {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const now = deps.now ?? (() => Date.now())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  const started = await post(fetchImpl, DEVICE_CODE_URL, {
    client_id: deps.clientId,
    // The wire format is space-separated, and getting it wrong yields a grant
    // for a scope literally named "repo,read:user".
    scope: deps.scopes.join(' '),
  }).catch((err: unknown) => {
    // A 404 here is what an OAuth app *without the device-flow checkbox* looks
    // like. It reads exactly like a wrong URL, so say which one it is.
    if (err instanceof DeviceFlowHttpError && err.status === 404) {
      throw new Error(
        'GitHub returned 404 for the device-code endpoint — the OAuth app most likely ' +
          'does not have the device flow enabled (Settings → Developer settings → ' +
          'OAuth Apps → Enable Device Flow)',
      )
    }
    throw err
  })

  const deviceCode = String(started.device_code)
  const code: DeviceCode = {
    userCode: String(started.user_code),
    verificationUri: String(started.verification_uri),
    expiresAt: now() + Number(started.expires_in) * 1000,
  }

  let intervalMs = Number(started.interval) * 1000
  let cancelled = false
  let outcome: Promise<DeviceFlowResult> | null = null

  async function poll(): Promise<DeviceFlowResult> {
    for (;;) {
      if (cancelled) return { kind: 'cancelled' }
      // Sleep *before* the first poll: the user has not typed the code yet, so
      // an immediate request is a guaranteed `authorization_pending`.
      await sleep(intervalMs)
      if (cancelled) return { kind: 'cancelled' }
      if (now() >= code.expiresAt) return { kind: 'expired' }

      const body = await post(fetchImpl, ACCESS_TOKEN_URL, {
        client_id: deps.clientId,
        device_code: deviceCode,
        grant_type: GRANT_TYPE,
      })

      // The error is a field in the body, at HTTP **200**. Branching on
      // `res.ok` alone polls forever and never notices a denial either.
      const error = typeof body.error === 'string' ? body.error : null
      if (error === null) {
        return {
          kind: 'granted',
          token: String(body.access_token),
          // GitHub returns one comma-separated string, not an array.
          scopes: String(body.scope ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        }
      }

      switch (error) {
        case 'authorization_pending':
          break
        case 'slow_down':
          // Adopt the interval GitHub hands back; it already accounts for the
          // penalty. Ignoring it gets the flow rate-limited out entirely, which
          // surfaces as sign-in mysteriously breaking after one retry.
          intervalMs =
            typeof body.interval === 'number'
              ? body.interval * 1000
              : intervalMs + SLOW_DOWN_PENALTY_MS
          break
        case 'access_denied':
          return { kind: 'denied' }
        case 'expired_token':
          return { kind: 'expired' }
        default:
          // An unknown grant state is not a state to guess at.
          throw new Error(
            `GitHub refused the device grant: ${error}` +
              (typeof body.error_description === 'string' ? ` — ${body.error_description}` : ''),
          )
      }
    }
  }

  return {
    code,
    wait: () => (outcome ??= poll()),
    cancel: () => {
      cancelled = true
    },
  }
}

class DeviceFlowHttpError extends Error {
  status: number
  constructor(status: number, body: string) {
    super(`GitHub returned ${status}: ${body}`)
    this.name = 'DeviceFlowHttpError'
    this.status = status
  }
}

/**
 * Form-encoded out, JSON back.
 *
 * `Accept: application/json` is not optional — without it GitHub replies
 * form-urlencoded and `res.json()` throws on a response that was perfectly fine.
 */
async function post(
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

  if (!res.ok) throw new DeviceFlowHttpError(res.status, await res.text().catch(() => ''))
  return (await res.json()) as Record<string, unknown>
}
