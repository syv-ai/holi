/**
 * `holi.fetch`: a request a vault app cannot make itself, made here.
 *
 * An app's frame has an opaque origin, so the browser sends its requests with
 * `Origin: null` and refuses any answer that does not allow that by CORS, which
 * most APIs do not. Main is no browser and has no CORS, so it makes the request
 * instead, under two rules: the app must hold `network` (declared and approved,
 * enforced by the app door as `appGrant`), and the URL's host must be one its
 * manifest lists in `hosts`, exactly. Over https only, and never with Holi's
 * own credentials: the request carries what the app put in it and nothing else.
 *
 * Bodies cross the bridge as base64, since an app's call reaches main as data.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { cap, CapabilityError, paramsObject, stringParam } from '../../../main/plugin-api'
import { manifestOf } from './grants'

/** The largest body either way: an hour of meeting audio, with room. */
export const MAX_FETCH_BYTES = 100 * 1024 * 1024
/** A transcription of a long meeting can take minutes. */
const FETCH_TIMEOUT_MS = 10 * 60 * 1000

/** A file or a field of a multipart body. */
export type FormEntry =
  { name: string; value: string } | { name: string; filename: string; type: string; base64: string }

/** What the bridge sends as the request body. */
export type FetchBody =
  | { kind: 'text'; text: string }
  | { kind: 'bytes'; type: string; base64: string }
  | { kind: 'form'; entries: FormEntry[] }

export interface FetchParams {
  url: URL
  method: string
  headers: Record<string, string>
  body: FetchBody | undefined
}

export interface FetchAnswer {
  status: number
  statusText: string
  headers: Record<string, string>
  base64: string
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']

function bad(message: string): never {
  throw new CapabilityError('BAD_REQUEST', message)
}

function bodyOf(raw: unknown): FetchBody | undefined {
  if (raw === undefined || raw === null) return undefined
  const b = paramsObject(raw)
  if (b.kind === 'text' && typeof b.text === 'string') return { kind: 'text', text: b.text }
  if (b.kind === 'bytes' && typeof b.base64 === 'string') {
    return { kind: 'bytes', type: typeof b.type === 'string' ? b.type : '', base64: b.base64 }
  }
  if (b.kind === 'form' && Array.isArray(b.entries)) {
    return {
      kind: 'form',
      entries: b.entries.map((e): FormEntry => {
        const entry = paramsObject(e)
        const name = stringParam(entry, 'name')
        if (typeof entry.value === 'string') return { name, value: entry.value }
        return {
          name,
          filename: stringParam(entry, 'filename'),
          type: typeof entry.type === 'string' ? entry.type : '',
          base64: stringParam(entry, 'base64'),
        }
      }),
    }
  }
  return bad('body must be text, bytes or form')
}

export function fetchParams(raw: unknown): FetchParams {
  const p = paramsObject(raw)
  let url: URL
  try {
    url = new URL(stringParam(p, 'url'))
  } catch {
    return bad('url is not a URL')
  }
  const method = (typeof p.method === 'string' ? p.method : 'GET').toUpperCase()
  if (!METHODS.includes(method)) bad(`method ${method} is not allowed`)
  const headers: Record<string, string> = {}
  if (p.headers !== undefined) {
    for (const [key, value] of Object.entries(paramsObject(p.headers))) {
      if (typeof value === 'string') headers[key] = value
    }
  }
  return { url, method, headers, body: bodyOf(p.body) }
}

/** Refused unless the URL is https to a host the manifest lists, exactly. */
export function checkHost(url: URL, hosts: readonly string[] | undefined, bundle: string): void {
  if (url.protocol !== 'https:') bad('holi.fetch is https only')
  if (url.username !== '' || url.password !== '') bad('a URL may not carry credentials')
  const host = url.hostname.toLowerCase()
  if (!(hosts ?? []).includes(host)) {
    throw new CapabilityError(
      'FORBIDDEN',
      `add "${host}" to hosts in ${bundle}/app.yaml to reach it`,
    )
  }
}

function requestBody(body: FetchBody | undefined): BodyInit | undefined {
  if (body === undefined) return undefined
  const bytes = (base64: string): Uint8Array<ArrayBuffer> => {
    const buffer = Buffer.from(base64, 'base64')
    if (buffer.length > MAX_FETCH_BYTES) bad('the body is too large')
    return new Uint8Array(buffer)
  }
  switch (body.kind) {
    case 'text':
      return body.text
    case 'bytes':
      return new Blob([bytes(body.base64)], { type: body.type })
    case 'form': {
      const form = new FormData()
      for (const entry of body.entries) {
        if ('value' in entry) form.append(entry.name, entry.value)
        else {
          form.append(
            entry.name,
            new Blob([bytes(entry.base64)], { type: entry.type }),
            entry.filename,
          )
        }
      }
      return form
    }
  }
}

export async function runFetch(params: FetchParams): Promise<FetchAnswer> {
  const headers = new Headers(params.headers)
  // A form's boundary is fetch's to write: one the app set would not match.
  if (params.body?.kind === 'form') headers.delete('content-type')
  let response: Response
  try {
    response = await fetch(params.url, {
      method: params.method,
      headers,
      body: requestBody(params.body),
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (err) {
    if (err instanceof CapabilityError) throw err
    throw new CapabilityError(
      'UNAVAILABLE',
      `could not reach ${params.url.hostname}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const body = Buffer.from(await response.arrayBuffer())
  if (body.length > MAX_FETCH_BYTES) bad('the answer is too large')
  return {
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    base64: body.toString('base64'),
  }
}

export const netCapabilities = () => ({
  'net.fetch': cap({
    doors: ['app'],
    appGrant: 'network',
    params: fetchParams,
    run: async (ctx, params) => {
      const bundle = ctx.bundle
      if (bundle === null) throw new CapabilityError('BAD_REQUEST', 'only an app may ask')
      checkHost(params.url, (await manifestOf(ctx.root, bundle))?.hosts, bundle)
      return runFetch(params)
    },
  }),
})
