/**
 * `holi.fetch`: a request a vault app cannot make itself, made here.
 *
 * An app's frame has an opaque origin, so the browser sends its requests with
 * `Origin: null` and refuses any answer that does not allow that by CORS, which
 * most APIs do not. Main is no browser and has no CORS, so it makes the request
 * instead, under these rules: the app must hold `network` (declared and
 * approved, enforced by the app door as `appGrant`); the URL's host must be one
 * its manifest lists in `hosts`, exactly, and a name, not an IP address or
 * `localhost`; the name must resolve to public addresses only, so a listed
 * name cannot be pointed at this machine or its network; over https only; and
 * never with Holi's own credentials: the request carries what the app put in it
 * and nothing else. A redirect is refused rather than followed, since it could
 * lead anywhere.
 *
 * The address check is made before the request, by its own lookup, so a name
 * whose DNS answer changes between the two (rebinding) is not caught. The host
 * is still one the app named and the person approved.
 *
 * Bodies cross the bridge as base64, since an app's call reaches main as data,
 * and are capped at `MAX_FETCH_BYTES` each way, counted as they arrive.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { cap, CapabilityError, paramsObject, stringParam } from '../../../main/plugin-api'
import { manifestOf } from './grants'

/** The largest body either way, all its parts together: an hour of meeting
 *  audio, with room. */
export const MAX_FETCH_BYTES = 100 * 1024 * 1024
/** An API working through a large upload can take minutes to answer. */
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

/** A name no public server answers to: this machine. */
function isLoopbackName(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost')
}

/** Refused unless the URL is https to a host the manifest lists, exactly, by
 *  name. */
export function checkHost(url: URL, hosts: readonly string[] | undefined, bundle: string): void {
  if (url.protocol !== 'https:') bad('holi.fetch is https only')
  if (url.username !== '' || url.password !== '') bad('a URL may not carry credentials')
  const host = url.hostname.toLowerCase()
  // An IPv6 literal's hostname keeps its brackets.
  if (isIP(host.replace(/^\[|\]$/g, '')) !== 0)
    bad('holi.fetch reaches a host by name, not by address')
  if (isLoopbackName(host)) bad(`holi.fetch may not reach ${host}`)
  if (!(hosts ?? []).includes(host)) {
    throw new CapabilityError(
      'FORBIDDEN',
      `add "${host}" to hosts in ${bundle}/app.yaml to reach it`,
    )
  }
}

/** Addresses that are this machine, its network or nobody's: never a public
 *  API. */
const PRIVATE = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  PRIVATE.addSubnet(net, prefix, 'ipv4')
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  PRIVATE.addSubnet(net, prefix, 'ipv6')
}

export function isPrivateAddress(address: string): boolean {
  // An IPv4 address written as IPv6 (`::ffff:10.0.0.1`) is that IPv4 address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1]
  if (mapped !== undefined) return PRIVATE.check(mapped, 'ipv4')
  const family = isIP(address)
  if (family === 0) return true
  return PRIVATE.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

export type Resolve = (host: string) => Promise<readonly string[]>

const resolveAll: Resolve = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address)

/** Refused unless every address the host resolves to is public. */
export async function checkAddress(host: string, resolve: Resolve = resolveAll): Promise<void> {
  let addresses: readonly string[]
  try {
    addresses = await resolve(host)
  } catch (err) {
    throw new CapabilityError(
      'UNAVAILABLE',
      `could not find ${host}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new CapabilityError(
      'FORBIDDEN',
      `${host} is on this machine or its network, which holi.fetch may not reach`,
    )
  }
}

function requestBody(body: FetchBody | undefined): BodyInit | undefined {
  if (body === undefined) return undefined
  // Counted over every part before any is decoded: the cap is the request's,
  // not each part's.
  const size =
    body.kind === 'text'
      ? Buffer.byteLength(body.text)
      : body.kind === 'bytes'
        ? Buffer.byteLength(body.base64, 'base64')
        : body.entries.reduce(
            (sum, e) =>
              sum +
              Buffer.byteLength(e.name) +
              ('value' in e ? Buffer.byteLength(e.value) : Buffer.byteLength(e.base64, 'base64')),
            0,
          )
  if (size > MAX_FETCH_BYTES) bad('the body is too large')
  const bytes = (base64: string): Uint8Array<ArrayBuffer> =>
    new Uint8Array(Buffer.from(base64, 'base64'))
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

/** The answer's body, refused as soon as it passes `MAX_FETCH_BYTES`, before
 *  the rest is read. */
async function readCapped(response: Response): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_FETCH_BYTES) {
    await response.body?.cancel().catch(() => {})
    bad('the answer is too large')
  }
  if (response.body === null) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_FETCH_BYTES) {
      await reader.cancel().catch(() => {})
      bad('the answer is too large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

export async function runFetch(params: FetchParams): Promise<FetchAnswer> {
  const headers = new Headers(params.headers)
  // A form's boundary is fetch's to write: one the app set would not match.
  if (params.body?.kind === 'form') headers.delete('content-type')
  const body = requestBody(params.body)
  let response: Response
  let answer: Buffer
  try {
    response = await fetch(params.url, {
      method: params.method,
      headers,
      body,
      // Not followed, since it could lead anywhere: the app is told why.
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
      await response.body?.cancel().catch(() => {})
      throw new CapabilityError(
        'UNAVAILABLE',
        `${params.url.hostname} answered with a redirect, which holi.fetch does not follow`,
      )
    }
    answer = await readCapped(response)
  } catch (err) {
    if (err instanceof CapabilityError) throw err
    throw new CapabilityError(
      'UNAVAILABLE',
      `could not reach ${params.url.hostname}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  return {
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    base64: answer.toString('base64'),
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
      await checkAddress(params.url.hostname)
      return runFetch(params)
    },
  }),
})
