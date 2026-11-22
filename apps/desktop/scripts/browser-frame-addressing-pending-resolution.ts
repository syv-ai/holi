import assert from 'node:assert/strict'
import type { WebContents, WebFrameMain } from 'electron'
import { createFrameAddressing, type FrameCapture } from './browser-frame-addressing'
import { proveCancelledWorldStability } from './browser-frame-addressing-cancelled-worlds'
import { fixtureEmbeddingId, fixtureFrames } from './browser-frame-addressing-fixture'
import {
  deferred,
  resetFixture,
  type Check,
  type PhaseInput,
} from './browser-frame-addressing-phase-fixture'

const capture = (): FrameCapture => Object.freeze({ tab: {}, document: {}, presentation: {} })

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('native frame lifecycle did not settle')
}

async function ownedFrame(contents: WebContents, id: string): Promise<WebFrameMain> {
  for (const frame of fixtureFrames(contents))
    if ((await fixtureEmbeddingId(frame)) === id) return frame
  throw new Error(`fixture owner #${id} was not found`)
}

async function proveDetachedDocuments(contents: WebContents, check: Check): Promise<void> {
  let adapter = createFrameAddressing(contents, () => true)
  try {
    const frame = await ownedFrame(contents, 'same-b')
    const oldAddress = await adapter.resolve(frame, capture())
    assert(await adapter.verifyOwner(oldAddress, '#same-b'))
    check(true, 'detached-lifetime-precondition-owner-valid')
    adapter.dispose()
    assert(!contents.debugger.isAttached(), 'navigation starts with debugger detached')
    await frame.executeJavaScript("location.href='/detached-lifetime-navigation'")
    await waitFor(() => frame.url.endsWith('/detached-lifetime-navigation'))
    assert(!contents.debugger.isAttached(), 'navigation completed without an adapter observing it')
    adapter = createFrameAddressing(contents, () => true)
    const current = await ownedFrame(contents, 'same-b')
    const navigated = await adapter.resolve(current, capture())
    assert.equal(
      await adapter.evaluate(navigated, 'location.pathname'),
      '/detached-lifetime-navigation',
    )
    assert(await adapter.verifyOwner(navigated, '#same-b'))
    await assert.rejects(adapter.evaluate(oldAddress, '1'), /unknown frame address lease/)
    check(true, 'detached-navigation-revokes-old-lease-through-broker')
    adapter.dispose()
    assert(!contents.debugger.isAttached())
    await contents.executeJavaScript("document.querySelector('#same-b').remove()")
    await waitFor(() => !fixtureFrames(contents).includes(current))
    await contents.executeJavaScript(
      "const replacement=document.createElement('iframe'); replacement.name='duplicate'; replacement.id='same-b'; replacement.src='/child/same-b'; document.body.append(replacement)",
    )
    await waitFor(() =>
      fixtureFrames(contents).some((candidate) => candidate.url.endsWith('/child/same-b')),
    )
    assert(!contents.debugger.isAttached(), 'removal and replacement complete while detached')
    adapter = createFrameAddressing(contents, () => true)
    await assert.rejects(adapter.evaluate(navigated, '1'), /unknown frame address lease/)
    for (const id of ['same-a', 'same-b']) {
      const native = await ownedFrame(contents, id)
      const address = await adapter.resolve(native, capture())
      assert(await adapter.verifyOwner(address, `#${id}`))
    }
    check(true, 'detached-removal-recreate-has-fresh-owner-and-no-old-lease')
  } finally {
    adapter.dispose()
  }
}

export async function runPendingResolutionNavigation(input: PhaseInput): Promise<void> {
  const { contents } = input
  const check: Check = input.check
  await resetFixture(contents, input.port)
  const frame = await ownedFrame(contents, 'same-b')
  check(true, 'fresh-same-b-candidate-acquired')
  const started = deferred<void>()
  const gate = deferred<void>()
  const client = contents.debugger
  const originalSend = client.sendCommand.bind(client)
  const oldAdapter = createFrameAddressing(contents, () => true)
  let pending: ReturnType<typeof oldAdapter.resolve> | undefined
  client.sendCommand = async (method, params, session) => {
    if (method === 'Page.createIsolatedWorld') {
      started.resolve()
      await gate.promise
    }
    return originalSend(method, params, session)
  }
  try {
    pending = oldAdapter.resolve(frame, capture())
    void pending.catch(() => {})
    await started.promise
    check(true, 'pending-resolution-reached-pre-world-command-gate')
    await frame.executeJavaScript("location.href='/pending-navigation'")
    await waitFor(() => frame.url.endsWith('/pending-navigation'))
    gate.resolve()
    await assert.rejects(pending, /no longer current|departed document|not current/)
  } finally {
    gate.resolve()
    client.sendCommand = originalSend
    oldAdapter.dispose()
    await pending?.catch(() => {})
  }
  const freshAdapter = createFrameAddressing(contents, () => true)
  try {
    const lease = await freshAdapter.resolve(await ownedFrame(contents, 'same-b'), capture())
    check(await freshAdapter.verifyOwner(lease, '#same-b'), 'pending-resolution-revocation')
  } finally {
    freshAdapter.dispose()
  }
  await proveDetachedDocuments(contents, check)
  await resetFixture(contents, input.port)
  await proveCancelledWorldStability(
    contents,
    await ownedFrame(contents, 'same-nested'),
    '#same-nested',
    check,
  )
  check(true, 'late-world-response-fresh-adapter-owner-valid')
  check(true, 'allocated-world-delayed-response-cancelled-without-stale-handler-command')
  await proveCancelledWorldStability(contents, await ownedFrame(contents, 'cross'), '#cross', check)
  check(true, 'oopif-allocated-world-delayed-response-recovery')
}
