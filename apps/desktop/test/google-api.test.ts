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
const SEND = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'

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

/**
 * `postJson` — `post`'s twin for the two writes whose answer is worth reading
 * (`messages.send`, `drafts.create` both return an id).
 *
 * It is deliberately **not** `post` with a parse bolted on. `post` drains and
 * discards because turning a completed archive into a reported failure reverts
 * the UI to a state the mailbox no longer has. Here the same mistake is worse:
 * a send that Google accepted, reported as failed, is a second email to a real
 * person. So an unreadable 2xx body is `null` — "it worked, we could not read
 * what it said" — and never a throw.
 */
describe('postJson', () => {
  it('returns the parsed body on 200', async () => {
    const { calls, api } = apiWith({ json: async () => ({ id: 'm-1', threadId: 't1' }) })

    await expect(api.postJson<{ id: string }>(SEND, { raw: 'x' })).resolves.toEqual({
      id: 'm-1',
      threadId: 't1',
    })
    expect(calls[0]!.init.method).toBe('POST')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ raw: 'x' })
  })

  it('returns null when a 200 carries no body', async () => {
    const { api } = apiWith({
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input')
      },
      text: async () => '',
    })

    await expect(api.postJson(SEND, {})).resolves.toBeNull()
  })

  // The test that stops a double send. Google answered 2xx — the mail is gone.
  // Whatever the body was, reporting failure here makes the agent try again.
  it('returns null rather than throwing when a 200 body is not JSON', async () => {
    const { api } = apiWith({
      json: async () => {
        throw new SyntaxError('Unexpected token <')
      },
      text: async () => '<html>proxy says hello</html>',
    })

    await expect(api.postJson(SEND, {})).resolves.toBeNull()
  })

  it('throws on a 403 exactly as post does', async () => {
    const { api } = apiWith({
      status: 403,
      text: async () =>
        JSON.stringify({ error: { errors: [{ reason: 'insufficientPermissions' }] } }),
    })

    const error = await api.postJson(SEND, {}).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(GoogleApiError)
    expect((error as GoogleApiError).code).toBe('scope')
  })
})
