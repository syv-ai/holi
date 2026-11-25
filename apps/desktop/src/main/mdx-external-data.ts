import { Resolver } from 'node:dns/promises'
import { Agent, request } from 'node:https'
import type { IncomingMessage } from 'node:http'
import { BlockList, isIP } from 'node:net'
import os from 'node:os'
import {
  resolveMdxExternalModule,
  resolveMdxExternalResource,
  type MdxExternalResourceKind,
} from './mdx-external-policy'

const DEADLINE_MS = 8_000
const BODY_LIMIT = 256 * 1024
const REDIRECT_LIMIT = 3

const MODULE_MEDIA_TYPES = new Set([
  'text/javascript',
  'application/javascript',
  'text/ecmascript',
  'application/ecmascript',
])
// Match the whole field, not just its essence: malformed parameters and coalesced
// Content-Type values must not turn an ambiguous response into module text.
const MEDIA_TOKEN = String.raw`[!#$%&'*+.^_\x60|~\da-z-]+`
const MEDIA_QUOTED = String.raw`"(?:[\t\x20-\x21\x23-\x5b\x5d-\x7e\x80-\xff]|\\[\t\x20-\x7e\x80-\xff])*"`
const CONTENT_TYPE = new RegExp(
  String.raw`^[\t ]*(${MEDIA_TOKEN}/${MEDIA_TOKEN})(?:[\t ]*;[\t ]*${MEDIA_TOKEN}=(?:${MEDIA_TOKEN}|${MEDIA_QUOTED}))*[\t ]*$`,
  'i',
)

const errorMessages = {
  'consent-needed': 'External MDX dependency requires consent',
  'access-changed': 'External MDX dependency access is unavailable',
  'unsafe-url': 'External MDX dependency URL is not supported',
  'unsupported-format': 'External MDX dependency module format is not supported',
  'unsafe-address':
    'External MDX dependency did not resolve exclusively to remote public addresses',
  'unsafe-peer': 'External MDX dependency TLS peer did not match the vetted address',
  redirect: 'External MDX dependency redirect is invalid or exceeds the limit',
  response: 'External MDX dependency did not return an unencoded UTF-8 response',
  'too-large': 'External MDX dependency exceeds the size limit',
  network: 'External MDX dependency could not be fetched',
  aborted: 'External MDX dependency fetch was cancelled',
  timeout: 'External MDX dependency fetch timed out',
}

export class MdxExternalDataError extends Error {
  constructor(
    readonly code: keyof typeof errorMessages,
    readonly origin?: string,
  ) {
    super(errorMessages[code])
    this.name = 'MdxExternalDataError'
  }
}

/**
 * Fetch UTF-8 module text as inert data. The final response must declare a supported media type.
 * `assertAccess` must check both current ownership and consent for the canonical origin every
 * time it is called. Return false for missing consent (reported with the origin); throw if the
 * caller is no longer current or cannot check access.
 * The deadline covers authorization, DNS, TLS and response streaming across all redirects.
 */
export async function fetchMdxExternalData(options: {
  url: string
  signal: AbortSignal
  assertAccess(origin: string, signal: AbortSignal): boolean | Promise<boolean>
}): Promise<{ url: string; text: string }> {
  const result = await fetchMdxExternalResourceData({ ...options, kind: 'module' })
  return { url: result.url, text: result.text! }
}

export async function fetchMdxExternalResourceData(options: {
  url: string
  signal: AbortSignal
  assertAccess(origin: string, signal: AbortSignal): boolean | Promise<boolean>
  kind: MdxExternalResourceKind
}): Promise<{ url: string; bytes: Uint8Array; text?: string }> {
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), DEADLINE_MS)
  const signal = AbortSignal.any([options.signal, deadline.signal])
  try {
    signal.throwIfAborted()
    let destination =
      options.kind === 'module'
        ? resolveMdxExternalModule(options.url)
        : resolveMdxExternalResource(options.url, options.kind)
    for (let redirects = 0; ; redirects++) {
      if ('error' in destination) throw new MdxExternalDataError(destination.error)
      const target = destination.url
      const { origin, hostname } = target
      const check = () => assertAccess(() => options.assertAccess(origin, signal), origin, signal)
      await check()
      const { first, answers } = await resolvePublicAddresses(hostname, signal)
      await check()
      rejectLocalAddresses(answers)
      const result = await fetchHop(target, first, check, signal, options.kind)
      await check()
      if ('bytes' in result) {
        if (options.kind === 'asset') return { url: target.href, bytes: result.bytes }
        try {
          return {
            url: target.href,
            bytes: result.bytes,
            text: new TextDecoder('utf-8', { fatal: true }).decode(result.bytes),
          }
        } catch {
          throw new MdxExternalDataError('response')
        }
      }
      if (redirects >= REDIRECT_LIMIT) throw new MdxExternalDataError('redirect')
      destination =
        options.kind === 'module'
          ? resolveMdxExternalModule(result.location, target)
          : resolveMdxExternalResource(result.location, options.kind, target)
    }
  } catch (error) {
    // Do not propagate URL parse errors, DNS/TLS errors, callback exceptions or abort reasons.
    if (options.signal.aborted) throw new MdxExternalDataError('aborted')
    if (deadline.signal.aborted) throw new MdxExternalDataError('timeout')
    if (error instanceof MdxExternalDataError) throw error
    throw new MdxExternalDataError('network')
  } finally {
    clearTimeout(timer)
  }
}

async function assertAccess(
  check: () => boolean | Promise<boolean>,
  origin: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  let onAbort!: () => void
  let allowed: boolean
  try {
    allowed = await new Promise<boolean>((resolve, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
      // Absorb a late completion if authorization is still in flight at cancellation.
      resolve(check())
    })
  } catch {
    throw new MdxExternalDataError('access-changed')
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
  signal.throwIfAborted()
  if (allowed !== true) throw new MdxExternalDataError('consent-needed', origin)
}

// Reject special-purpose space even where parts of it are designated globally reachable.
// IPv6 is limited to current global unicast space (IANA special-purpose subnet exceptions below).
const nonPublic = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['168.63.129.16', 32], // Azure platform virtual IP
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  nonPublic.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['2620:4f:8000::', 48],
  ['3ffe::', 16],
  ['3fff::', 20],
] as const)
  nonPublic.addSubnet(network, prefix, 'ipv6')

async function resolvePublicAddresses(
  hostname: string,
  signal: AbortSignal,
): Promise<{ first: string; answers: string[] }> {
  const resolver = new Resolver()
  const cancel = () => resolver.cancel()
  const emptyIfNoRecords = (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENODATA') return []
    throw error
  }
  signal.throwIfAborted()
  signal.addEventListener('abort', cancel, { once: true })
  try {
    const [v4, v6] = await Promise.all([
      resolver.resolve4(hostname).catch(emptyIfNoRecords),
      resolver.resolve6(hostname).catch(emptyIfNoRecords),
    ])
    signal.throwIfAborted()
    const first = v4[0] ?? v6[0]
    if (
      !first ||
      v4.some((ip) => isIP(ip) !== 4 || nonPublic.check(ip, 'ipv4')) ||
      v6.some(
        (ip) =>
          isIP(ip) !== 6 ||
          ip.includes('%') ||
          !/^[23][\da-f]{3}:/i.test(ip) ||
          nonPublic.check(ip, 'ipv6'),
      )
    )
      throw new MdxExternalDataError('unsafe-address')
    return { first, answers: [...v4, ...v6] }
  } finally {
    signal.removeEventListener('abort', cancel)
    cancel()
  }
}

function rejectLocalAddresses(answers: string[]): void {
  // Refresh after DNS and authorization on every hop, immediately before TLS can dial.
  // A globally routable address can still terminate here. Check every answer by IP bytes,
  // not interface subnet or text spelling (including mapped IPv4 and IPv6 zone suffixes).
  const local = new BlockList()
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const { address } of addresses ?? []) {
      const ip = address.replace(/%.*/, '')
      local.addAddress(ip, isIP(ip) === 4 ? 'ipv4' : 'ipv6')
    }
  }
  if (answers.some((ip) => local.check(ip, isIP(ip) === 4 ? 'ipv4' : 'ipv6')))
    throw new MdxExternalDataError('unsafe-address')
}

async function fetchHop(
  target: URL,
  address: string,
  check: () => Promise<void>,
  signal: AbortSignal,
  kind: MdxExternalResourceKind,
): Promise<{ bytes: Uint8Array } | { location: string }> {
  signal.throwIfAborted()
  // Exact address matching by bytes, including IPv6 spellings and IPv4-mapped IPv6.
  const pinned = new BlockList()
  pinned.addAddress(address, isIP(address) === 6 ? 'ipv6' : 'ipv4')
  // Never use the global Agent (which can inherit proxy settings), pool, or resume TLS sessions.
  const agent = new Agent({ keepAlive: false, maxCachedSessions: 0 })
  try {
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request({
        agent,
        hostname: address, // Numeric vetted destination: no second DNS lookup or address fallback.
        servername: target.hostname, // SNI and standard certificate hostname verification.
        rejectUnauthorized: true,
        port: 443,
        method: 'GET',
        path: target.pathname + target.search,
        headers: {
          Host: target.hostname,
          Accept: 'text/javascript, application/javascript, text/plain;q=0.9, */*;q=0.1',
          'Accept-Encoding': 'identity',
          Connection: 'close',
        },
        maxHeaderSize: 16 * 1024,
        signal,
      })
      req.once('error', reject)
      req.once('close', () => reject(new MdxExternalDataError('network')))
      req.once('response', (res) => {
        // The response may be destroyed by abort while we await access below.
        res.on('error', reject)
        resolve(res)
      })
      req.once('socket', (socket) => {
        socket.once('secureConnect', () => {
          // No HTTP bytes have been sent yet. Verify the connected peer and current grant.
          const peer = socket.remoteAddress
          const family = peer && isIP(peer)
          if (
            !peer ||
            !family ||
            peer.includes('%') ||
            !pinned.check(peer, family === 6 ? 'ipv6' : 'ipv4')
          ) {
            reject(new MdxExternalDataError('unsafe-peer'))
            return
          }
          void check()
            .then(() => {
              if (!req.destroyed && !signal.aborted) req.end()
            })
            .catch(reject)
        })
      })
    })
    await check()
    if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
      const locations = response.headersDistinct.location
      if (locations?.length !== 1 || !locations[0]) throw new MdxExternalDataError('redirect')
      return { location: locations[0] }
    }
    const encoding = response.headers['content-encoding']
    if (response.statusCode !== 200 || (encoding && encoding.toLowerCase() !== 'identity'))
      throw new MdxExternalDataError('response')
    const types = response.headersDistinct['content-type']
    const mediaType =
      types?.length === 1 ? CONTENT_TYPE.exec(types[0] ?? '')?.[1]?.toLowerCase() : undefined
    const validType =
      kind === 'module'
        ? MODULE_MEDIA_TYPES.has(mediaType ?? '') ||
          (mediaType === 'text/plain' && target.origin === 'https://raw.githubusercontent.com')
        : kind === 'css'
          ? mediaType === 'text/css' ||
            (mediaType === 'text/plain' && target.origin === 'https://raw.githubusercontent.com')
          : /^image\/(?:png|jpeg|gif|webp|svg\+xml|avif)$/.test(mediaType ?? '') ||
            /^font\/(?:woff|woff2|ttf|otf)$/.test(mediaType ?? '') ||
            /^audio\//.test(mediaType ?? '') ||
            /^video\//.test(mediaType ?? '') ||
            mediaType === 'application/font-woff' ||
            mediaType === 'application/vnd.ms-fontobject'
    if (!validType) throw new MdxExternalDataError('unsupported-format')
    if (Number(response.headers['content-length']) > BODY_LIMIT)
      throw new MdxExternalDataError('too-large')
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of response as AsyncIterable<Buffer>) {
      size += chunk.length
      if (size > BODY_LIMIT) throw new MdxExternalDataError('too-large')
      chunks.push(chunk)
    }
    if (!response.complete) throw new MdxExternalDataError('response')
    return { bytes: Uint8Array.from(Buffer.concat(chunks, size)) }
  } finally {
    // Do not drain unwanted redirect/error bodies or allow a later hop to reuse this socket.
    agent.destroy()
  }
}
