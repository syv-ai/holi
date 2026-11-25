import assert from 'node:assert/strict'
import type { WebFrameMain } from 'electron'
import { fixtureFrames } from './browser-frame-addressing-fixture'
import type { FrameAddress, FrameCapture } from '../src/plugins/browser/main/frame-addressing'
import { FrameAddressingScenario } from './browser-frame-addressing-scenario'
import {
  deferred,
  resetFixture,
  type Check,
  type PhaseInput,
} from './browser-frame-addressing-phase-fixture'

export async function runPendingEvaluationAndCrossProcessNavigation(
  input: PhaseInput,
): Promise<void> {
  const { contents: wc, port } = input
  const check: Check = input.check
  const allFrames = () => fixtureFrames(wc)
  let scenario: FrameAddressingScenario | undefined
  try {
    await resetFixture(wc, port)
    scenario = new FrameAddressingScenario(wc, () => true)
    const originalSend = wc.debugger.sendCommand.bind(wc.debugger)
    const debuggerClient = wc.debugger as unknown as {
      sendCommand: (...args: any[]) => Promise<unknown>
    }
    const initialCapture: FrameCapture = Object.freeze({ tab: {}, document: {}, presentation: {} })
    let sameBFrame: WebFrameMain | undefined
    let postNavigationAddress: FrameAddress | undefined
    for (const candidate of allFrames().filter(
      (frame) => frame.parent === wc.mainFrame && frame.name === 'duplicate',
    )) {
      const candidateLease = await scenario.resolve(candidate, initialCapture)
      if (await scenario.verifyOwner(candidateLease, '#same-b')) {
        sameBFrame = candidate
        postNavigationAddress = candidateLease
        break
      }
    }
    assert(
      sameBFrame && postNavigationAddress,
      'same-b lease is positively verified before pending evaluation',
    )
    const evalStarted = deferred<void>()
    const evalGate = deferred<void>()
    debuggerClient.sendCommand = async (...args) => {
      const result = await originalSend(...(args as Parameters<typeof wc.debugger.sendCommand>))
      if (
        args[0] === 'Runtime.evaluate' &&
        JSON.stringify(args[1]).includes('pendingFixtureEvaluation')
      ) {
        evalStarted.resolve()
        await evalGate.promise
      }
      return result
    }
    try {
      const pendingEvaluation = scenario.evaluate(
        postNavigationAddress,
        'globalThis.pendingFixtureEvaluation = 73',
      )
      const pendingEvaluationRejection = assert.rejects(pendingEvaluation)
      await evalStarted.promise
      await sameBFrame.executeJavaScript("location.href='/evaluation-navigation'")
      for (
        let attempt = 0;
        attempt < 100 && !sameBFrame.url.endsWith('/evaluation-navigation');
        attempt++
      )
        await new Promise((resolve) => setTimeout(resolve, 20))
      check(
        sameBFrame.url.endsWith('/evaluation-navigation'),
        'navigation completed during pending native evaluation',
      )
      evalGate.resolve()
      await pendingEvaluationRejection
    } finally {
      evalGate.resolve()
      debuggerClient.sendCommand = originalSend
    }
    const afterAbaCapture: FrameCapture = Object.freeze({ tab: {}, document: {}, presentation: {} })
    let currentSameB: WebFrameMain | undefined
    for (const candidate of allFrames().filter(
      (frame) => frame.parent === wc.mainFrame && frame.name === 'duplicate',
    )) {
      const candidateLease = await scenario.resolve(candidate, afterAbaCapture)
      if (await scenario.verifyOwner(candidateLease, '#same-b')) {
        currentSameB = candidate
        break
      }
    }
    assert(currentSameB, 'reacquired native frame positively resolves to #same-b')
    const afterAbaAddress = await scenario.resolve(currentSameB, afterAbaCapture)
    check(await scenario.verifyOwner(afterAbaAddress, '#same-b'), 'pending-evaluation-revocation')
    const crossNavigationCapture: FrameCapture = Object.freeze({
      tab: {},
      document: {},
      presentation: {},
    })
    let sameOriginFrame: WebFrameMain | undefined
    let sameOriginAddress: FrameAddress | undefined
    for (const candidate of allFrames().filter(
      (frame) => frame.parent === wc.mainFrame && frame.url.endsWith('/child'),
    )) {
      const address = await scenario.resolve(candidate, crossNavigationCapture)
      if (await scenario.verifyOwner(address, '#same-a')) {
        sameOriginFrame = candidate
        sameOriginAddress = address
        break
      }
    }
    assert(
      sameOriginFrame && sameOriginAddress,
      'native same-origin child is positively mapped to #same-a',
    )
    const crossNavigationStarted = deferred<void>()
    const crossNavigationGate = deferred<void>()
    debuggerClient.sendCommand = async (...args) => {
      const result = await originalSend(...(args as Parameters<typeof wc.debugger.sendCommand>))
      if (
        args[0] === 'Runtime.evaluate' &&
        JSON.stringify(args[1]).includes('pendingCrossProcessNavigation')
      ) {
        crossNavigationStarted.resolve()
        await crossNavigationGate.promise
      }
      return result
    }
    try {
      const pendingCrossNavigation = scenario.evaluate(
        sameOriginAddress,
        'globalThis.pendingCrossProcessNavigation = 1',
      )
      const pendingCrossNavigationRejection = assert.rejects(pendingCrossNavigation)
      await crossNavigationStarted.promise
      const beforeProcessId = sameOriginFrame.processId
      await wc.executeJavaScript(
        `document.querySelector('#same-a').src='http://localhost:${port}/child'`,
      )
      for (
        let attempt = 0;
        attempt < 200 &&
        (sameOriginFrame.processId === beforeProcessId ||
          !sameOriginFrame.url.startsWith('http://localhost:'));
        attempt++
      )
        await new Promise((resolve) => setTimeout(resolve, 20))
      assert(
        sameOriginFrame.processId !== beforeProcessId &&
          sameOriginFrame.url.startsWith('http://localhost:'),
        'cross-process navigation changes the exact native frame document and process',
      )
      const navigatedFrame = sameOriginFrame
      const freshCapture: FrameCapture = Object.freeze({ tab: {}, document: {}, presentation: {} })
      crossNavigationGate.resolve()
      await pendingCrossNavigationRejection
      const freshAddress = await scenario.resolve(navigatedFrame, freshCapture)
      check(
        await scenario.verifyOwner(freshAddress, '#same-a'),
        'cross-process-navigation-unique-context-addressing',
      )
    } finally {
      crossNavigationGate.resolve()
      debuggerClient.sendCommand = originalSend
    }
  } finally {
    scenario?.dispose()
  }
}
