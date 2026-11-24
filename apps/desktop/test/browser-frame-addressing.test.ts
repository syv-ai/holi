import { EventEmitter } from 'node:events'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebContents, WebFrameMain } from 'electron'
import {
  createFrameAddressing,
  type FrameCapture,
} from '../src/plugins/browser/main/frame-addressing'
import { createFrameContextCancellation } from '../src/plugins/browser/main/frame-context-cancellation'
import { createFrameContextSessionOwner } from '../src/plugins/browser/main/frame-context-session-owner'

const capture = (): FrameCapture => Object.freeze({ tab: {}, document: {}, presentation: {} })

const doms: JSDOM[] = []
afterEach(() => {
  for (const dom of doms.splice(0)) dom.window.close()
})
type FixtureOptions = {
  preAttached?: boolean
  delayedWorld?: boolean
  reuseWorld?: boolean
  focusWorlds?: boolean
}
function fixture(options: FixtureOptions = {}) {
  const events = new EventEmitter()
  let attached = options.preAttached ?? false
  let frameContext = 11
  let parentContext = 12
  let worldContext = 13
  let releaseWorld: ((value: unknown) => void) | undefined
  const namedWorlds = new Map<string, number>()
  type World = {
    dom: JSDOM
    id: number
    uniqueId: string
    session?: string
    frameId: string
    name: string
  }
  const worlds = new Map<number, World>()
  const bindings = new Map<string, { name: string; worldName: string; session?: string }>()
  const nativeReports: Array<{
    name: string
    executionContextId: number
    payload: string
    session?: string
  }> = []
  type Gate = { entered(): void; released: Promise<void>; completed(): void }
  let nextEvaluation: Gate | undefined
  const installBinding = (
    world: World,
    key: string,
    binding: { name: string; worldName: string; session?: string },
  ) => {
    if (world.name !== binding.worldName || world.session !== binding.session) return
    Object.defineProperty(world.dom.window, binding.name, {
      configurable: true,
      writable: true,
      value: (payload: string) => {
        if (!attached || bindings.get(key) !== binding) return
        const report = {
          name: binding.name,
          payload,
          executionContextId: world.id,
          session: world.session,
        }
        nativeReports.push(report)
        events.emit('message', {}, 'Runtime.bindingCalled', report, world.session)
      },
    })
  }
  const evaluateNative = (world: World, params?: Record<string, unknown>) => {
    try {
      const value = world.dom.window.eval(String(params?.expression))
      return value instanceof world.dom.window.Node
        ? { result: { objectId: 'owner-object' } }
        : { result: { value } }
    } catch (error) {
      return { exceptionDetails: { text: String(error) } }
    }
  }
  const root = { detached: false, frames: [] as WebFrameMain[] } as unknown as WebFrameMain
  const parent = { detached: false, frames: [] as WebFrameMain[] } as unknown as WebFrameMain
  const makeProbe = (frameId: string, getContext: () => number) =>
    vi.fn(async (source: string) => {
      const contextId = getContext()
      const nonce = source.match(/sourceURL=(.*)/)?.[1]
      const scriptId = `script-${contextId}-${Math.random()}`
      events.emit(
        'message',
        {},
        'Debugger.scriptParsed',
        { scriptId, url: nonce, executionContextId: contextId },
        undefined,
      )
      events.emit(
        'message',
        {},
        'Debugger.paused',
        { callFrames: [{ location: { scriptId } }] },
        undefined,
      )
      void frameId
    })
  Object.assign(root, { executeJavaScript: makeProbe('root-frame', () => 10) })
  const child = {
    detached: false,
    frames: [],
    executeJavaScript: makeProbe('child-frame', () => frameContext),
  } as unknown as WebFrameMain
  Object.defineProperty(child, 'parent', { value: parent })
  Object.assign(parent, { executeJavaScript: makeProbe('parent-frame', () => parentContext) })
  Object.defineProperty(parent, 'parent', { value: root })
  parent.frames.push(child)
  root.frames.push(parent)
  const contexts = (session?: string) => {
    events.emit(
      'message',
      {},
      'Runtime.executionContextCreated',
      {
        context: {
          id: 11,
          uniqueId: 'unique-child-default',
          auxData: { isDefault: true, frameId: 'child-frame' },
        },
      },
      session,
    )
    events.emit(
      'message',
      {},
      'Runtime.executionContextCreated',
      {
        context: {
          id: 12,
          uniqueId: 'unique-parent-default',
          auxData: { isDefault: true, frameId: 'parent-frame' },
        },
      },
      session,
    )
    events.emit(
      'message',
      {},
      'Runtime.executionContextCreated',
      {
        context: {
          id: 10,
          uniqueId: 'unique-root-default',
          auxData: { isDefault: true, frameId: 'root-frame' },
        },
      },
      session,
    )
    for (const [key, id] of namedWorlds) {
      const [worldSession, frameId, name] = key.split('\\0')
      if ((worldSession ?? '') !== (session ?? '')) continue
      events.emit(
        'message',
        {},
        'Runtime.executionContextCreated',
        {
          context: {
            id,
            uniqueId: `unique-world-${id}`,
            name,
            auxData: { isDefault: false, frameId },
          },
        },
        session,
      )
    }
  }
  const debuggerClient = Object.assign(events, {
    isAttached: () => attached,
    attach: vi.fn(() => {
      attached = true
    }),
    detach: vi.fn(() => {
      attached = false
      bindings.clear()
      events.emit('detach')
    }),
    sendCommand: vi.fn((method: string, params?: Record<string, unknown>, session?: string) => {
      if (method === 'Runtime.enable') contexts(session)
      if (method === 'Page.createIsolatedWorld') {
        const create = (resolve: (value: unknown) => void) => {
          const worldKey = `${session ?? ''}\\0${params?.frameId as string}\\0${params?.worldName as string}`
          const previous = namedWorlds.get(worldKey)
          if (options.reuseWorld && previous !== undefined) {
            resolve({ executionContextId: previous })
            return
          }
          const id = worldContext++
          namedWorlds.set(worldKey, id)
          const uniqueId = `unique-world-${id}`
          if (options.focusWorlds) {
            const dom = new JSDOM(
              '<!doctype html><input id="focus-target"><iframe class="target"></iframe>',
              { runScripts: 'outside-only' },
            )
            doms.push(dom)
            const world = {
              dom,
              id,
              uniqueId,
              session,
              frameId: String(params?.frameId),
              name: String(params?.worldName),
            }
            worlds.set(id, world)
            for (const [key, binding] of bindings) installBinding(world, key, binding)
          }
          events.emit(
            'message',
            {},
            'Runtime.executionContextCreated',
            {
              context: {
                id,
                uniqueId,
                name: params?.worldName,
                auxData: { isDefault: false, frameId: params?.frameId },
              },
            },
            session,
          )
          resolve({ executionContextId: id })
        }
        if (options.delayedWorld)
          return new Promise((resolve) => {
            releaseWorld = (value) => create(() => resolve(value))
          })
        return new Promise((resolve) => create(resolve))
      }
      if (method === 'DOM.getFrameOwner') return Promise.resolve({ backendNodeId: 91 })
      if (method === 'Runtime.addBinding') {
        const name = String(params?.name)
        const key = `${session ?? ''}\0${name}`
        if (!bindings.has(key)) {
          const binding = { name, worldName: String(params?.executionContextName), session }
          bindings.set(key, binding)
          for (const world of worlds.values()) installBinding(world, key, binding)
        }
        return Promise.resolve({})
      }
      if (method === 'Runtime.evaluate') {
        const world = [...worlds.values()].find(
          (candidate) =>
            candidate.uniqueId === params?.uniqueContextId && candidate.session === session,
        )
        if (!world) return Promise.resolve({ result: { objectId: 'owner-object' } })
        const gate = nextEvaluation
        if (gate) {
          nextEvaluation = undefined
          gate.entered()
          return gate.released.then(() => {
            const result = evaluateNative(world, params)
            gate.completed()
            return result
          })
        }
        return Promise.resolve(evaluateNative(world, params))
      }
      if (method === 'DOM.describeNode') return Promise.resolve({ node: { backendNodeId: 91 } })
      if (method === 'Runtime.releaseObject') return Promise.resolve({})
      return Promise.resolve({})
    }),
  })
  const contents = {
    debugger: debuggerClient,
    isDestroyed: () => false,
    mainFrame: root,
    on: vi.fn(),
    removeListener: vi.fn(),
  } as unknown as WebContents
  return {
    contents,
    child,
    parent,
    debuggerClient,
    events,
    setAttached: (value: boolean) => {
      attached = value
    },
    releaseWorld: () => releaseWorld?.(undefined),
    focusNativeWorld: () => {
      const world = [...worlds.values()].find((value) => value.frameId === 'child-frame')
      if (!world) throw new Error('native child world not created')
      const input = world.dom.window.document.querySelector('input')!
      input.focus()
      input.blur()
    },
    untrustedFocus: () => {
      const world = [...worlds.values()].find((value) => value.frameId === 'child-frame')!
      world.dom.window.dispatchEvent(new world.dom.window.Event('focus'))
    },
    pauseNextEvaluation: () => {
      let entered!: () => void
      let release!: () => void
      let completed!: () => void
      const waiting = new Promise<void>((resolve) => {
        entered = resolve
      })
      const released = new Promise<void>((resolve) => {
        release = resolve
      })
      const finished = new Promise<void>((resolve) => {
        completed = resolve
      })
      nextEvaluation = { entered, released, completed }
      return { waiting, release, finished }
    },
    nativeReports,
    dispatch: (session: string | undefined, params: Record<string, unknown>) =>
      events.emit('message', {}, 'Runtime.bindingCalled', params, session),
    replaceChildContext: () => {
      events.emit(
        'message',
        {},
        'Runtime.executionContextDestroyed',
        { executionContextId: frameContext },
        undefined,
      )
      frameContext += 100
      events.emit(
        'message',
        {},
        'Runtime.executionContextCreated',
        {
          context: {
            id: frameContext,
            uniqueId: `unique-child-${frameContext}`,
            auxData: { isDefault: true, frameId: 'child-frame' },
          },
        },
        undefined,
      )
    },
  }
}

describe('browser frame addressing ownership', () => {
  it('accepts native focus but rejects unauthenticated and retired observations', async () => {
    const f = fixture({ focusWorlds: true })
    const addressing = createFrameAddressing(f.contents, () => true)
    try {
      const owner = capture()
      const address = await addressing.resolve(f.child, owner)
      const changes: boolean[] = []
      await addressing.observeFocus(address, (focused) => changes.push(focused))
      f.focusNativeWorld()
      expect(changes).toContain(true)
      expect(changes).toContain(false)
      const before = changes.length
      const report = f.nativeReports[0]!
      f.dispatch('wrong-session', report)
      f.dispatch(report.session, { ...report, name: `${report.name}-other` })
      f.dispatch(report.session, { ...report, executionContextId: 11 })
      f.dispatch(report.session, { ...report, executionContextId: report.executionContextId + 100 })
      f.dispatch(report.session, {
        ...report,
        payload: JSON.stringify({ type: 'focus', token: 'wrong-token' }),
      })
      f.untrustedFocus()
      expect(changes).toHaveLength(before)
      addressing.revoke(owner)
      expect(addressing.isCurrent(address)).toBe(false)
      f.dispatch(report.session, report)
      f.focusNativeWorld()
      expect(changes).toHaveLength(before)
    } finally {
      addressing.dispose()
    }
  })

  it('keeps a returning owner live when an unsubscribed owner cleanup arrives late', async () => {
    const f = fixture({ focusWorlds: true, reuseWorld: true })
    const addressing = createFrameAddressing(f.contents, () => true)
    let blocked: ReturnType<typeof f.pauseNextEvaluation> | undefined
    try {
      const oldAddress = await addressing.resolve(f.child, capture())
      const oldChanges: boolean[] = []
      const unsubscribe = await addressing.observeFocus(oldAddress, (focused) =>
        oldChanges.push(focused),
      )
      f.focusNativeWorld()
      const before = oldChanges.length
      const gate = (blocked = f.pauseNextEvaluation())
      unsubscribe()
      await gate.waiting
      const returning = await addressing.resolve(f.child, capture())
      const newChanges: boolean[] = []
      await addressing.observeFocus(returning, (focused) => newChanges.push(focused))
      gate.release()
      await gate.finished
      expect(addressing.isCurrent(returning)).toBe(true)
      f.focusNativeWorld()
      expect(newChanges).toContain(true)
      expect(newChanges).toContain(false)
      expect(oldChanges).toHaveLength(before)
      const beforeRetirement = newChanges.length
      const queued = f.nativeReports.at(-1)!
      f.replaceChildContext()
      expect(addressing.isCurrent(returning)).toBe(false)
      f.dispatch(queued.session, queued)
      expect(newChanges).toHaveLength(beforeRetirement)
    } finally {
      blocked?.release()
      addressing.dispose()
    }
  })

  it('releases thousands of settled cancellation registrations while live', async () => {
    const scope = createFrameContextCancellation()
    for (let index = 0; index < 2_000; index++) {
      await scope.run(Promise.resolve(index))
      await expect(scope.run(Promise.reject(new Error('expected')))).rejects.toThrow('expected')
      expect(scope.pendingCount).toBe(0)
    }
    expect(scope.pendingCount).toBe(0)
  })

  it('cancels concurrent registrations once and observes late outcomes', async () => {
    const scope = createFrameContextCancellation()
    const resolvers: Array<(value: number) => void> = []
    const rejecters: Array<(reason: Error) => void> = []
    const operations = Array.from(
      { length: 32 },
      () =>
        new Promise<number>((resolve, reject) => {
          resolvers.push(resolve)
          rejecters.push(reject)
        }),
    )
    const callers = operations.map((operation) => scope.run(operation))
    expect(scope.pendingCount).toBe(32)
    scope.cancel(new Error('cancelled'))
    scope.cancel(new Error('ignored'))
    await expect(Promise.all(callers)).rejects.toThrow('cancelled')
    expect(scope.pendingCount).toBe(0)
    resolvers.forEach((resolve, index) => resolve(index))
    rejecters.forEach((reject) => reject(new Error('late')))
    await Promise.resolve()
    await expect(scope.run(Promise.resolve(1))).rejects.toThrow('cancelled')
    await expect(scope.run(Promise.reject(new Error('late post-cancel')))).rejects.toThrow(
      'cancelled',
    )
    expect(scope.pendingCount).toBe(0)
  })

  it('removes real debugger-command registrations as commands settle', async () => {
    const { contents, debuggerClient, events } = fixture()
    const owner = createFrameContextSessionOwner(
      contents,
      () => {},
      () => {},
    )
    await owner.ensureReady()
    for (let index = 0; index < 1_200; index++)
      await owner.send('Runtime.test', {}, undefined, false)
    expect(owner.pendingCount).toBe(0)

    const resolve: Array<(value: unknown) => void> = []
    debuggerClient.sendCommand.mockImplementation((method) => {
      if (method === 'Runtime.pending') return new Promise((done) => resolve.push(done))
      return Promise.resolve({})
    })
    const pending = Array.from({ length: 16 }, () =>
      owner.send('Runtime.pending', {}, undefined, false),
    )
    expect(owner.pendingCount).toBe(16)
    events.emit('detach')
    await expect(Promise.all(pending)).rejects.toThrow()
    expect(owner.pendingCount).toBe(0)
    resolve.forEach((done) => done({}))
    await Promise.resolve()
    expect(owner.pendingCount).toBe(0)
    owner.dispose()
  })
  it('rejects stale captures before debugger attachment', async () => {
    const { child, contents } = fixture()
    const address = createFrameAddressing(contents, () => false)
    await expect(address.resolve(child, capture())).rejects.toThrow('no longer current')
    expect(child.executeJavaScript).not.toHaveBeenCalled()
    address.dispose()
  })

  it('refuses an existing debugger without touching or detaching it', async () => {
    const { child, contents, debuggerClient } = fixture({ preAttached: true })
    const address = createFrameAddressing(contents, () => true)
    await expect(address.resolve(child, capture())).rejects.toThrow('refusing to attach')
    address.dispose()
    expect(debuggerClient.detach).not.toHaveBeenCalled()
    expect(debuggerClient.sendCommand).not.toHaveBeenCalled()
  })

  it('binds a reused isolated world by the returned context id without a new event', async () => {
    const { child, contents, debuggerClient } = fixture({ reuseWorld: true })
    const first = createFrameAddressing(contents, () => true)
    const firstAddress = await first.resolve(child, capture())
    await first.evaluate(firstAddress, 'location.href')
    first.dispose()

    const second = createFrameAddressing(contents, () => true)
    const secondAddress = await second.resolve(child, capture())
    expect(await second.evaluate(secondAddress, 'location.href')).toBeUndefined()
    const worldLookups = debuggerClient.sendCommand.mock.calls.filter(
      ([method]) => method === 'Page.createIsolatedWorld',
    )
    expect(worldLookups).toHaveLength(2)
    expect(worldLookups[1]![1]).toEqual(worldLookups[0]![1])
    const evaluations = debuggerClient.sendCommand.mock.calls.filter(
      ([method, params]) => method === 'Runtime.evaluate' && params?.expression === 'location.href',
    )
    expect(evaluations).toHaveLength(2)
    expect(evaluations[1]![1]?.uniqueContextId).toBe(evaluations[0]![1]?.uniqueContextId)
    await expect(second.evaluate(firstAddress, '1')).rejects.toThrow('unknown frame address lease')
    second.dispose()
  })

  it('uses exact immediate-parent identity for same-session nested ownership', async () => {
    const { child, contents, debuggerClient } = fixture()
    const addressing = createFrameAddressing(contents, () => true)
    const address = await addressing.resolve(child, capture())
    expect(await addressing.verifyOwner(address, 'iframe.target')).toBe(true)
    expect(await addressing.verifyOwner(address, 'iframe.target')).toBe(true)
    expect(
      debuggerClient.sendCommand.mock.calls.filter(
        ([method]) => method === 'Page.createIsolatedWorld',
      ),
    ).toHaveLength(2)
    expect(debuggerClient.sendCommand).toHaveBeenCalledWith(
      'Runtime.evaluate',
      expect.objectContaining({
        uniqueContextId: 'unique-world-14',
        expression: expect.stringContaining('iframe.target'),
      }),
    )
    expect(debuggerClient.sendCommand).not.toHaveBeenCalledWith(
      'DOM.getDocument',
      expect.anything(),
      undefined,
    )
    addressing.dispose()
  })

  it('releases the evaluated owner object when capture revocation races validation', async () => {
    const { child, contents, debuggerClient } = fixture()
    const ownerCapture = capture()
    const addressing = createFrameAddressing(contents, () => true)
    const address = await addressing.resolve(child, ownerCapture)
    const original = debuggerClient.sendCommand.getMockImplementation()!
    debuggerClient.sendCommand.mockImplementation(async (method, params, session) => {
      const result = await original(method, params, session)
      if (method === 'Runtime.evaluate') addressing.revoke(ownerCapture)
      return result
    })
    await expect(addressing.verifyOwner(address, 'iframe.target')).rejects.toThrow(
      'frame address lease is no longer current',
    )
    expect(
      debuggerClient.sendCommand.mock.calls.some(
        ([method, params]) =>
          method === 'Runtime.releaseObject' &&
          JSON.stringify(params) === JSON.stringify({ objectId: 'owner-object' }),
      ),
    ).toBe(true)
    addressing.dispose()
  })

  it('retires a lease when its immediate parent document departs', async () => {
    const { child, contents, events, debuggerClient } = fixture()
    const addressing = createFrameAddressing(contents, () => true)
    const address = await addressing.resolve(child, capture())
    events.emit(
      'message',
      {},
      'Runtime.executionContextDestroyed',
      { executionContextId: 12 },
      undefined,
    )
    const commandCount = debuggerClient.sendCommand.mock.calls.length
    await expect(addressing.verifyOwner(address, 'iframe.target')).rejects.toThrow()
    expect(debuggerClient.sendCommand).toHaveBeenCalledTimes(commandCount)
    addressing.dispose()
  })

  it('retires target leases on default-context destruction and accepts a fresh document', async () => {
    const { child, contents, events, debuggerClient, replaceChildContext } = fixture()
    const addressing = createFrameAddressing(contents, () => true)
    const oldAddress = await addressing.resolve(child, capture())
    events.emit(
      'message',
      {},
      'Runtime.executionContextDestroyed',
      { executionContextId: 11 },
      undefined,
    )
    const afterDestroy = debuggerClient.sendCommand.mock.calls.length
    await expect(addressing.verifyOwner(oldAddress, 'iframe.target')).rejects.toThrow()
    expect(debuggerClient.sendCommand).toHaveBeenCalledTimes(afterDestroy)
    await expect(addressing.evaluate(oldAddress, '1')).rejects.toThrow()
    expect(debuggerClient.sendCommand).toHaveBeenCalledTimes(afterDestroy)

    replaceChildContext()
    const freshAddress = await addressing.resolve(child, capture())
    await addressing.evaluate(freshAddress, 'location.href')
    const freshEvaluation = debuggerClient.sendCommand.mock.calls
      .slice(afterDestroy)
      .find(
        ([method, params]) =>
          method === 'Runtime.evaluate' && params?.expression === 'location.href',
      )
    expect(freshEvaluation?.[1]?.uniqueContextId).toBeTruthy()
    expect(freshEvaluation?.[1]?.uniqueContextId).not.toBe('unique-world-13')
    addressing.dispose()
  })

  it('does not resurrect a reused numeric context id with a different unique id', async () => {
    const { child, contents, events, debuggerClient } = fixture()
    const addressing = createFrameAddressing(contents, () => true)
    const address = await addressing.resolve(child, capture())
    events.emit(
      'message',
      {},
      'Runtime.executionContextDestroyed',
      { executionContextId: 11 },
      undefined,
    )
    events.emit(
      'message',
      {},
      'Runtime.executionContextCreated',
      {
        context: {
          id: 11,
          uniqueId: 'different-unique-child-context',
          auxData: { isDefault: true, frameId: 'child-frame' },
        },
      },
      undefined,
    )
    const calls = debuggerClient.sendCommand.mock.calls.length
    await expect(addressing.evaluate(address, '1')).rejects.toThrow()
    expect(debuggerClient.sendCommand).toHaveBeenCalledTimes(calls)
    addressing.dispose()
  })

  it('rejects navigation before disposing the adapter', async () => {
    const { child, contents, events, debuggerClient, releaseWorld } = fixture({
      delayedWorld: true,
    })
    const addressing = createFrameAddressing(contents, () => true)
    const resolving = addressing.resolve(child, capture())
    for (
      let i = 0;
      i < 50 &&
      !debuggerClient.sendCommand.mock.calls.some(
        ([method]) => method === 'Page.createIsolatedWorld',
      );
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 0))
    events.emit(
      'message',
      {},
      'Runtime.executionContextDestroyed',
      { executionContextId: 11 },
      undefined,
    )
    events.emit(
      'message',
      {},
      'Runtime.executionContextCreated',
      {
        context: {
          id: 111,
          uniqueId: 'unique-child-after-navigation',
          auxData: { isDefault: true, frameId: 'child-frame' },
        },
      },
      undefined,
    )
    expect(debuggerClient.sendCommand).toHaveBeenCalledWith(
      'Page.createIsolatedWorld',
      expect.anything(),
    )
    releaseWorld()
    await expect(resolving).rejects.toThrow('frame document context is no longer current')
    addressing.dispose()
  })

  it('cancels pending initialization when debugger ownership is lost', async () => {
    const { child, contents, events, debuggerClient, releaseWorld } = fixture({
      delayedWorld: true,
    })
    const addressing = createFrameAddressing(contents, () => true)
    const resolving = addressing.resolve(child, capture())
    for (
      let i = 0;
      i < 50 &&
      !debuggerClient.sendCommand.mock.calls.some(
        ([method]) => method === 'Page.createIsolatedWorld',
      );
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 0))
    events.emit('detach')
    const commandCount = debuggerClient.sendCommand.mock.calls.length
    releaseWorld()
    await expect(resolving).rejects.toThrow()
    expect(debuggerClient.sendCommand).toHaveBeenCalledTimes(commandCount)
    expect(debuggerClient.detach).not.toHaveBeenCalled()
    await expect(addressing.resolve(child, capture())).rejects.toThrow('no longer available')
    expect(debuggerClient.attach).toHaveBeenCalledTimes(1)
    addressing.dispose()
    expect(debuggerClient.detach).not.toHaveBeenCalled()
  })

  it('does not detach a replacement debugger attached by an earlier detach listener', async () => {
    const { child, contents, debuggerClient, events, setAttached } = fixture()
    events.on('detach', () => setAttached(true))
    const addressing = createFrameAddressing(contents, () => true)
    await addressing.resolve(child, capture())
    events.emit('detach')
    expect(debuggerClient.detach).not.toHaveBeenCalled()
    addressing.dispose()
  })

  it('invalidates old leases on revocation and preserves token isolation across adapters', async () => {
    const first = fixture()
    const second = fixture()
    const owner = capture()
    const one = createFrameAddressing(first.contents, () => true)
    const two = createFrameAddressing(second.contents, () => true)
    const address = await one.resolve(first.child, owner)
    one.revoke(owner)
    await expect(one.evaluate(address, '1')).rejects.toThrow('unknown frame address lease')
    await expect(two.evaluate(address, '1')).rejects.toThrow('unknown frame address lease')
    one.dispose()
    two.dispose()
  })

  it('releases only its own debugger when a command fails', async () => {
    const { child, contents, debuggerClient } = fixture()
    debuggerClient.sendCommand.mockRejectedValueOnce(new Error('lost'))
    const addressing = createFrameAddressing(contents, () => true)
    await expect(addressing.resolve(child, capture())).rejects.toThrow('lost')
    expect(debuggerClient.detach).toHaveBeenCalledTimes(1)
    addressing.dispose()
    expect(debuggerClient.detach).toHaveBeenCalledTimes(1)
  })
})
