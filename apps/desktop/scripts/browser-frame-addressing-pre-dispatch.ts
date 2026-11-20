import assert from 'node:assert/strict'
import {
  fixtureEmbeddingId,
  fixtureFrames,
  waitForFixtureFrames,
} from './browser-frame-addressing-fixture'
import { randomBytes } from 'node:crypto'
import type { FrameCapture } from './browser-frame-addressing'
import { FrameAddressingScenario } from './browser-frame-addressing-scenario'
import {
  deferred,
  resetFixture,
  type Check,
  type PhaseInput,
} from './browser-frame-addressing-phase-fixture'

export async function runPreDispatchCrossProcessNavigation(input: PhaseInput): Promise<void> {
  const { contents: wc, port } = input
  const check: Check = input.check
  let scenario: FrameAddressingScenario | undefined
  const allFrames = () => fixtureFrames(wc)
  try {
    await resetFixture(wc, input.port)
    scenario = new FrameAddressingScenario(wc, () => true)
    await wc.executeJavaScript(
      `(() => { const frame=document.createElement('iframe'); frame.id='inserted'; frame.name='duplicate'; frame.src='/child'; document.body.append(frame) })()`,
    )
    await waitForFixtureFrames(allFrames, 6)
    await new Promise((resolve) => setTimeout(resolve, 150))
    const insertedHandles = allFrames().filter((frame) => frame.parent === wc.mainFrame)
    const insertedExpected = new Map(
      await Promise.all(
        insertedHandles.map(
          async (frame) => [frame, `#${await fixtureEmbeddingId(frame)}`] as const,
        ),
      ),
    )
    const originalSend = wc.debugger.sendCommand.bind(wc.debugger)
    const debuggerClient = wc.debugger as unknown as {
      sendCommand: (...args: any[]) => Promise<unknown>
    }
    const preDispatchFrame = insertedHandles.find(
      (frame) => insertedExpected.get(frame) === '#inserted',
    )!
    const preDispatchCapture: FrameCapture = Object.freeze({
      tab: {},
      document: {},
      presentation: {},
    })
    const preDispatchLease = await scenario.resolve(preDispatchFrame, preDispatchCapture)
    check(
      await scenario.verifyOwner(preDispatchLease, '#inserted'),
      'pre-dispatch target has exact owner',
    )
    const marker = `holi-${randomBytes(24).toString('hex')}`
    const markerAttribute = 'data-holi-pre-dispatch'
    await scenario.evaluate(
      preDispatchLease,
      `document.documentElement.setAttribute(${JSON.stringify(markerAttribute)}, ${JSON.stringify(marker)})`,
    )
    check(
      (await preDispatchFrame.executeJavaScript(
        `document.documentElement.getAttribute(${JSON.stringify(markerAttribute)})`,
      )) === marker,
      'native frame observes positive control from isolated execution world',
    )
    await preDispatchFrame.executeJavaScript(
      `document.documentElement.removeAttribute(${JSON.stringify(markerAttribute)})`,
    )
    const preDispatchStarted = deferred<void>()
    const preDispatchGate = deferred<void>()
    let dispatchedContext: string | undefined
    debuggerClient.sendCommand = async (...args) => {
      if (args[0] === 'Runtime.evaluate' && JSON.stringify(args[1]).includes(marker)) {
        dispatchedContext = (args[1] as { uniqueContextId?: string }).uniqueContextId
        preDispatchStarted.resolve()
        await preDispatchGate.promise
      }
      return originalSend(...(args as Parameters<typeof wc.debugger.sendCommand>))
    }
    try {
      const pending = scenario.evaluate(
        preDispatchLease,
        `document.documentElement.setAttribute(${JSON.stringify(markerAttribute)}, ${JSON.stringify(marker)})`,
      )
      await preDispatchStarted.promise
      const processBefore = preDispatchFrame.processId
      await wc.executeJavaScript(
        `document.querySelector('#inserted').src='http://localhost:${port}/child'`,
      )
      for (
        let attempt = 0;
        attempt < 200 &&
        (preDispatchFrame.processId === processBefore ||
          !preDispatchFrame.url.startsWith('http://localhost:'));
        attempt++
      )
        await new Promise((resolve) => setTimeout(resolve, 20))
      assert(
        preDispatchFrame.processId !== processBefore &&
          preDispatchFrame.url.startsWith('http://localhost:'),
        'pre-dispatch target completed cross-process navigation',
      )
      preDispatchGate.resolve()
      await assert.rejects(pending, /no longer current|document|context|lease/i)
      assert(dispatchedContext, 'the actual Runtime.evaluate dispatch used a uniqueContextId')
      assert.equal(
        await preDispatchFrame.executeJavaScript(
          `document.documentElement.getAttribute(${JSON.stringify(markerAttribute)})`,
        ),
        null,
        'old-document marker is absent from replacement DOM',
      )
      const replacementCapture: FrameCapture = Object.freeze({
        tab: {},
        document: {},
        presentation: {},
      })
      const replacementLease = await scenario.resolve(preDispatchFrame, replacementCapture)
      const positiveMarker = `${marker}-replacement`
      await scenario.evaluate(
        replacementLease,
        `document.documentElement.setAttribute(${JSON.stringify(markerAttribute)}, ${JSON.stringify(positiveMarker)})`,
      )
      assert.equal(
        await preDispatchFrame.executeJavaScript(
          `document.documentElement.getAttribute(${JSON.stringify(markerAttribute)})`,
        ),
        positiveMarker,
        'new replacement-document lease evaluates in the intended frame',
      )
      await preDispatchFrame.executeJavaScript(
        `document.documentElement.removeAttribute(${JSON.stringify(markerAttribute)})`,
      )
      check(true, 'pre-dispatch-cross-process-navigation-rejects-and-replacement-dom-stays-clear')
    } finally {
      preDispatchGate.resolve()
      debuggerClient.sendCommand = originalSend
    }
  } finally {
    scenario?.dispose()
  }
}
