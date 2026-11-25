import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import type { WebContents, WebFrameMain } from 'electron'
import {
  createFrameAddressing,
  type FrameCapture,
} from '../src/plugins/browser/main/frame-addressing'
import { deferred, type Check } from './browser-frame-addressing-phase-fixture'

/** Observe actual native worlds across cancelled replies, not adapter cache counters. */
export async function proveCancelledWorldStability(
  contents: WebContents,
  frame: WebFrameMain,
  selector: string,
  check: Check,
): Promise<void> {
  const client = contents.debugger
  const originalSend = client.sendCommand.bind(client)
  const descriptors = new Map<string, { uniqueId: string; frameId: string }>()
  const worldIds = new Set<string>()
  let expectedSentinel: string | undefined
  let firstInitializations = 0
  let targetFrameId: string | undefined
  let targetWorldName: string | undefined
  let commands = 0
  const descriptorKey = (session: string | undefined, id: number) => `${session ?? ''}\0${id}`
  const observe = (_event: unknown, method: string, params: any, session?: string) => {
    if (method === 'Runtime.executionContextCreated') {
      const context = params.context
      if (typeof context.uniqueId === 'string' && typeof context.auxData?.frameId === 'string')
        descriptors.set(descriptorKey(session, context.id), {
          uniqueId: context.uniqueId,
          frameId: context.auxData.frameId,
        })
    } else if (method === 'Runtime.executionContextDestroyed') {
      descriptors.delete(descriptorKey(session, params.executionContextId))
    } else if (method === 'Runtime.executionContextsCleared') {
      for (const key of descriptors.keys())
        if (key.startsWith(`${session ?? ''}\0`)) descriptors.delete(key)
    }
  }
  client.on('message', observe)
  try {
    for (let cycle = 0; cycle < 3; cycle++) {
      assert(!client.isAttached(), 'each cancellation cycle begins without an adapter')
      const started = deferred<void>()
      const gate = deferred<void>()
      const oldAdapter = createFrameAddressing(contents, () => true)
      let recovered: ReturnType<typeof createFrameAddressing> | undefined
      let pending: ReturnType<typeof oldAdapter.resolve> | undefined
      let intercept = true
      let timeout: ReturnType<typeof setTimeout> | undefined
      const capture = (): FrameCapture => Object.freeze({ tab: {}, document: {}, presentation: {} })
      const replacementSend = async (method: string, params?: any, session?: string) => {
        commands++
        const result = await originalSend(method, params, session)
        if (method !== 'Page.createIsolatedWorld') return result
        const created = result as { executionContextId: number }
        const descriptor = descriptors.get(descriptorKey(session, created.executionContextId))
        assert(descriptor, 'actual allocated/replayed world has an authenticated native descriptor')
        if (intercept) {
          intercept = false
          targetFrameId ??= params.frameId
          targetWorldName ??= params.worldName
          assert.equal(params.frameId, targetFrameId, 'document remains unchanged across cycles')
          assert.equal(
            params.worldName,
            targetWorldName,
            'reservation survives adapter cancellation',
          )
          const nonce = randomBytes(24).toString('hex')
          const initialized = (await originalSend(
            'Runtime.evaluate',
            {
              expression: `(() => { const first = !Object.hasOwn(globalThis, '__holiCancelledWorldSentinel'); if (first) globalThis.__holiCancelledWorldSentinel = ${JSON.stringify(nonce)}; return { first, sentinel: globalThis.__holiCancelledWorldSentinel } })()`,
              uniqueContextId: descriptor.uniqueId,
              returnByValue: true,
            },
            session,
          )) as {
            result: { value: { first: boolean; sentinel: string } }
            exceptionDetails?: unknown
          }
          assert(!initialized.exceptionDetails)
          const value = initialized.result.value
          if (value.first) firstInitializations++
          expectedSentinel ??= value.sentinel
          assert.equal(
            value.sentinel,
            expectedSentinel,
            'cancelled allocation reuses the actual V8 world',
          )
          started.resolve()
          await gate.promise
        }
        if (params.frameId === targetFrameId && params.worldName === targetWorldName)
          worldIds.add(descriptor.uniqueId)
        return result
      }
      client.sendCommand = replacementSend
      try {
        pending = oldAdapter.resolve(frame, capture())
        void pending.catch(() => {})
        await Promise.race([
          started.promise,
          pending.then(() => {
            throw new Error('resolve completed without reaching its allocation-response gate')
          }),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error('native allocation-response gate timed out')),
              5_000,
            )
          }),
        ])
        clearTimeout(timeout)
        oldAdapter.dispose()
        await assert.rejects(pending, /no longer available|ownership|epoch/)
        recovered = createFrameAddressing(contents, () => true)
        const address = await recovered.resolve(frame, capture())
        assert.equal(
          await recovered.evaluate(address, 'globalThis.__holiCancelledWorldSentinel'),
          expectedSentinel,
          'fresh lease reaches the already allocated native world, not a new world',
        )
        assert(
          await recovered.verifyOwner(address, selector),
          'recovered lease has the exact native owner',
        )
        const beforeLateDelivery = commands
        gate.resolve()
        await new Promise<void>((resolve) => setImmediate(resolve))
        assert.equal(
          commands,
          beforeLateDelivery,
          'late response issues no replacement-client commands',
        )
        assert.equal(
          await recovered.evaluate(address, 'globalThis.__holiCancelledWorldSentinel'),
          expectedSentinel,
        )
      } finally {
        clearTimeout(timeout)
        gate.resolve()
        oldAdapter.dispose()
        recovered?.dispose()
        client.sendCommand = originalSend
        await pending?.catch(() => {})
      }
    }
    assert.equal(
      firstInitializations,
      1,
      'three cancellations initialize only one actual isolated world',
    )
    assert.equal(
      worldIds.size,
      1,
      'three cancellation/recovery cycles retain one authenticated native world',
    )
    check(
      true,
      `${selector === '#cross' ? 'oopif' : 'nested'}-post-allocation-cancel-churn-keeps-one-native-world`,
    )
  } finally {
    client.sendCommand = originalSend
    client.removeListener('message', observe)
  }
}
