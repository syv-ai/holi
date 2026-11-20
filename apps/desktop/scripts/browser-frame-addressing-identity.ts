import assert from 'node:assert/strict'
import type { WebFrameMain } from 'electron'
import { fixtureFrames } from './browser-frame-addressing-fixture'
import { randomBytes } from 'node:crypto'
import type { FrameAddress, FrameCapture } from './browser-frame-addressing'
import { FrameAddressingScenario } from './browser-frame-addressing-scenario'
import { resetFixture, type Check, type PhaseInput } from './browser-frame-addressing-phase-fixture'

export async function runStaticIdentityAndOwnerOracle(input: PhaseInput): Promise<number[]> {
  const { contents: wc } = input
  const check: Check = input.check
  let scenario: FrameAddressingScenario | undefined
  try {
    await resetFixture(wc, input.port)
    const allFrames = () => fixtureFrames(wc)
    const frames = allFrames()
    const sameA = frames.find(
      (frame) =>
        frame.parent === wc.mainFrame && frame.name === 'duplicate' && frame.url.endsWith('/child'),
    )!
    const cross = frames.find((frame) => frame.url.endsWith('/child/cross'))!
    const sameNested = frames.find((frame) => frame.name === 'same-nested')!
    const crossNested = frames.find((frame) => frame.url.endsWith('/grandchild'))!
    check(
      Boolean(sameA && cross && sameNested && crossNested),
      'native tree exposes nested same-origin and cross-origin handles',
    )
    check(
      sameNested.parent === sameA && crossNested.parent === cross,
      'native handles expose each exact immediate parent, including OOPIF grandchild',
    )
    check(
      cross.processId !== sameA.processId && crossNested.processId !== cross.processId,
      'cross-origin subtree is an actual out-of-process frame',
    )
    check(
      frames.filter((frame) => frame.url === sameA.url && frame.name === 'duplicate').length === 2,
      'sibling frames have identical URL and name',
    )
    check(sameA.processId !== cross.processId, 'cross-origin child is an out-of-process frame')
    check(crossNested.processId !== cross.processId, 'cross-site grandchild is a second OOPIF')
    check(
      crossNested.parent === cross && crossNested.processId !== cross.processId,
      'cross-site-oopif-under-oopif',
    )
    const frameProcessIds = frames.map((frame) => frame.processId)
    const fixtureObservations = new Map<WebFrameMain, string>()
    for (const frame of frames) {
      const observation = `host-observation-${randomBytes(24).toString('hex')}`
      fixtureObservations.set(frame, observation)
      await frame.executeJavaScript(
        `document.body.dataset.hostObservation = ${JSON.stringify(observation)}`,
      )
    }
    const nativePreflight = await frames[0]!.executeJavaScript('42')
    check(
      nativePreflight === 42,
      'Electron main can execute an ordinary expression in a child frame',
    )
    const capture: FrameCapture = Object.freeze({ tab: {}, document: {}, presentation: {} })
    scenario = new FrameAddressingScenario(wc, () => true)
    const addresses = [] as FrameAddress[]
    for (const frame of frames) {
      addresses.push(await scenario!.resolve(frame, capture))
    }
    const privateValues: string[] = []
    for (const [index, frame] of frames.entries()) {
      const secret = `private-${index}-${Date.now()}`
      await scenario.evaluate(
        addresses[index]!,
        `globalThis.__holiPrivate = ${JSON.stringify(secret)}`,
      )
      const value: string = await scenario.evaluate<string>(
        addresses[index]!,
        'globalThis.__holiPrivate',
      )
      assert.equal(value, secret)
      privateValues.push(value)
      const pageValue = await frame.executeJavaScript('globalThis.__holiPrivate ?? null')
      assert.equal(pageValue, null, 'page cannot read isolated frame state')
      const isolatedObservation: string = await scenario!.evaluate<string>(
        addresses[index]!,
        'document.body.dataset.hostObservation',
      )
      assert.equal(
        isolatedObservation,
        fixtureObservations.get(frame),
        'host-assigned unique observation matches the exact native frame handle',
      )
    }
    check(
      new Set(privateValues).size === frames.length,
      'each exact native frame receives independent private state',
    )
    check(
      frames.length === 5 && sameNested.parent === sameA && crossNested.parent === cross,
      'nested-frame-tree',
    )
    check(
      privateValues.length === frames.length && new Set(privateValues).size === frames.length,
      'exact-native-context-correspondence',
    )
    const directFrames = frames.filter((frame) => frame.parent === wc.mainFrame)
    const directAddresses = directFrames.map((frame) => addresses[frames.indexOf(frame)]!)
    const sameB = directFrames.find((frame) => frame !== sameA && frame.url === sameA.url)!
    const expectedOwnerByFrame = new Map<WebFrameMain, string>([
      [sameA, '#same-a'],
      [sameB, '#same-b'],
      [cross, '#cross'],
    ])
    const expectedOwners = ['#same-a', '#same-b', '#cross']
    const ownerMatches = await Promise.all(
      directAddresses.map((address) =>
        Promise.all(expectedOwners.map((selector) => scenario!.verifyOwner(address, selector))),
      ),
    )
    check(
      await scenario.verifyOwner(addresses[frames.indexOf(sameNested)]!, '#same-nested'),
      'immediate parent owner is exact for same-origin grandchild',
    )
    check(
      await scenario.verifyOwner(addresses[frames.indexOf(crossNested)]!, '#cross-nested'),
      'immediate parent owner is exact for OOPIF grandchild',
    )
    check(
      ownerMatches.every((row, index) => {
        const expected = expectedOwnerByFrame.get(directFrames[index]!)
        return (
          row.filter(Boolean).length === 1 &&
          Boolean(expected) &&
          row[expectedOwners.indexOf(expected!)]
        )
      }),
      'immediate-parent-owner',
    )
    check(
      await scenario.verifyOwner(addresses[frames.indexOf(crossNested)]!, '#cross-nested'),
      'owner-oopif-grandchild',
    )
    for (let ownerIndex = 0; ownerIndex < expectedOwners.length; ownerIndex++) {
      const matches = ownerMatches.flatMap((row, frameIndex) =>
        row[ownerIndex] ? [frameIndex] : [],
      )
      check(
        matches.length === 1,
        `browser-authenticated owner ${expectedOwners[ownerIndex]} maps to exactly one frame`,
      )
    }
    for (const [index, row] of ownerMatches.entries()) {
      const expected = expectedOwnerByFrame.get(directFrames[index]!)
      assert(expected, 'every original native handle has an independent expected owner')
      assert.deepEqual(
        row,
        expectedOwners.map((owner) => owner === expected),
      )
      check(
        row.filter(Boolean).length === 1 && row[expectedOwners.indexOf(expected)],
        `native frame ${expected} has its exact embedding owner`,
      )
    }
    const snooped = await wc.executeJavaScript(
      `Array.from(document.querySelectorAll('iframe')).map(frame => { try { return frame.contentWindow.__holiPrivate ?? null } catch { return 'blocked' } })`,
    )
    check(
      !snooped.some((value: unknown) => typeof value === 'string' && value.startsWith('private-')),
      'top page cannot snoop isolated child state',
    )
    check(
      await wc.executeJavaScript(
        "typeof process === 'undefined' && typeof require === 'undefined'",
      ),
      'page has no Node bridge',
    )
    await wc.executeJavaScript(
      "document.querySelector('#same-a').setAttribute('data-holi-frame-id', 'forged-child')",
    )
    const privateAfterForgery = await scenario.evaluate<string>(
      addresses[frames.indexOf(sameA)]!,
      'globalThis.__holiPrivate',
    )
    assert.equal(privateAfterForgery, privateValues[0]!)
    check(
      privateAfterForgery === privateValues[0],
      'page-forged identity marker cannot redirect private frame context',
    )
    check(privateAfterForgery === privateValues[0], 'forged-marker-isolation')
    check(
      !snooped.some((value: unknown) => typeof value === 'string' && value.startsWith('private-')),
      'private-state-inaccessible',
    )
    return frameProcessIds
  } finally {
    scenario?.dispose()
  }
}
