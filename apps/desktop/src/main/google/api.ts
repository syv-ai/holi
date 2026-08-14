/**
 * The authenticated Google request — the one place a token meets a URL.
 *
 * Like `github/api.ts`, deliberately not a generated client: Holi makes a
 * handful of reads and four writes, and the SDK that wrapped them would be
 * larger than they are. What this owns instead is the part a generic client
 * would not do for us — **classifying a refusal** so the caller can tell
 * "reconnect Google" apart from "you are rate limited" apart from "that scope
 * was never granted".
 *
 * `post` and `postJson` are the verbs that change anything at Google (D68,
 * D70) — they differ only in whether the answer is read, and that difference
 * exists because a write reported as failed after Google accepted it is a
 * second email rather than a stale button. Everything they can reach is
 * bounded by `GOOGLE_SCOPES`, which buys thread state, drafts and sends, and no
 * ability to delete a mailbox's contents outright.
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
   * The shared write path: token, request, and Google's refusal turned into a
   * `GoogleApiError`. What each verb does with a *successful* response is the
   * only thing that differs, so that is the only thing left to the callers.
   *
   * No query-parameter path, deliberately: every write this app makes carries
   * its arguments in the body, bar the one literal `?sendUpdates=none` the
   * calendar appends itself. A second `URLSearchParams` builder would be an
   * unused branch of the one function that can do damage.
   */
  async #write(method: string, url: string, body?: unknown): Promise<Response> {
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

    const res = await (this.#deps.fetch ?? globalThis.fetch)(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    // A 403 here is most often `insufficientPermissions` — a grant older than
    // GOOGLE_SCOPES — which `classify` maps to `scope` so the UI can offer the
    // reconnect that actually fixes it. See `GoogleSession.missingScopes`.
    if (!res.ok) throw await classify(res)
    return res
  }

  /**
   * A write. **The verb the four mail label changes go through** (D68).
   *
   * **Returns nothing, deliberately.** Gmail's write endpoints do not all
   * answer with a body, so a parsed result would be `T | null` and every caller
   * would have to handle a `null` that means "it worked". None of them wants
   * the body at all — so the response is drained and discarded here, and the
   * only thing a caller learns is whether it threw. Reading `res.json()` and
   * letting it throw would report a *completed* archive as failed, which then
   * reverts the UI to a state the mailbox no longer has.
   */
  async post(url: string, body: unknown): Promise<void> {
    const res = await this.#write('POST', url, body)
    // Drained rather than ignored: leaving a body unread holds the connection
    // open. Whether it parses is not this function's business.
    await res.text().catch(() => '')
  }

  /**
   * A partial update — `events.patch` (D70).
   *
   * `PATCH` rather than `PUT`: `events.update` replaces the whole resource, so
   * every field the caller did not think to send comes back blank. Moving an
   * event must not be able to erase its description.
   */
  async patch(url: string, body: unknown): Promise<void> {
    const res = await this.#write('PATCH', url, body)
    await res.text().catch(() => '')
  }

  /** A delete — `events.delete` (D70). Answers 204 with no body. */
  async del(url: string): Promise<void> {
    const res = await this.#write('DELETE', url)
    await res.text().catch(() => '')
  }

  /**
   * A write whose answer is worth reading — `messages.send` and `drafts.create`
   * both return an id the agent is handed back (D70).
   *
   * **Not `post` with a parse bolted on, and the difference is the point.**
   * `post` drains and discards because reporting a completed archive as failed
   * reverts the UI to a state the mailbox no longer has. Here the same mistake
   * costs more: a send Google *accepted*, reported as failed, is a second email
   * to a real person once the caller retries.
   *
   * So the two outcomes are split by what Google said, not by what we could
   * read. A non-2xx throws, exactly as `post` throws. A 2xx whose body is empty
   * or unparseable resolves to **`null`** — "it worked; we could not read what
   * it said". `null` is a success with an unknown id, and no caller may treat
   * it as a failure.
   */
  async postJson<T>(url: string, body: unknown): Promise<T | null> {
    const res = await this.#write('POST', url, body)
    // The catch is the whole design, not defensiveness: past this line Google
    // has already done the thing.
    return await res.json().catch(() => null)
  }

  /**
   * A replacing write whose answer is worth reading — `drafts.update` (D71).
   *
   * `PUT`, and the contrast with `patch` above is the whole reason both exist.
   * `patch` is used where a partial update is wanted precisely *because*
   * replacing would erase fields the caller did not send. Here replacement is
   * what Gmail offers and what is wanted: a draft is rewritten whole on every
   * save, threading headers included, because a saved draft can be sent from a
   * phone and has to carry them itself.
   *
   * `null` on an unreadable 2xx means the same as it does in `postJson`: it
   * worked, and we could not read what it said.
   */
  async putJson<T>(url: string, body: unknown): Promise<T | null> {
    const res = await this.#write('PUT', url, body)
    return await res.json().catch(() => null)
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
