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

export async function runDetachAndReplacement(input: PhaseInput): Promise<void> {
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
    const freshCapture: FrameCapture = Object.freeze({ tab: {}, document: {}, presentation: {} })
    let currentSameB: WebFrameMain | undefined
    let afterAbaAddress: FrameAddress | undefined
    for (const candidate of allFrames().filter(
      (frame) => frame.parent === wc.mainFrame && frame.name === 'duplicate',
    )) {
      const lease = await scenario.resolve(candidate, freshCapture)
      if (await scenario.verifyOwner(lease, '#same-b')) {
        currentSameB = candidate
        afterAbaAddress = lease
        break
      }
    }
    assert(
      currentSameB && afterAbaAddress,
      'fresh same-b lease positively verified immediately before replacement test',
    )
    const replacementCapture: FrameCapture = Object.freeze({
      tab: {},
      document: {},
      presentation: {},
    })
    let freshSameAFrame: WebFrameMain | undefined
    let freshSameALease: FrameAddress | undefined
    for (const candidate of allFrames().filter(
      (frame) => frame.parent === wc.mainFrame && frame.name === 'duplicate',
    )) {
      const candidateLease = await scenario.resolve(candidate, replacementCapture)
      if (await scenario.verifyOwner(candidateLease, '#same-a')) {
        freshSameAFrame = candidate
        freshSameALease = candidateLease
        break
      }
    }
    assert(
      freshSameAFrame && freshSameALease,
      'current native frame positively resolves to #same-a',
    )
    check(
      await scenario.verifyOwner(freshSameALease, '#same-a'),
      'replacement target has a freshly verified exact live lease',
    )
    const priorHandles = allFrames()
    await wc.executeJavaScript(
      "document.querySelector('#same-a').replaceWith(document.querySelector('#same-a').cloneNode(false))",
    )
    let replacement: (typeof priorHandles)[number] | undefined
    for (let i = 0; i < 200 && !replacement; i++) {
      replacement = allFrames().find((frame) => !priorHandles.includes(frame))
      if (!replacement) await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert(replacement, 'replacement iframe creates a new native frame handle')
    await assert.rejects(scenario.evaluate(freshSameALease, '1'))
    const replacementAddress = await scenario.resolve(replacement, replacementCapture)
    check(
      await scenario.verifyOwner(replacementAddress, '#same-a'),
      'replacement document receives its own exact owner lease',
    )
    const detachCapture: FrameCapture = Object.freeze({ tab: {}, document: {}, presentation: {} })
    let currentCross: WebFrameMain | undefined
    let currentCrossAddress: FrameAddress | undefined
    for (const candidate of allFrames().filter(
      (frame) => frame.parent === wc.mainFrame && frame.url.endsWith('/child/cross'),
    )) {
      const address = await scenario.resolve(candidate, detachCapture)
      if (await scenario.verifyOwner(address, '#cross')) {
        currentCross = candidate
        currentCrossAddress = address
        break
      }
    }
    assert(
      currentCross && currentCrossAddress,
      'current OOPIF handle has its exact owner before detach test',
    )
    const detachStarted = deferred<void>()
    const detachGate = deferred<void>()
    debuggerClient.sendCommand = async (...args) => {
      const result = await originalSend(...(args as Parameters<typeof wc.debugger.sendCommand>))
      if (
        args[0] === 'Runtime.evaluate' &&
        JSON.stringify(args[1]).includes('pendingDetachEvaluation')
      ) {
        detachStarted.resolve()
        await detachGate.promise
      }
      return result
    }
    try {
      const pendingDetachEvaluation = scenario.evaluate(
        currentCrossAddress,
        'globalThis.pendingDetachEvaluation = 1',
      )
      const pendingDetachRejection = assert.rejects(pendingDetachEvaluation)
      await detachStarted.promise
      await wc.executeJavaScript("document.querySelector('#cross').remove()")
      for (
        let attempt = 0;
        attempt < 100 && allFrames().some((frame) => frame.url.endsWith('/child/cross'));
        attempt++
      )
        await new Promise((resolve) => setTimeout(resolve, 20))
      detachGate.resolve()
      await pendingDetachRejection
    } finally {
      detachGate.resolve()
      debuggerClient.sendCommand = originalSend
    }
    check(
      !allFrames().some((frame) => frame.url.endsWith('/child/cross')),
      'pending-evaluation-rejects-on-oopif-detach',
    )
    const pendingReplacementCapture: FrameCapture = Object.freeze({
      tab: {},
      document: {},
      presentation: {},
    })
    let pendingReplacementFrame: WebFrameMain | undefined
    let pendingReplacementAddress: FrameAddress | undefined
    for (const candidate of allFrames().filter(
      (frame) => frame.parent === wc.mainFrame && frame.name === 'duplicate',
    )) {
      const candidateLease = await scenario.resolve(candidate, pendingReplacementCapture)
      if (await scenario.verifyOwner(candidateLease, '#same-b')) {
        pendingReplacementFrame = candidate
        pendingReplacementAddress = candidateLease
        break
      }
    }
    assert(
      pendingReplacementFrame && pendingReplacementAddress,
      'same-b lease is freshly acquired and verified immediately before pending replacement',
    )
    currentSameB = pendingReplacementFrame
    afterAbaAddress = pendingReplacementAddress
    const replacementStarted = deferred<void>()
    const replacementGate = deferred<void>()
    debuggerClient.sendCommand = async (...args) => {
      const result = await originalSend(...(args as Parameters<typeof wc.debugger.sendCommand>))
      if (
        args[0] === 'Runtime.evaluate' &&
        JSON.stringify(args[1]).includes('pendingReplacementEvaluation')
      ) {
        replacementStarted.resolve()
        await replacementGate.promise
      }
      return result
    }
    let replacementControl: boolean | undefined
    let replacementControlAddress: FrameAddress | undefined
    try {
      const pendingReplacementEvaluation = scenario.evaluate(
        afterAbaAddress,
        'globalThis.pendingReplacementEvaluation = 1',
      )
      const pendingReplacementRejection = assert.rejects(pendingReplacementEvaluation)
      await replacementStarted.promise
      const replacedFrame = currentSameB
      await wc.executeJavaScript(
        "document.querySelector('#same-b').replaceWith(document.querySelector('#same-b').cloneNode(false))",
      )
      for (let attempt = 0; attempt < 100 && allFrames().includes(replacedFrame); attempt++)
        await new Promise((resolve) => setTimeout(resolve, 20))
      check(
        !allFrames().includes(replacedFrame),
        'native iframe replacement departed the pending evaluation owner',
      )
      replacementGate.resolve()
      await pendingReplacementRejection
      const replacementCapture: FrameCapture = Object.freeze({
        tab: {},
        document: {},
        presentation: {},
      })
      for (const candidate of allFrames().filter(
        (frame) => frame.parent === wc.mainFrame && frame.name === 'duplicate',
      )) {
        const candidateLease = await scenario.resolve(candidate, replacementCapture)
        if (await scenario.verifyOwner(candidateLease, '#same-b')) {
          replacementControl = true
          replacementControlAddress = candidateLease
        }
      }
      check(replacementControl === true, 'new exact owner lease succeeds after pending replacement')
    } finally {
      replacementGate.resolve()
      debuggerClient.sendCommand = originalSend
    }
    assert(
      replacementControlAddress,
      'replacement has a positively verified exact live owner lease',
    )
    check(replacementControl === true, 'pending-evaluation-rejects-on-replacement')
    check(
      await scenario.verifyOwner(replacementControlAddress, '#same-b'),
      'post-navigation-positive-control-retains-exact-owner',
    )
    const navigationTargetCapture: FrameCapture = Object.freeze({
      tab: {},
      document: {},
      presentation: {},
    })
    let navigationTarget: WebFrameMain | undefined
    let navigationLease: FrameAddress | undefined
    for (const candidate of allFrames().filter(
      (frame) => frame.parent === wc.mainFrame && frame.name === 'duplicate',
    )) {
      const lease = await scenario.resolve(candidate, navigationTargetCapture)
      if (await scenario.verifyOwner(lease, '#same-b')) {
        navigationTarget = candidate
        navigationLease = lease
        break
      }
    }
    assert(
      navigationTarget && navigationLease,
      'navigation target has a positively verified exact owner lease',
    )
    await navigationTarget.executeJavaScript("location.href='/replacement'")
    for (let i = 0; i < 100 && !navigationTarget.url.endsWith('/replacement'); i++)
      await new Promise((resolve) => setTimeout(resolve, 20))
    assert(navigationTarget.url.endsWith('/replacement'), 'target document completed navigation')
    await assert.rejects(
      scenario.evaluate(navigationLease, '1'),
      /unknown frame address lease|frame document context is no longer current|no longer current/,
    )
    check(true, 'replacement-document-navigation-revokes-lease')
  } finally {
    scenario?.dispose()
  }
}
