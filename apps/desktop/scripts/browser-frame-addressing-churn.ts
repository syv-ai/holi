import assert from 'node:assert/strict'
import type { FrameAddress, FrameCapture } from '../src/plugins/browser/main/frame-addressing'
import { FrameAddressingScenario } from './browser-frame-addressing-scenario'
import { fixtureEmbeddingId, fixtureFrames } from './browser-frame-addressing-fixture'
import { resetFixture, type Check, type PhaseInput } from './browser-frame-addressing-phase-fixture'

/** Native proof that capture churn and adapter lifetimes do not allocate per-capture worlds. */
export async function runBoundedCaptureChurn(input: PhaseInput): Promise<void> {
  const { contents, port } = input
  const check: Check = input.check
  await resetFixture(contents, port)
  const frames = fixtureFrames(contents)
  let sameA: (typeof frames)[number] | undefined
  for (const candidate of frames.filter(
    (frame) => frame.parent === contents.mainFrame && frame.name === 'duplicate',
  ))
    if ((await fixtureEmbeddingId(candidate)) === 'same-a') sameA = candidate
  const targets = [
    { frame: sameA, owner: '#same-a' },
    {
      frame: frames.find((candidate) => candidate.url.endsWith('/child/same-grandchild')),
      owner: '#same-nested',
    },
    {
      frame: frames.find((candidate) => candidate.url.endsWith('/child/cross')),
      owner: '#cross',
    },
    {
      frame: frames.find((candidate) => candidate.url.endsWith('/grandchild')),
      owner: '#cross-nested',
    },
  ]
  assert(
    targets.every((target) => target.frame),
    'nested same-origin and cross-site OOPIF targets are available',
  )

  const debuggerClient = contents.debugger as unknown as {
    sendCommand: (...args: any[]) => Promise<unknown>
    on: (event: string, listener: (...args: any[]) => void) => void
    removeListener: (event: string, listener: (...args: any[]) => void) => void
  }
  const originalSend = debuggerClient.sendCommand.bind(contents.debugger)
  const worldsByFrame = new Map<string, number>()
  const liveWorlds = new Map<string, string>()
  const worldReferences = new Map<string, number>()
  let createdFrameWorldCommands = 0
  const observedWorlds = new Set<string>()
  const onMessage = (_event: unknown, method: string, params: any, sessionId?: string) => {
    if (
      method === 'Runtime.executionContextCreated' &&
      (params.context.name?.startsWith('holi-frame-') ||
        params.context.name?.startsWith('holi-owner-'))
    ) {
      const contextKey = `${sessionId ?? ''}\0${params.context.id as number}`
      const frameId = params.context.auxData?.frameId as string | undefined
      const uniqueId = params.context.uniqueId as string | undefined
      if (frameId && uniqueId && !liveWorlds.has(contextKey)) {
        const worldKey = `${frameId}\0${uniqueId}`
        observedWorlds.add(worldKey)
        liveWorlds.set(contextKey, worldKey)
        worldReferences.set(worldKey, (worldReferences.get(worldKey) ?? 0) + 1)
        worldsByFrame.set(worldKey, 1)
      }
    } else if (method === 'Runtime.executionContextDestroyed') {
      const contextKey = `${sessionId ?? ''}\0${params.executionContextId as number}`
      const worldKey = liveWorlds.get(contextKey)
      if (worldKey) {
        liveWorlds.delete(contextKey)
        const references = (worldReferences.get(worldKey) ?? 1) - 1
        if (references > 0) worldReferences.set(worldKey, references)
        else {
          worldReferences.delete(worldKey)
          worldsByFrame.delete(worldKey)
        }
      }
    } else if (method === 'Runtime.executionContextsCleared') {
      const prefix = `${sessionId ?? ''}\0`
      for (const [key, worldKey] of liveWorlds)
        if (key.startsWith(prefix)) {
          liveWorlds.delete(key)
          const references = (worldReferences.get(worldKey) ?? 1) - 1
          if (references > 0) worldReferences.set(worldKey, references)
          else {
            worldReferences.delete(worldKey)
            worldsByFrame.delete(worldKey)
          }
        }
    }
  }
  debuggerClient.on('message', onMessage)
  debuggerClient.sendCommand = async (...args) => {
    if (
      args[0] === 'Page.createIsolatedWorld' &&
      String((args[1] as any)?.worldName).startsWith('holi-frame-')
    )
      createdFrameWorldCommands++
    return originalSend(...args)
  }

  let scenario: FrameAddressingScenario | undefined
  const staleLeases: Array<{ lease: FrameAddress; scenario: FrameAddressingScenario }> = []
  try {
    scenario = new FrameAddressingScenario(contents, () => true)
    for (let index = 0; index < 12; index++) {
      if (index > 0 && index % 3 === 0) {
        scenario.dispose()
        scenario = new FrameAddressingScenario(contents, () => true)
      }
      const target = targets[index % targets.length]!
      const frame = target.frame!
      const capture: FrameCapture = Object.freeze({ tab: {}, document: {}, presentation: {} })
      const lease = await scenario.resolve(frame, capture)
      assert(
        await scenario.verifyOwner(lease, target.owner),
        `exact immediate owner at capture ${index}`,
      )
      scenario.revoke(capture)
      await assert.rejects(scenario.evaluate(lease, 'location.pathname'), /unknown|current|lease/i)
      staleLeases.push({ lease, scenario })
    }

    // Named-world commands can repeat across attachments without allocating a world.
    // Count browser-authenticated native identities for both target and owner roles.
    const expectedWorlds = targets.length + new Set(targets.map(({ frame }) => frame!.parent)).size
    const bounded =
      observedWorlds.size === expectedWorlds &&
      worldsByFrame.size === expectedWorlds &&
      [...worldsByFrame.values()].every((count) => count === 1) &&
      worldReferences.size === expectedWorlds
    assert(
      bounded,
      `isolated-world churn counts: ${JSON.stringify({ createdFrameWorldCommands, observedWorlds: observedWorlds.size, worldsByFrame: [...worldsByFrame], liveWorlds: liveWorlds.size })}`,
    )
    check(
      bounded,
      'four-adapter-twelve-capture-nested-oopif-worlds-remain-bounded-with-exact-owners',
    )

    const nextCapture: FrameCapture = Object.freeze({
      tab: {},
      document: {},
      presentation: {},
    })
    const frame = targets[0]!.frame!
    const nextLease = await scenario.resolve(frame, nextCapture)
    const newLeaseWorks =
      (await scenario.evaluate<string>(nextLease, 'location.pathname')) === '/child' &&
      observedWorlds.size === expectedWorlds &&
      worldReferences.size === expectedWorlds
    for (const { lease, scenario: oldScenario } of staleLeases) {
      let rejected = false
      try {
        await oldScenario.evaluate(lease, 'location.pathname')
      } catch {
        rejected = true
      }
      assert(rejected, 'revoked or previous-adapter lease remains unusable')
    }
    check(newLeaseWorks, 'new-capture-lease-works-without-world-growth-after-revocation')
  } finally {
    scenario?.dispose()
    debuggerClient.removeListener('message', onMessage)
    debuggerClient.sendCommand = originalSend
  }
}
