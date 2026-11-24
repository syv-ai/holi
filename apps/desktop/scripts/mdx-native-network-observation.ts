import { createHook } from 'node:async_hooks'
import { subscribe, unsubscribe } from 'node:diagnostics_channel'
import { Resolver } from 'node:dns/promises'
import { errorMonitor } from 'node:events'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { isIP } from 'node:net'
import tls, { type TLSSocket } from 'node:tls'
import { resolveMdxExternalModule } from '../src/main/mdx-external-policy'

export const fixtureOrigins = [
  'https://raw.githubusercontent.com',
  'https://esm.run',
  'https://cdn.jsdelivr.net',
] as const
const [rawOrigin, redirectOrigin, cdnOrigin] = fixtureOrigins
const redirectPath = '/nanoid@5.1.5/url-alphabet/index.js'
const redirectSource = new URL(redirectPath, redirectOrigin)
const cdnPath = `/npm${redirectPath}/+esm`
const cdnTarget = `${cdnOrigin}${cdnPath}`
const redirectStatuses = new Set([301, 302, 303, 307, 308])
// Large enough to span TLS records but below the production 256 KiB cap.
const streamPath = '/npm/lodash@4.17.21/lodash.min.js'
const labels = [...fixtureOrigins, 'unexpected', 'unattributed'] as const
type Destination = (typeof labels)[number]
type Route = 'entry' | 'relative' | 'redirect' | 'cdn' | 'stream' | 'unexpected' | 'unattributed'

function destination(host: unknown): Destination {
  if (typeof host !== 'string' || !host) return 'unattributed'
  const origin = `https://${host.toLowerCase().replace(/:443$/, '')}`
  return fixtureOrigins.find((expected) => expected === origin) ?? 'unexpected'
}

function expectedRedirect(response: IncomingMessage) {
  if (!redirectStatuses.has(response.statusCode ?? 0)) return false
  const locations = response.headersDistinct.location
  if (locations?.length !== 1 || !locations[0] || locations[0].includes('#')) return false
  const target = resolveMdxExternalModule(locations[0], redirectSource)
  return 'url' in target && target.url.href === cdnTarget
}

function sameIp(left: unknown, right: string | undefined) {
  if (typeof left !== 'string' || !right) return false
  if (left === right) return isIP(left) !== 0
  if (isIP(left) !== 6 || isIP(right) !== 6) return false
  try {
    return new URL(`https://[${left}]`).hostname === new URL(`https://[${right}]`).hostname
  } catch {
    return false
  }
}

/** Observe only this process's Node transport. The fixture SHA comes from the validated native runner. */
export function observeMdxNativeNetwork(fixtureSha: string) {
  const fixturePath = `/syv-ai/holi/${fixtureSha}/apps/desktop/scripts/fixtures/mdx-external`
  // A CDN request needs a preceding, as-yet-unmatched redirect response from
  // the exact fixture source. Only the exact expected target earns that credit.
  // Count matching observations, not logical fetch IDs or raw Location values.
  let observedRedirects = 0
  function routeOf(request: ClientRequest, origin: Destination): Route {
    if (origin === 'unattributed' || origin === 'unexpected') return origin
    if (request.protocol !== 'https:') return 'unexpected'
    switch (origin) {
      case rawOrigin:
        if (request.path === `${fixturePath}/entry.js`) return 'entry'
        if (request.path === `${fixturePath}/relative.js`) return 'relative'
        break
      case redirectOrigin:
        if (request.path === redirectPath) return 'redirect'
        break
      case cdnOrigin:
        if (request.path === cdnPath && observedRedirects > 0) return 'cdn'
        if (request.path === streamPath) return 'stream'
    }
    return 'unexpected'
  }
  const requestDestination = (route: Route, origin: Destination) =>
    route === 'unexpected' || route === 'unattributed' ? route : origin
  const credentials = (request: ClientRequest) =>
    ['cookie', 'authorization', 'proxy-authorization'].some((name) => request.hasHeader(name))

  const counters = () => ({
    resolve4: 0,
    resolve6: 0,
    dnsResources: 0,
    socketResources: 0,
    tls: 0,
    verifiedPeer: 0,
    httpCreated: 0,
    httpStarted: 0,
    httpResponses: 0,
  })
  const destinations = Object.fromEntries(labels.map((label) => [label, counters()])) as Record<
    Destination,
    ReturnType<typeof counters>
  >
  const network = {
    dns: 0,
    socket: 0,
    destinations,
    requests: [] as Array<{ route: Route; get: boolean; credentials: boolean }>,
    responses: [] as Array<{ route: Route; status: number | undefined }>,
  }

  // Node 24.18's documented diagnostics channels expose HTTP requests/responses,
  // but no DNS destination and no SNI on the socket-creation channel. Observe
  // public resolver/TLS calls without replacing the actual transport or answers.
  // The original aggregate async resource counts remain a tripwire: if an
  // allocation cannot be tied to a call, it is *unattributed*, not zero.
  let resolving: Destination | undefined
  let connecting: Destination | undefined
  const socketsByAsyncId = new Map<number, Destination>()
  const networkHook = createHook({
    init(id, type, trigger) {
      if (type === 'QUERYWRAP' || type === 'GETADDRINFOREQWRAP') {
        network.dns += 1
        // The production path uses resolve4/resolve6, not the system lookup.
        const origin = type === 'QUERYWRAP' ? resolving : undefined
        destinations[origin ?? 'unattributed'].dnsResources += 1
      }
      const socket = type === 'TCPWRAP' || type === 'TCPCONNECTWRAP' || type === 'TLSWRAP'
      if (socket || type === 'TickObject') {
        const origin = connecting ?? socketsByAsyncId.get(trigger)
        // Follow the transport's socket/next-tick trigger, not arbitrary promises
        // that may run unrelated operations later in the same async context.
        if (origin) socketsByAsyncId.set(id, origin)
        if (socket) {
          network.socket += 1
          destinations[origin ?? 'unattributed'].socketResources += 1
        }
      }
    },
    destroy(id) {
      socketsByAsyncId.delete(id)
    },
  }).enable()

  const restoreResolvers = (['resolve4', 'resolve6'] as const).map((family) => {
    const original = Resolver.prototype[family]
    const descriptor = Object.getOwnPropertyDescriptor(Resolver.prototype, family)
    Resolver.prototype[family] = function (this: Resolver, ...args: unknown[]) {
      const origin = destination(args[0])
      destinations[origin][family] += 1
      const previous = resolving
      resolving = origin
      try {
        return Reflect.apply(original, this, args)
      } finally {
        resolving = previous
      }
    }
    return () => {
      if (descriptor) Object.defineProperty(Resolver.prototype, family, descriptor)
      else Reflect.deleteProperty(Resolver.prototype, family)
    }
  })

  const originalConnect = tls.connect
  const verifiedSockets = new WeakMap<TLSSocket, Destination>()
  tls.connect = function (this: typeof tls, ...args: unknown[]) {
    // The HTTPS Agent uses the public options-first form of tls.connect.
    // Any other form without an observable SNI is counted as unattributed.
    const options = args[0]
    // Only read the plain options emitted by the Agent; don't invoke accessors
    // a second time on behalf of the observer.
    const option = (key: string): unknown =>
      options && typeof options === 'object'
        ? Object.getOwnPropertyDescriptor(options, key)?.value
        : undefined
    const origin = destination(option('servername'))
    const address = option('host')
    destinations[origin].tls += 1
    const previous = connecting
    connecting = origin
    let socket: TLSSocket
    try {
      socket = Reflect.apply(originalConnect, this, args)
    } finally {
      connecting = previous
    }
    socket.once('secureConnect', () => {
      if (socket.authorized && socket.remotePort === 443 && sameIp(address, socket.remoteAddress)) {
        destinations[origin].verifiedPeer += 1
        verifiedSockets.set(socket, origin)
      }
    })
    return socket
  }

  // Separate from passive observation: arm one client-side stream stall for the
  // revocation race. Pause without consuming the buffered chunk or changing DNS,
  // the HTTP request, the TLS session, its peer or the production abort signal.
  let stream:
    | {
        requests: number
        receivedBody: boolean
        verifiedPeer: boolean
        paused: boolean
        closed: boolean
        incompleteAtClose: boolean
        abortError: boolean
        response?: IncomingMessage
        socket?: TLSSocket
        release?: () => void
      }
    | undefined
  const onCreated = (event: unknown) => {
    const { request } = event as { request: ClientRequest }
    const origin = destination(request.getHeader('host'))
    const route = routeOf(request, origin)
    destinations[requestDestination(route, origin)].httpCreated += 1
    const hold = stream
    if (!hold || route !== 'stream') return
    if (++hold.requests !== 1) return
    const recordAbort = (error: NodeJS.ErrnoException) => {
      if (error.code === 'ABORT_ERR') hold.abortError = true
    }
    request.on(errorMonitor, recordAbort)
    request.once('response', (response) => {
      const socket = response.socket as TLSSocket
      hold.response = response
      hold.socket = socket
      hold.verifiedPeer = verifiedSockets.get(socket) === cdnOrigin
      socket.on(errorMonitor, recordAbort)
      socket.once('close', () => {
        hold.closed = true
        hold.incompleteAtClose = !response.complete
        hold.release?.()
      })
      response.once('readable', () => {
        hold.receivedBody = response.readableLength > 0
        if (
          !hold.receivedBody ||
          !hold.verifiedPeer ||
          response.statusCode !== 200 ||
          response.complete ||
          socket.destroyed
        )
          return
        const resume = socket.resume
        const resumeDescriptor = Object.getOwnPropertyDescriptor(socket, 'resume')
        // IncomingMessage may try to resume reads as its consumer awaits the
        // next chunk. Block those resumes on this socket only, until close.
        socket.resume = () => socket
        socket.pause()
        hold.paused = socket.isPaused()
        hold.release = () => {
          if (resumeDescriptor) Object.defineProperty(socket, 'resume', resumeDescriptor)
          else Reflect.deleteProperty(socket, 'resume')
          if (!socket.destroyed) Reflect.apply(resume, socket, [])
          hold.release = undefined
        }
      })
    })
  }
  const started = new WeakMap<ClientRequest, (typeof network.requests)[number]>()
  const onRequest = (event: unknown) => {
    const { request } = event as { request: ClientRequest }
    const origin = destination(request.getHeader('host'))
    let route = routeOf(request, origin)
    if (route !== 'unexpected' && route !== 'unattributed') {
      // Host alone does not establish identity. Match it to the SNI of the
      // authorized TLS connection at the actual chosen IP and port.
      const peer = verifiedSockets.get(request.socket as TLSSocket)
      if (!peer) route = 'unattributed'
      else if (peer !== origin) route = 'unexpected'
    }
    if (route === 'cdn') observedRedirects -= 1
    const observation = { route, get: request.method === 'GET', credentials: credentials(request) }
    destinations[requestDestination(route, origin)].httpStarted += 1
    network.requests.push(observation)
    started.set(request, observation)
  }
  const onResponse = (event: unknown) => {
    const { request, response } = event as { request: ClientRequest; response: IncomingMessage }
    const observation = started.get(request)
    let route = observation?.route ?? 'unattributed'
    if (route === 'redirect') {
      if (observation?.get && !observation.credentials && expectedRedirect(response)) {
        observedRedirects += 1
      } else {
        route = 'unexpected'
      }
    }
    const origin = destination(request.getHeader('host'))
    destinations[requestDestination(route, origin)].httpResponses += 1
    network.responses.push({ route, status: response.statusCode })
  }
  subscribe('http.client.request.created', onCreated)
  subscribe('http.client.request.start', onRequest)
  subscribe('http.client.response.finish', onResponse)

  return {
    network,
    armStream() {
      if (stream) throw new Error('The native stream observation is already armed')
      stream = {
        requests: 0,
        receivedBody: false,
        verifiedPeer: false,
        paused: false,
        closed: false,
        incompleteAtClose: false,
        abortError: false,
      }
      return `${cdnOrigin}${streamPath}`
    },
    streamStatus() {
      if (!stream) return null
      const {
        requests,
        receivedBody,
        verifiedPeer,
        paused,
        closed,
        incompleteAtClose,
        abortError,
      } = stream
      return {
        requests,
        receivedBody,
        verifiedPeer,
        paused,
        active: !!(
          paused &&
          !closed &&
          stream.socket?.isPaused() &&
          !stream.socket.destroyed &&
          !stream.response?.complete
        ),
        closed,
        incompleteAtClose,
        abortError,
      }
    },
    close() {
      stream?.release?.()
      networkHook.disable()
      for (const restore of restoreResolvers) restore()
      tls.connect = originalConnect
      unsubscribe('http.client.request.created', onCreated)
      unsubscribe('http.client.request.start', onRequest)
      unsubscribe('http.client.response.finish', onResponse)
    },
  }
}
