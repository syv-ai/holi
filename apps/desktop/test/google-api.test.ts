/**
 * `GoogleApi` — the one place a token meets a URL.
 *
 * These cover `post`, the write verb mail triage needs. `get` predates any test
 * file here, which is how its repeated-key bug reached production and rendered
 * every thread `(no subject)`; the fix is covered in `google-gmail.test.ts`
 * through the call that exercises it.
 *
 * The case that earns its place is **403 `insufficientPermissions` → `scope`**.
 * That is the exact refusal a grant older than `GOOGLE_SCOPES` produces, and
 * classifying it as `reconnect` or `unknown` would send the user to the one
 * action that does not fix it.
 */
import { describe, expect, it, vi } from 'vitest'
import { GoogleApi, GoogleApiError } from '../src/main/google/api'

/** A `fetch` that records what it was handed and answers with `response`. */
function fetchWith(response: Partial<Response> & { status?: number }) {
  const calls: { url: string; init: RequestInit }[] = []
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return {
      ok: response.status === undefined || response.status < 400,
      status: response.status ?? 200,
      json: response.json ?? (async () => ({})),
      text: response.text ?? (async () => ''),
    }
  })
  return { calls, fetch: fn as unknown as typeof globalThis.fetch }
}

function apiWith(response: Parameters<typeof fetchWith>[0], token = 'at-1') {
  const { calls, fetch } = fetchWith(response)
  return { calls, api: new GoogleApi({ accessToken: async () => token, fetch }) }
}

const MODIFY = 'https://gmail.googleapis.com/gmail/v1/users/me/threads/t1/modify'

describe('post', () => {
  it('sends a POST carrying the bearer token and a JSON body', async () => {
    const { calls, api } = apiWith({ json: async () => ({ id: 't1' }) })

    // Nothing comes back. Gmail's write endpoints do not all answer with a
    // body, so a parsed result would be `T | null` and every caller would have
    // to handle a `null` that means success. None of them wants the body.
    await expect(api.post(MODIFY, { removeLabelIds: ['UNREAD'] })).resolves.toBeUndefined()

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(MODIFY)
    expect(calls[0]!.init.method).toBe('POST')
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer at-1')
    expect(headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ removeLabelIds: ['UNREAD'] })
  })

  it('classifies a 403 insufficientPermissions as `scope`, not `reconnect`', async () => {
    // What a grant older than GOOGLE_SCOPES answers with. Reconnecting IS the
    // fix, but only because new consent is approved — telling the user to
    // "reconnect" for a rate limit or a dead token is the wrong-fix problem
    // `classify` exists to avoid, so the code has to be distinct.
    const { api } = apiWith({
      status: 403,
      text: async () =>
        JSON.stringify({ error: { errors: [{ reason: 'insufficientPermissions' }] } }),
    })

    const error = await api.post(MODIFY, {}).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(GoogleApiError)
    expect((error as GoogleApiError).code).toBe('scope')
    expect((error as GoogleApiError).status).toBe(403)
  })

  it('surfaces a dead grant as `reconnect` when the token cannot be minted', async () => {
    const { fetch } = fetchWith({})
    const api = new GoogleApi({
      accessToken: async () => {
        throw new Error('the Google connection has expired')
      },
      fetch,
    })

    const error = await api.post(MODIFY, {}).catch((e: unknown) => e)

    expect((error as GoogleApiError).code).toBe('reconnect')
  })

  it('tolerates an empty body — a modify that returns nothing is a success', async () => {
    // Gmail's write endpoints do not all answer with JSON, and throwing on
    // `res.json()` would turn a completed archive into a failed one — which
    // then reverts the UI to a state the mailbox no longer has.
    const { api } = apiWith({
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input')
      },
      text: async () => '',
    })

    await expect(api.post(MODIFY, {})).resolves.toBeUndefined()
  })
})
