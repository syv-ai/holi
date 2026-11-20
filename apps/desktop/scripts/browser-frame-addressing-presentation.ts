import assert from 'node:assert/strict'
import { fixtureFrames } from './browser-frame-addressing-fixture'
import type { BrowserWindow, WebContents, WebFrameMain } from 'electron'
import type { FrameAddress, FrameCapture } from './browser-frame-addressing'
import { FrameAddressingScenario } from './browser-frame-addressing-scenario'
import {
  deferred,
  resetFixture,
  type Check,
  type PhaseInput,
} from './browser-frame-addressing-phase-fixture'

async function runTrustedNativeInput(
  wc: WebContents,
  window: BrowserWindow,
  check: Check,
): Promise<void> {
  window.focus()
  wc.focus()
  await new Promise((resolve) => setTimeout(resolve, 100))
  const point = (await wc.executeJavaScript(
    `(() => { const r=document.querySelector('#trusted').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()`,
  )) as { x: number; y: number }
  wc.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
  wc.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  wc.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  let trusted: string | undefined
  for (let attempt = 0; attempt < 100 && trusted !== 'true'; attempt++) {
    trusted = await wc.executeJavaScript('document.body.dataset.clicked')
    if (trusted !== 'true') await new Promise((resolve) => setTimeout(resolve, 10))
  }
  check(trusted === 'true', 'trusted-native-input')
}

export async function runPresentationAbaAndNativeInput(
  input: PhaseInput & { window: BrowserWindow },
): Promise<void> {
  const { contents: wc, window } = input
  const check: Check = input.check
  const allFrames = () => fixtureFrames(wc)
  let live = true
  const retiredCaptures = new WeakSet<object>()
  let scenario: FrameAddressingScenario | undefined
  try {
    await resetFixture(wc, input.port)
    scenario = new FrameAddressingScenario(
      wc,
      (candidate) => live && !retiredCaptures.has(candidate as object),
    )
    const originalSend = wc.debugger.sendCommand.bind(wc.debugger)
    const debuggerClient = wc.debugger as unknown as {
      sendCommand: (...args: any[]) => Promise<unknown>
    }
    const lifecycleCapture: FrameCapture = Object.freeze({
      tab: {},
      document: {},
      presentation: {},
    })
    let lifecycleFrame: WebFrameMain | undefined
    let lifecycleLease: FrameAddress | undefined
    for (const candidate of allFrames().filter((frame) => frame.parent === wc.mainFrame)) {
      const candidateLease = await scenario.resolve(candidate, lifecycleCapture)
      if (await scenario.verifyOwner(candidateLease, '#same-b')) {
        lifecycleFrame = candidate
        lifecycleLease = candidateLease
        break
      }
    }
    assert(
      lifecycleFrame && lifecycleLease,
      'current native frame positively resolves to #same-b before trusted input',
    )
    check(wc.debugger.isAttached(), 'debugger lease is attached before trusted input')
    await runTrustedNativeInput(wc, window, check)
    check(wc.debugger.isAttached(), 'debugger lease remains attached after trusted input')
    check(
      await scenario.verifyOwner(lifecycleLease, '#same-b'),
      'same live frame-address lease remains exact after trusted input',
    )
    const presentationStarted = deferred<void>()
    const presentationGate = deferred<void>()
    debuggerClient.sendCommand = async (...args) => {
      const result = await originalSend(...(args as Parameters<typeof wc.debugger.sendCommand>))
      if (
        args[0] === 'Runtime.evaluate' &&
        JSON.stringify(args[1]).includes('pendingPresentationEvaluation')
      ) {
        presentationStarted.resolve()
        await presentationGate.promise
      }
      return result
    }
    try {
      const pendingPresentation = scenario.evaluate(
        lifecycleLease,
        'globalThis.pendingPresentationEvaluation = 1',
      )
      await presentationStarted.promise
      live = false
      retiredCaptures.add(lifecycleCapture as object)
      scenario.revoke(lifecycleCapture)
      live = true
      presentationGate.resolve()
      await assert.rejects(pendingPresentation, (error: unknown) => {
        assert(error instanceof Error)
        assert.match(error.message, /unknown frame address lease|no longer current/)
        assert.doesNotMatch(error.message, /no longer available/)
        return true
      })
    } finally {
      presentationGate.resolve()
      debuggerClient.sendCommand = originalSend
    }
    check(
      lifecycleFrame !== undefined && lifecycleLease !== undefined,
      'pending evaluation rejects presentation departure and A-to-B-to-A',
    )
    const returnedCapture: FrameCapture = Object.freeze({ tab: {}, document: {}, presentation: {} })
    const returnedLease = await scenario.resolve(lifecycleFrame, returnedCapture)
    check(
      await scenario.verifyOwner(returnedLease, '#same-b'),
      'navigation-replacement-and-presentation-aba',
    )
  } finally {
    scenario?.dispose()
  }
}
