/**
 * The authenticated Google request — the one place a token meets a URL.
 *
 * Like `github/api.ts`, deliberately not a generated client: Holi makes a
 * handful of GET requests and the SDK that wrapped them would be larger than
 * they are. What this owns instead is the part a generic client would not do
 * for us — **classifying a refusal** so the caller can tell "reconnect Google"
 * apart from "you are rate limited" apart from "that scope was never granted".
 *
 * The token arrives as a **getter returning a promise**, never a string: it is
 * `GoogleSession.getAccessToken()`, which refreshes transparently and
 * single-flights. Passing a resolved string would freeze a token that expires
 * in an hour.
 */

export type GoogleErrorCode =
  /** The grant is gone, or the token could not be minted. Reconnect. */
  | 'reconnect'
  /** Authenticated, but this scope was not granted. Reconnecting with the right
   *  scopes is the fix — a different message from `reconnect`, because the user
   *  must approve something new rather than merely re-approve. */
  | 'scope'
  /** Google is throttling. Backing off is the fix; nothing is wrong. */
  | 'rate-limit'
  /** The thing is not there (a deleted event, a calendar you lost access to). */
  | 'not-found'
  | 'unknown'

export class GoogleApiError extends Error {
  code: GoogleErrorCode
  status: number
  constructor(code: GoogleErrorCode, status: number, message: string) {
    super(message)
    this.name = 'GoogleApiError'
    this.code = code
    this.status = status
  }
}

export interface GoogleApiDeps {
  /** `GoogleSession.getAccessToken` — refreshes and single-flights on its own. */
  accessToken: () => Promise<string>
  fetch?: typeof globalThis.fetch
}

/** A hung request must not stall a panel with no error and nothing to cancel. */
const REQUEST_TIMEOUT_MS = 20_000

/** Query parameters. An **array value means a repeated key** — see `get`. */
export type GoogleParams = Record<string, string | string[] | undefined>

export class GoogleApi {
  #deps: GoogleApiDeps

  constructor(deps: GoogleApiDeps) {
    this.#deps = deps
  }

  async get<T>(url: string, params: GoogleParams = {}): Promise<T> {
    const query = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue
      // An array becomes REPEATED keys, not a joined value. Google's list-valued
      // parameters (`metadataHeaders`, …) are repeated-key parameters, and the
      // comma form is not a shorthand for them — it reads as one long value that
      // matches nothing, and the request still returns 200 with the field
      // silently missing. That is what made every mail thread show "(no
      // subject)": the headers were never requested in a form Gmail understood.
      if (Array.isArray(v)) for (const item of v) query.append(k, item)
      else query.set(k, v)
    }
    const full = query.size > 0 ? `${url}?${query.toString()}` : url

    let token: string
    try {
      token = await this.#deps.accessToken()
    } catch (err) {
      // A dead grant surfaces here rather than as a 401, because the refresh
      // failed before a request was ever made.
      throw new GoogleApiError(
        'reconnect',
        401,
        err instanceof Error ? err.message : 'not connected to Google',
      )
    }

    const res = await (this.#deps.fetch ?? globalThis.fetch)(full, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!res.ok) throw await classify(res)
    return (await res.json()) as T
  }

  /**
   * Follow `nextPageToken` until the pages run out.
   *
   * Google paginates *everything*, and the default page size is small enough
   * that "my agenda is missing the afternoon" is what a forgotten page looks
   * like. `cap` bounds a pathological loop rather than trusting the server to
   * stop.
   */
  async getAll<T>(
    url: string,
    params: GoogleParams,
    items: (page: { items?: T[]; nextPageToken?: string }) => T[],
    cap = 10,
  ): Promise<T[]> {
    const all: T[] = []
    let pageToken: string | undefined
    for (let i = 0; i < cap; i++) {
      const page = await this.get<{ items?: T[]; nextPageToken?: string }>(url, {
        ...params,
        pageToken,
      })
      all.push(...items(page))
      if (page.nextPageToken === undefined) break
      pageToken = page.nextPageToken
    }
    return all
  }
}

/**
 * Turn Google's refusal into something the UI can act on.
 *
 * The distinction that matters most is 401-vs-403: a 401 means the credential
 * is bad (reconnect), while a 403 usually means the credential is fine and the
 * *scope* or the quota is not — sending someone to reconnect for a rate limit
 * is exactly the wrong-fix problem `classifyPushFailure` exists to avoid.
 */
async function classify(res: Response): Promise<GoogleApiError> {
  const body = await res.text().catch(() => '')
  const reason = reasonOf(body)

  if (res.status === 401) {
    return new GoogleApiError('reconnect', 401, 'the Google connection is no longer valid')
  }
  if (res.status === 403) {
    if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded' || reason === 'quotaExceeded') {
      return new GoogleApiError('rate-limit', 403, 'Google is rate limiting this request')
    }
    if (reason === 'insufficientPermissions' || reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT') {
      return new GoogleApiError('scope', 403, 'this Google permission was not granted')
    }
    return new GoogleApiError('unknown', 403, `Google refused the request: ${reason ?? body}`)
  }
  if (res.status === 404) return new GoogleApiError('not-found', 404, 'not found in Google')
  if (res.status === 429) {
    return new GoogleApiError('rate-limit', 429, 'Google is rate limiting this request')
  }
  return new GoogleApiError('unknown', res.status, `Google returned ${res.status}: ${body}`)
}

/** Google buries the machine-readable reason a few levels down, and reports it
 *  in two different shapes depending on the API. Try both, guess neither. */
function reasonOf(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body)
    if (parsed === null || typeof parsed !== 'object') return null
    const error = (parsed as { error?: unknown }).error
    if (error === null || typeof error !== 'object') return null
    const e = error as { errors?: { reason?: string }[]; status?: string }
    return e.errors?.[0]?.reason ?? e.status ?? null
  } catch {
    return null
  }
}
