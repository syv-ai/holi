import { randomBytes } from 'node:crypto'
import type { WebContents, WebFrameMain } from 'electron'
import { createFrameContextMetadata, type FrameContext } from './frame-context-metadata'
import { createFrameContextSessionOwner } from './frame-context-session-owner'
import { createFrameContextNativeProbes } from './frame-context-native-probes'

type RuntimeContext = FrameContext

const worldNamesByContents = new WeakMap<WebContents, Map<string, string>>()

/** Adapter-local authenticated context indices plus a persistent, non-authoritative world namespace. */
function createFrameContextRuntime(contents: WebContents) {
  let names = worldNamesByContents.get(contents)
  if (!names) worldNamesByContents.set(contents, (names = new Map()))
  const metadata = createFrameContextMetadata()
  const worldNames = {
    forPurpose(purpose: string) {
      let name = names!.get(purpose)
      if (!name) {
        name = `holi-${purpose}-${randomBytes(24).toString('hex')}`
        names!.set(purpose, name)
      }
      return name
    },
  }
  return { metadata, worldNames }
}

/** Immutable host-owned identity that must change whenever its owner departs. */
export type FrameCapture = Readonly<{
  tab: object
  document: object
  presentation: object
}>

declare const addressBrand: unique symbol
export type FrameAddress = object & { readonly [addressBrand]: true }

type Context = RuntimeContext

type AddressState = {
  frame: WebFrameMain
  frameId: string
  nativeProcessId: number
  nativeUrl: string
  sessionId?: string
  contextId: number
  uniqueId: string
  generation: number
  backendNodeId: number
  ownerContext: Context
  ownerContextSession?: string
  ownerChain: Array<{ context: Context; sessionId?: string; frame: WebFrameMain }>
  capture: FrameCapture
  epoch: number
  address?: FrameAddress
}

/** Main-private correlation between native frames and their browser-authenticated CDP identities. */
export function createFrameAddressingRuntime(
  contents: WebContents,
  current: (capture: FrameCapture) => boolean,
) {
  const runtime = createFrameContextRuntime(contents)
  const { metadata } = runtime
  const states = new WeakMap<FrameAddress, AddressState>()
  const leases = new WeakMap<object, Map<WebFrameMain, FrameAddress>>()
  const captureStates = new Map<object, Set<AddressState>>()
  const revoked = new WeakSet<object>()
  const focusObservers = new WeakMap<FrameAddress, Set<(focused: boolean) => void>>()
  const focusInitialized = new WeakSet<FrameAddress>()
  const focusBindings = new Map<string, { state: AddressState; token: string }>()
  const focusBindingName = `__holi_focus_${randomBytes(16).toString('hex')}`
  const worldWaiters = new Map<string, { context: Context; resolve: (context: Context) => void }>()
  let queue: Promise<unknown> = Promise.resolve()
  let disposed = false
  let owner!: ReturnType<typeof createFrameContextSessionOwner>
  let nativeProbes!: ReturnType<typeof createFrameContextNativeProbes>
  const identity = (sessionId?: string) => sessionId ?? ''
  const isolatedWorld = async (
    context: Context,
    sessionId: string | undefined,
    purpose: string,
  ): Promise<{ contextId: number; uniqueId: string }> => {
    return metadata.getOrCreateWorld(context, purpose, async () => {
      const worldName = runtime.worldNames.forPurpose(purpose)
      const currentDefault = metadata.lookup(sessionId, context.contextId)
      if (
        !currentDefault ||
        !currentDefault.isDefault ||
        currentDefault.frameId !== context.frameId ||
        currentDefault.uniqueId !== context.uniqueId ||
        currentDefault.generation !== context.generation ||
        !metadata.isLive(sessionId, context.contextId)
      )
        throw new Error('frame document context is no longer current')
      // Bind even a replayed world through Chromium's current-document lookup.
      // Reusing its stable name does not allocate another native world.
      const waiterKey = `${identity(sessionId)}\0${context.frameId}\0${worldName}`
      let resolveWorld!: (world: Context) => void
      const worldReady = new Promise<Context>((resolve) => {
        resolveWorld = resolve
      })
      const waiter = { context, resolve: resolveWorld }
      worldWaiters.set(waiterKey, waiter)
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        const created = (await send(
          'Page.createIsolatedWorld',
          {
            frameId: context.frameId,
            worldName,
            grantUniveralAccess: false,
          },
          sessionId,
        )) as { executionContextId?: number } | undefined
        if (!created || typeof created.executionContextId !== 'number')
          throw new Error('frame document context is no longer current')

        // Chromium may reuse a named world and return its ID without emitting a new
        // executionContextCreated event. Runtime.enable can also replay that event
        // before this waiter is installed; bind by the exact response ID first.
        const existing = metadata.lookup(sessionId, created.executionContextId)
        const worldContext =
          existing ??
          (await sessionOwner.run(
            Promise.race([
              worldReady,
              new Promise<never>((_, reject) => {
                timeout = setTimeout(
                  () => reject(new Error('isolated world context event was not observed')),
                  1_000,
                )
              }),
            ]),
          ))
        if (created.executionContextId !== worldContext.contextId)
          throw new Error('isolated world response did not match its context event')
        const defaultContext = metadata.findContext(
          (candidate) =>
            (candidate.sessionId ?? '') === (sessionId ?? '') &&
            candidate.frameId === context.frameId &&
            candidate.isDefault &&
            candidate.uniqueId === context.uniqueId &&
            candidate.generation === context.generation &&
            metadata.isLive(sessionId, candidate.contextId),
        )
        if (
          !defaultContext ||
          worldContext.isDefault ||
          worldContext.frameId !== context.frameId ||
          worldContext.generation !== context.generation ||
          !worldContext.uniqueId ||
          !metadata.isLive(sessionId, worldContext.contextId) ||
          metadata.generation(sessionId, context.frameId) !== context.generation
        )
          throw new Error('isolated world belongs to a departed document')
        return { contextId: worldContext.contextId, uniqueId: worldContext.uniqueId }
      } finally {
        if (timeout) clearTimeout(timeout)
        if (worldWaiters.get(waiterKey) === waiter) worldWaiters.delete(waiterKey)
      }
    })
  }

  function removeFocusBinding(state: AddressState): void {
    const key = `${identity(state.sessionId)}\0${state.contextId}`
    const binding = focusBindings.get(key)
    if (binding?.state !== state) return
    focusBindings.delete(key)
    if (state.address) focusInitialized.delete(state.address)
    // Unique context and registration token prevent delayed cleanup from
    // removing a replacement document's or returning owner's observation.
    void send(
      'Runtime.evaluate',
      {
        expression: `(() => { const hook = globalThis.__holiFrameFocusObserver; if (hook?.token === ${JSON.stringify(binding.token)}) { hook.cleanup(); delete globalThis.__holiFrameFocusObserver; } })()`,
        uniqueContextId: state.uniqueId,
      },
      state.sessionId,
      false,
    ).catch(() => {})
  }

  const retire = (state: AddressState) => {
    if (state.address) {
      states.delete(state.address)
      focusObservers.get(state.address)?.clear()
      focusObservers.delete(state.address)
      removeFocusBinding(state)
    }
    const group = captureStates.get(state.capture as object)
    group?.delete(state)
    if (!group?.size) captureStates.delete(state.capture as object)
    const map = leases.get(state.capture as object)
    if (state.address && map?.get(state.frame) === state.address) map.delete(state.frame)
    if (map?.size === 0) leases.delete(state.capture as object)
  }
  const retireContext = (sessionId: string | undefined, contextId: number) => {
    for (const group of captureStates.values())
      for (const state of [...group])
        if (
          ((state.sessionId ?? '') === (sessionId ?? '') && state.contextId === contextId) ||
          state.ownerChain.some(
            (owner) =>
              (owner.sessionId ?? '') === (sessionId ?? '') &&
              owner.context.contextId === contextId,
          )
        )
          retire(state)
  }
  const invalidate = () => {
    for (const group of captureStates.values()) for (const state of [...group]) retire(state)
    metadata.clear()
    nativeProbes?.clear()
    worldWaiters.clear()
  }
  const fail = (reason: string) => owner.fail(reason)
  const assertOpen = () => owner.assertAvailable()
  const send = (...args: Parameters<typeof owner.send>) => owner.send(...args)

  const rememberWorld = (sessionId: string | undefined, frameId: string, c: any) => {
    const parent = metadata.findContext(
      (item) =>
        (item.sessionId ?? '') === (sessionId ?? '') &&
        item.frameId === frameId &&
        item.isDefault &&
        metadata.isLive(sessionId, item.contextId),
    )
    if (!parent) {
      metadata.queuePending(sessionId, frameId, c)
      return
    }
    if (typeof c.uniqueId !== 'string' || !c.uniqueId) {
      fail('isolated execution context has no unique identity')
      return
    }
    const worldContext: Context = {
      frameId,
      contextId: c.id,
      uniqueId: c.uniqueId,
      generation: parent.generation,
      sessionId,
      isDefault: false,
      name: typeof c.name === 'string' ? c.name : undefined,
    }
    metadata.ingest(worldContext)
    if (typeof c.name === 'string') {
      const waiter = worldWaiters.get(`${identity(sessionId)}\0${frameId}\0${c.name}`)
      if (
        waiter &&
        waiter.context.generation === parent.generation &&
        waiter.context.uniqueId === parent.uniqueId &&
        metadata.generation(sessionId, frameId) === parent.generation
      )
        waiter.resolve(worldContext)
    }
  }
  const onMessage = (method: string, params: any, session?: string) => {
    if (owner.terminal || disposed) return
    if (method === 'Runtime.executionContextCreated') {
      const c = params.context
      if (c.auxData?.isDefault && typeof c.auxData.frameId === 'string') {
        const generation = metadata.nextGeneration(session, c.auxData.frameId, c.uniqueId)
        for (const group of captureStates.values())
          for (const state of [...group])
            if (
              (state.sessionId ?? '') === (session ?? '') &&
              state.frameId === c.auxData.frameId &&
              state.generation !== generation
            )
              retire(state)
        if (typeof c.uniqueId !== 'string' || !c.uniqueId) {
          fail('execution context has no unique identity')
          return
        }
        metadata.ingest({
          frameId: c.auxData.frameId,
          contextId: c.id,
          uniqueId: c.uniqueId,
          generation,
          sessionId: session,
          isDefault: true,
        })
        for (const descriptor of metadata.takePending(session, c.auxData.frameId))
          rememberWorld(session, c.auxData.frameId, descriptor)
      } else if (typeof c.auxData?.frameId === 'string') {
        // CDP can replay an isolated world before its authenticated default descriptor.
        rememberWorld(session, c.auxData.frameId, c)
      }
    } else if (method === 'Runtime.bindingCalled') {
      if (params.name !== focusBindingName || typeof params.executionContextId !== 'number') return
      const key = `${identity(session)}\0${params.executionContextId}`
      const binding = focusBindings.get(key)
      if (
        !binding ||
        binding.state.sessionId !== session ||
        !isCurrentAddress(binding.state.address!)
      )
        return
      const context = metadata.lookup(session, params.executionContextId)
      if (
        !context ||
        context.isDefault ||
        context.frameId !== binding.state.frameId ||
        context.uniqueId !== binding.state.uniqueId ||
        context.generation !== binding.state.generation
      )
        return
      try {
        const event = JSON.parse(params.payload)
        if (event?.token !== binding.token || (event.type !== 'focus' && event.type !== 'blur'))
          return
        for (const observer of focusObservers.get(binding.state.address!) ?? [])
          observer(event.type === 'focus')
      } catch {
        // A malformed page-world payload has no effect.
      }
    } else if (method === 'Page.frameDetached') {
      const frameId = params.frameId
      if (typeof frameId === 'string') {
        for (const context of metadata.contextsForSession(session))
          if (context.frameId === frameId) retireContext(session, context.contextId)
        metadata.dropFrame(session, frameId)
      }
    } else if (method === 'Runtime.executionContextDestroyed') {
      const contextId = params.executionContextId
      const departed = metadata.lookup(session, contextId)
      if (departed?.isDefault) {
        for (const group of captureStates.values())
          for (const state of [...group])
            if ((state.sessionId ?? '') === (session ?? '') && state.frameId === departed.frameId)
              retire(state)
        metadata.dropFrame(session, departed.frameId)
      } else if (departed) {
        metadata.dropWorldsForContext(departed)
      }
      if (departed) metadata.removeContext(session, contextId)
      else metadata.removePendingContext(session, contextId)
      retireContext(session, contextId)
    } else if (method === 'Runtime.executionContextsCleared') {
      for (const context of metadata.contextsForSession(session))
        for (const group of captureStates.values())
          for (const state of [...group])
            if (
              ((state.sessionId ?? '') === (session ?? '') && state.frameId === context.frameId) ||
              state.ownerChain.some(
                (owner) =>
                  (owner.sessionId ?? '') === (session ?? '') &&
                  owner.context.frameId === context.frameId,
              )
            )
              retire(state)
      metadata.dropSession(session)
    } else if (method === 'Target.detachedFromTarget') {
      const id = params.sessionId
      metadata.dropSession(id)
      for (const group of captureStates.values())
        for (const state of [...group])
          if (state.sessionId === id || state.ownerChain.some((item) => item.sessionId === id))
            retire(state)
    }
    nativeProbes?.acceptProtocolEvent(method, params, session)
  }

  owner = createFrameContextSessionOwner(contents, onMessage, invalidate)
  const sessionOwner = owner
  nativeProbes = createFrameContextNativeProbes(owner, metadata)
  const isLive = (frame: WebFrameMain) => {
    if (disposed || contents.isDestroyed() || frame.detached) return false
    const visit = (candidate: WebFrameMain): boolean =>
      candidate === frame || candidate.frames.some(visit)
    try {
      return visit(contents.mainFrame)
    } catch {
      return false
    }
  }
  const assertCurrent = (frame: WebFrameMain, capture: FrameCapture) => {
    if (
      !Object.isFrozen(capture) ||
      revoked.has(capture as object) ||
      !current(capture) ||
      !isLive(frame)
    )
      throw new Error('frame address capture is no longer current')
    // The first resolve validates a native handle before attaching this adapter's debugger.
    // Once owned or externally attached, retain the strict ownership check.
    if (disposed) throw new Error('frame addressing is no longer available')
    if (owner.owned) assertOpen()
    else if (owner.terminal) throw new Error('frame addressing is no longer available')
  }
  const assertContext = (capture: FrameCapture, context: Context, sessionId?: string) => {
    assertCurrent(captureFrame.get(context)!, capture)
    if (
      !metadata.isLive(sessionId, context.contextId) ||
      metadata.lookup(sessionId, context.contextId)?.generation !== context.generation ||
      metadata.lookup(sessionId, context.contextId)?.uniqueId !== context.uniqueId
    )
      throw new Error('frame document context is no longer current')
  }
  const captureFrame = new WeakMap<Context, WebFrameMain>()
  const assertTargetWorld = (state: AddressState) => {
    const world = metadata.lookup(state.sessionId, state.contextId)
    if (
      !world ||
      !metadata.isLive(state.sessionId, state.contextId) ||
      world.isDefault ||
      world.frameId !== state.frameId ||
      world.uniqueId !== state.uniqueId ||
      world.generation !== state.generation ||
      metadata.generation(state.sessionId, state.frameId) !== state.generation
    )
      throw new Error('frame address lease is no longer current')
    return world
  }
  async function probe(frame: WebFrameMain, capture: FrameCapture): Promise<Context> {
    const context = await nativeProbes.probe(frame, () => assertCurrent(frame, capture))
    captureFrame.set(context, frame)
    assertContext(capture, context, findSession(context))
    return context
  }
  const enqueue = <T>(work: () => Promise<T>) => {
    const pending = queue.then(work, work)
    queue = pending.then(
      () => undefined,
      () => undefined,
    )
    return pending
  }

  async function resolve(frame: WebFrameMain, capture: FrameCapture): Promise<FrameAddress> {
    assertCurrent(frame, capture)
    return enqueue(async () => {
      assertCurrent(frame, capture)
      const cached = leases.get(capture as object)?.get(frame)
      if (cached) {
        const state = states.get(cached)
        if (!state) {
          leases.get(capture as object)?.delete(frame)
          throw new Error('frame address lease is no longer current')
        }
        try {
          assertCurrent(frame, capture)
          const context = metadata.lookup(state.sessionId, state.contextId)
          if (
            !context ||
            context.frameId !== state.frameId ||
            context.generation !== state.generation ||
            !metadata.isLive(state.sessionId, state.contextId)
          )
            throw new Error('frame document context is no longer current')
          for (const owner of state.ownerChain)
            assertContext(capture, owner.context, owner.sessionId)
          if (state.epoch !== owner.epoch)
            throw new Error('frame address lease is no longer current')
          return cached
        } catch (error) {
          retire(state)
          throw error
        }
      }
      const parent = frame.parent
      if (!parent) throw new Error('top-level frame has no embedding owner')
      let startEpoch: number
      try {
        await sessionOwner.ensureReady()
        startEpoch = sessionOwner.epoch
        assertCurrent(frame, capture)
        const target = await probe(frame, capture)
        const ownerChain: Array<{ context: Context; sessionId?: string; frame: WebFrameMain }> = []
        for (let ancestor: WebFrameMain | null = parent; ancestor; ancestor = ancestor.parent) {
          const context = await probe(ancestor, capture)
          ownerChain.push({ context, sessionId: findSession(context), frame: ancestor })
          assertContext(capture, target, findSession(target))
          for (const owner of ownerChain) assertContext(capture, owner.context, owner.sessionId)
        }
        const immediateOwner = ownerChain[0]
        if (!immediateOwner) throw new Error('frame owner chain was not captured')
        const ownerContext = immediateOwner.context
        assertContext(capture, target, findSession(target))
        const sessionId = findSession(target)
        const ownerSessionId = immediateOwner.sessionId
        const world = await isolatedWorld(target, sessionId, 'frame')
        assertContext(capture, target, sessionId)
        for (const owner of ownerChain) assertContext(capture, owner.context, owner.sessionId)
        const worldContext = metadata.lookup(sessionId, world.contextId)
        if (!worldContext) throw new Error('isolated frame world context was lost')
        const owner = (await send(
          'DOM.getFrameOwner',
          { frameId: target.frameId },
          ownerSessionId,
        )) as { backendNodeId?: number }
        assertContext(capture, target, sessionId)
        for (const owner of ownerChain) assertContext(capture, owner.context, owner.sessionId)
        if (!owner.backendNodeId)
          throw new Error('browser-authenticated frame owner was not resolved')
        const state: AddressState = {
          frame,
          frameId: target.frameId,
          nativeProcessId: frame.processId,
          nativeUrl: frame.url,
          sessionId,
          contextId: world.contextId,
          uniqueId: world.uniqueId,
          generation: target.generation,
          backendNodeId: owner.backendNodeId,
          ownerContext,
          ownerContextSession: ownerSessionId,
          ownerChain,
          capture,
          epoch: startEpoch,
        }
        const address = Object.freeze({}) as FrameAddress
        state.address = address
        states.set(address, state)
        let map = leases.get(capture as object)
        if (!map) leases.set(capture as object, (map = new Map()))
        map.set(frame, address)
        let group = captureStates.get(capture as object)
        if (!group) captureStates.set(capture as object, (group = new Set()))
        group.add(state)
        return address
      } catch (error) {
        if (sessionOwner.owned && !sessionOwner.terminal) fail('frame initialization failed')
        throw error
      }
    })
  }
  function findSession(context: Context): string | undefined {
    return context.sessionId
  }
  const assertDirectGeometry = (state: AddressState) => {
    if (!isCurrentAddress(state.address!))
      throw new Error('frame address lease is no longer current')
    if (state.frame.parent !== contents.mainFrame || contents.getZoomFactor() !== 1)
      throw new Error('direct frame geometry is unsupported')
  }
  async function projectDirectPoints(
    address: FrameAddress,
    points: ReadonlyArray<{ x: number; y: number }>,
  ): Promise<Array<{ x: number; y: number } | null>> {
    const state = states.get(address)
    if (!state) throw new Error('unknown frame address lease')
    if (points.some(({ x, y }) => !Number.isFinite(x) || !Number.isFinite(y)))
      throw new Error('frame points must be finite')
    return enqueue(async () => {
      assertDirectGeometry(state)
      const viewport = await evaluate<{ width: number; height: number; scale: number }>(
        address,
        '({width:innerWidth,height:innerHeight,scale:globalThis.visualViewport?.scale ?? 1})',
      )
      assertDirectGeometry(state)
      if (viewport.scale !== 1) throw new Error('direct frame geometry is unsupported')
      const world = await isolatedWorld(state.ownerContext, state.ownerContextSession, 'owner')
      assertDirectGeometry(state)
      const resolved = (await send(
        'DOM.resolveNode',
        {
          backendNodeId: state.backendNodeId,
          executionContextId: world.contextId,
        },
        state.ownerContextSession,
      )) as { object?: { objectId?: string } }
      const objectId = resolved.object?.objectId
      if (!objectId) throw new Error('authenticated frame owner is unavailable')
      try {
        assertDirectGeometry(state)
        const response = (await send(
          'Runtime.callFunctionOn',
          {
            objectId,
            functionDeclaration: `function(points, viewport) {
            const owner = this;
            const vv = window.visualViewport;
            if (vv && vv.scale !== 1) return null;
            const style = getComputedStyle(owner);
            const rect = owner.getBoundingClientRect();
            if (!owner.isConnected || rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility !== 'visible' || style.opacity === '0') return null;
            for (let node = owner; node && node.nodeType === 1; node = node.parentElement) {
              const s = getComputedStyle(node);
              if (s.display === 'none' || s.visibility !== 'visible' || Number(s.opacity) === 0 || s.transform !== 'none' || s.translate !== 'none' || s.rotate !== 'none' || s.scale !== 'none' || s.perspective !== 'none' || (s.zoom && s.zoom !== '1' && s.zoom !== 'normal')) return null;
            }
            if (owner.getRootNode() !== document) return null;
            const paddingLeft = parseFloat(style.paddingLeft), paddingRight = parseFloat(style.paddingRight);
            const paddingTop = parseFloat(style.paddingTop), paddingBottom = parseFloat(style.paddingBottom);
            if (![paddingLeft, paddingRight, paddingTop, paddingBottom].every(Number.isFinite)) return null;
            const left = rect.left + owner.clientLeft + paddingLeft, top = rect.top + owner.clientTop + paddingTop;
            const width = owner.clientWidth - paddingLeft - paddingRight;
            const height = owner.clientHeight - paddingTop - paddingBottom;
            if (!(width > 0 && height > 0) || width !== viewport.width || height !== viewport.height) return null;
            return points.map(({x,y}) => {
              if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) return null;
              const px = Math.round(left + x), py = Math.round(top + y);
              if (px < left || py < top || px >= left + width || py >= top + height) return null;
              const hit = document.elementFromPoint(px, py);
              if (hit !== owner) return null;
              return {x:px, y:py};
            });
          }`,
            arguments: [{ value: points }, { value: viewport }],
            returnByValue: true,
          },
          state.ownerContextSession,
        )) as { result?: { value?: Array<{ x: number; y: number } | null> | null } }
        assertDirectGeometry(state)
        if (!Array.isArray(response.result?.value))
          throw new Error('direct frame geometry is unsupported')
        return response.result.value
      } finally {
        await send('Runtime.releaseObject', { objectId }, state.ownerContextSession)
        assertDirectGeometry(state)
      }
    })
  }
  async function clickDirect(
    address: FrameAddress,
    point: { x: number; y: number },
    currentGuard: () => boolean,
    expected?: { x: number; y: number },
    validateTarget?: () => Promise<boolean>,
  ): Promise<boolean> {
    const projected = await projectDirectPoints(address, [point])
    if (!projected[0] || !currentGuard() || !isCurrentAddress(address)) return false
    if (validateTarget && !(await validateTarget())) return false
    if (!currentGuard() || !isCurrentAddress(address)) return false
    const { x, y } = projected[0]
    if (expected && (x !== expected.x || y !== expected.y)) return false
    // The caller must verify its target hit/nonce before invoking this method.
    contents.focus()
    if (!currentGuard() || !isCurrentAddress(address)) return false
    contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    let released = false
    try {
      if (!currentGuard() || !isCurrentAddress(address)) return false
      contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
      released = true
      return true
    } finally {
      // Always release a dispatched button, including when the guard cancels.
      if (!released)
        contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    }
  }
  async function verifyOwner(address: FrameAddress, selector: string): Promise<boolean> {
    const state = states.get(address)
    if (!state) throw new Error('unknown frame address lease')
    return enqueue(async () => {
      const verify = () => {
        if (states.get(address) !== state)
          throw new Error('frame address lease is no longer current')
        assertCurrent(state.frame, state.capture)
        if (state.frame.processId !== state.nativeProcessId || state.frame.url !== state.nativeUrl)
          throw new Error('frame document or renderer process is no longer current')
        assertTargetWorld(state)
        const owner = metadata.lookup(state.ownerContextSession, state.ownerContext.contextId)
        if (!owner || owner.generation !== state.ownerContext.generation)
          throw new Error('parent frame document context is no longer current')
        for (const owner of state.ownerChain) {
          assertCurrent(owner.frame, state.capture)
          assertContext(state.capture, owner.context, owner.sessionId)
        }
        if (state.epoch !== sessionOwner.epoch)
          throw new Error('frame address lease is no longer current')
      }
      verify()
      const world = await isolatedWorld(state.ownerContext, state.ownerContextSession, 'owner')
      verify()
      const result = (await send(
        'Runtime.evaluate',
        {
          expression: `document.querySelector(${JSON.stringify(selector)})`,
          uniqueContextId: world.uniqueId,
          returnByValue: false,
        },
        state.ownerContextSession,
      )) as { result?: { objectId?: string } }
      const objectId = result.result?.objectId
      if (!objectId) {
        verify()
        return false
      }
      let described: { node?: { backendNodeId?: number } }
      try {
        verify()
        described = (await send('DOM.describeNode', { objectId }, state.ownerContextSession)) as {
          node?: { backendNodeId?: number }
        }
        verify()
      } finally {
        await send('Runtime.releaseObject', { objectId }, state.ownerContextSession)
      }
      verify()
      return described.node?.backendNodeId === state.backendNodeId
    })
  }
  function isCurrentAddress(address: FrameAddress): boolean {
    const state = states.get(address)
    if (!state || disposed || states.get(address) !== state) return false
    try {
      assertCurrent(state.frame, state.capture)
      if (state.frame.processId !== state.nativeProcessId || state.frame.url !== state.nativeUrl)
        return false
      assertTargetWorld(state)
      for (const ancestor of state.ownerChain) {
        assertCurrent(ancestor.frame, state.capture)
        assertContext(state.capture, ancestor.context, ancestor.sessionId)
      }
      return state.epoch === owner.epoch && states.get(address) === state
    } catch {
      return false
    }
  }
  async function observeFocus(address: FrameAddress, onChange: (focused: boolean) => void) {
    const state = states.get(address)
    if (!state) throw new Error('unknown frame address lease')
    const assertLease = () => {
      if (states.get(address) !== state || !isCurrentAddress(address))
        throw new Error('frame address lease is no longer current')
    }
    assertLease()
    let observers = focusObservers.get(address)
    if (!observers) focusObservers.set(address, (observers = new Set()))
    observers.add(onChange)
    try {
      if (!focusInitialized.has(address)) {
        await send(
          'Runtime.addBinding',
          { name: focusBindingName, executionContextName: runtime.worldNames.forPurpose('frame') },
          state.sessionId,
        )
        assertLease()
        const key = `${identity(state.sessionId)}\0${state.contextId}`
        const token = randomBytes(16).toString('hex')
        focusBindings.set(key, { state, token })
        const installed = await evaluate<boolean>(
          address,
          `(() => {
            const name = ${JSON.stringify(focusBindingName)};
            const remembered = globalThis.__holiFrameFocusBinding;
            const send = globalThis[name] ?? (remembered?.name === name ? remembered.send : undefined);
            if (typeof send !== 'function') throw new Error('focus binding missing');
            globalThis.__holiFrameFocusBinding = { name, send };
            globalThis.__holiFrameFocusObserver?.cleanup();
            const token = ${JSON.stringify(token)};
            const report = event => { if (event.isTrusted) send(JSON.stringify({type:event.type,token})); };
            addEventListener('focus', report, true); addEventListener('blur', report, true);
            globalThis.__holiFrameFocusObserver = { token, cleanup() {
              removeEventListener('focus', report, true); removeEventListener('blur', report, true);
            }};
            delete globalThis[${JSON.stringify(focusBindingName)}]; return true;
          })()`,
        )
        if (!installed) throw new Error('native focus observation was not installed')
        assertLease()
        focusInitialized.add(address)
      }
    } catch (error) {
      observers.delete(onChange)
      if (!observers.size) focusObservers.delete(address)
      throw error
    }
    return () => {
      const ownObservers = focusObservers.get(address)
      ownObservers?.delete(onChange)
      if (!ownObservers?.size) {
        focusObservers.delete(address)
        removeFocusBinding(state)
      }
    }
  }
  async function evaluate<T>(address: FrameAddress, expression: string): Promise<T> {
    const state = states.get(address)
    if (!state) throw new Error('unknown frame address lease')
    assertCurrent(state.frame, state.capture)
    if (state.frame.processId !== state.nativeProcessId || state.frame.url !== state.nativeUrl)
      throw new Error('frame document or renderer process is no longer current')
    for (const owner of state.ownerChain)
      assertContext(state.capture, owner.context, owner.sessionId)
    const initialWorld = assertTargetWorld(state)
    if (state.epoch !== owner.epoch) throw new Error('frame address lease is no longer current')
    const result = (await send(
      'Runtime.evaluate',
      {
        expression,
        uniqueContextId: initialWorld.uniqueId,
        returnByValue: true,
        awaitPromise: true,
      },
      state.sessionId,
      false,
    )) as { result?: { value?: T }; exceptionDetails?: unknown }
    if (states.get(address) !== state) throw new Error('frame address lease is no longer current')
    assertCurrent(state.frame, state.capture)
    assertTargetWorld(state)
    if (state.frame.processId !== state.nativeProcessId || state.frame.url !== state.nativeUrl)
      throw new Error('frame document or renderer process is no longer current')
    for (const owner of state.ownerChain)
      assertContext(state.capture, owner.context, owner.sessionId)
    assertTargetWorld(state)
    if (state.epoch !== owner.epoch) throw new Error('frame address lease is no longer current')
    if (result.exceptionDetails) throw new Error('isolated frame evaluation failed')
    return result.result?.value as T
  }
  function revoke(capture: FrameCapture) {
    revoked.add(capture as object)
    for (const state of [...(captureStates.get(capture as object) ?? [])]) retire(state)
    leases.delete(capture as object)
  }
  function dispose() {
    if (disposed) return
    disposed = true
    owner.dispose()
    contents.removeListener('render-process-gone', revokeAll)
    contents.removeListener('destroyed', revokeAll)
    invalidate()
  }
  const revokeAll = () => {
    for (const capture of [...captureStates.keys()]) revoke(capture as FrameCapture)
  }
  contents.on('render-process-gone', revokeAll)
  contents.on('destroyed', revokeAll)
  return Object.freeze({
    resolve,
    evaluate,
    verifyOwner,
    projectDirectPoints,
    clickDirect,
    isCurrent: (address: FrameAddress) => isCurrentAddress(address),
    observeFocus,
    revoke,
    dispose,
  })
}
