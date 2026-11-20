import type { FrameCapture } from './browser-frame-addressing'
import {
  fixtureEmbeddingId,
  fixtureFrames,
  waitForFixtureFrames,
} from './browser-frame-addressing-fixture'
import { FrameAddressingScenario } from './browser-frame-addressing-scenario'
import { resetFixture, type Check, type PhaseInput } from './browser-frame-addressing-phase-fixture'

export async function runMutationOwnerMatrices(input: PhaseInput): Promise<void> {
  const { contents: wc } = input
  const check: Check = input.check
  let scenario: FrameAddressingScenario | undefined
  try {
    await resetFixture(wc, input.port)
    const allFrames = () => fixtureFrames(wc)
    const capture: FrameCapture = Object.freeze({ tab: {}, document: {}, presentation: {} })
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
    const insertedSelectors = [...insertedExpected.values()]
    const insertedOwners: boolean[][] = []
    for (const frame of insertedHandles) {
      const address = await scenario.resolve(frame, capture)
      insertedOwners.push(
        await Promise.all(
          insertedSelectors.map((selector) => scenario!.verifyOwner(address, selector)),
        ),
      )
    }
    check(
      insertedHandles.length === insertedExpected.size &&
        insertedHandles.every((frame, index) => {
          const expected = insertedExpected.get(frame)
          return (
            Boolean(expected) &&
            insertedOwners[index]!.every(
              (matched, ownerIndex) => matched === (insertedSelectors[ownerIndex] === expected),
            ) &&
            insertedOwners[index]!.filter(Boolean).length === 1
          )
        }) &&
        insertedSelectors.every(
          (selector) =>
            insertedOwners.filter((row) => row[insertedSelectors.indexOf(selector)]).length === 1,
        ),
      'inserted-frame-owner-matrix-from-independent-source-identity',
    )
    const initialOrder = await wc.executeJavaScript(
      '[...document.querySelectorAll(\"iframe\")].map((frame) => frame.id)',
    )
    await wc.executeJavaScript(
      "document.querySelector('#same-a').before(document.querySelector('#same-b'))",
    )
    let reorderedOrder: string[] = []
    for (let attempt = 0; attempt < 200; attempt++) {
      const ready = await Promise.all(
        allFrames().map(async (frame) => {
          try {
            return (await frame.executeJavaScript('document.readyState')) === 'complete'
          } catch {
            return false
          }
        }),
      )
      if (ready.every(Boolean)) {
        reorderedOrder = await wc.executeJavaScript(
          '[...document.querySelectorAll(\"iframe\")].map((frame) => frame.id)',
        )
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    check(
      initialOrder.indexOf('same-a') < initialOrder.indexOf('same-b') &&
        reorderedOrder.indexOf('same-b') < reorderedOrder.indexOf('same-a'),
      'reordering-reversed-observed-dom-order-after-document-readiness',
    )
    const reorderedHandles = allFrames()
    const reorderedExpected = new Map(
      await Promise.all(
        reorderedHandles.map(
          async (frame) => [frame, `#${await fixtureEmbeddingId(frame)}`] as const,
        ),
      ),
    )
    const reorderedSelectors = [...reorderedExpected.values()]
    const reorderedOwners: boolean[][] = []
    for (const frame of reorderedHandles) {
      const address = await scenario.resolve(frame, capture)
      reorderedOwners.push(
        await Promise.all(
          reorderedSelectors.map((selector) => scenario!.verifyOwner(address, selector)),
        ),
      )
    }
    check(
      reorderedHandles.length === reorderedExpected.size &&
        reorderedHandles.every((frame, index) => {
          const expected = reorderedExpected.get(frame)
          const row = reorderedOwners[index]!
          return (
            Boolean(expected) &&
            row.every(
              (matched, ownerIndex) => matched === (reorderedSelectors[ownerIndex] === expected),
            ) &&
            row.filter(Boolean).length === 1
          )
        }) &&
        reorderedSelectors.every(
          (selector) =>
            reorderedOwners.filter((row) => row[reorderedSelectors.indexOf(selector)]).length === 1,
        ),
      'reordering-preserves-independent-complete-owner-matrix',
    )
  } finally {
    scenario?.dispose()
  }
}
