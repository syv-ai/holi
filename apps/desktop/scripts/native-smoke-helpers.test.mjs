import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { createMdxSmokeUi } from './mdx-native-smoke-ui.mjs'
import { encodeScreencast } from './native-smoke-recording.mjs'
import { rowSnapshotExpression } from './native-smoke-row-snapshot.mjs'
import { assertExclusiveRowHover, assertStableRowBoxes } from './native-smoke-row-assertions.mjs'

test('native mdx readiness cancels an outstanding probe', { timeout: 5000 }, async () => {
  const controller = new AbortController()
  const { waitFor } = createMdxSmokeUi(controller.signal)
  const ready = { ready: true }
  assert.equal(await waitFor(() => ready, 'ready fixture'), ready)
  const pending = waitFor(() => new Promise(() => {}), 'pending fixture', 1000)
  const reason = new Error('fixture interrupted')
  controller.abort(reason)
  await assert.rejects(pending, (error) => error === reason)
})

test(
  'native mdx readiness rejects pending and late successful probes at its deadline',
  { timeout: 5000 },
  async () => {
    const { waitFor } = createMdxSmokeUi(new AbortController().signal)
    await assert.rejects(
      waitFor(() => new Promise(() => {}), 'pending fixture', 10),
      /Timed out/,
    )
    await assert.rejects(
      waitFor(
        () => {
          const until = performance.now() + 10
          while (performance.now() < until) {}
          return true
        },
        'late fixture',
        1,
      ),
      /Timed out/,
    )
  },
)

test('native mdx input never presses a button after cancellation during pointer movement', async () => {
  const controller = new AbortController()
  const { clickPointerAt } = createMdxSmokeUi(controller.signal)
  const events = []
  let finishMovement
  const movement = new Promise((resolve) => {
    finishMovement = resolve
  })
  const page = {
    call: async (_method, event) => {
      events.push(event.type)
      if (event.type === 'mouseMoved') await movement
    },
  }
  const clicking = clickPointerAt(page, { x: 10, y: 20 })
  const reason = new Error('fixture interrupted')
  controller.abort(reason)
  finishMovement()
  await assert.rejects(clicking, (error) => error === reason)
  assert.deepEqual(events, ['mouseMoved'])
})

test(
  'native mdx input never presses after a late pointer acknowledgement',
  { timeout: 5000 },
  async () => {
    const { clickPointerAt } = createMdxSmokeUi(new AbortController().signal)
    const events = []
    let finishMovement
    const movement = new Promise((resolve) => {
      finishMovement = resolve
    })
    const page = {
      call: async (_method, event) => {
        events.push(event.type)
        if (event.type === 'mouseMoved') await movement
      },
    }
    const clicking = clickPointerAt(page, { x: 10, y: 20 }, performance.now() + 100)
    const rejected = assert.rejects(clicking, /Timed out/)
    await new Promise((resolve) => setTimeout(resolve, 200))
    finishMovement()
    await rejected
    assert.deepEqual(events, ['mouseMoved'])
  },
)

test('snapshots folder and file rows through one path-parameterized browser expression', () => {
  for (const path of ['nested', 'notes/brief.md']) {
    const expectedSelector = `[role="treeitem"][aria-label=${JSON.stringify(path)}]`
    const calls = []
    const box = { x: 10, y: 20, width: 30, height: 12, right: 40, bottom: 32 }
    const action = {
      getBoundingClientRect: () => box,
      getAttribute: (name) => (name === 'aria-label' ? `Subscribe ${path}` : null),
      querySelector: () => ({ getAttribute: () => 'lucide-bell' }),
      matches: (selector) => selector === ':hover',
    }
    const name = {
      getBoundingClientRect: () => box,
      scrollWidth: 30,
      clientWidth: 30,
      matches: () => true,
    }
    const label = {
      getBoundingClientRect: () => box,
      matches: (selector) => selector === ':hover',
      querySelector: (selector) =>
        selector === ':scope > span > .truncate' || selector === '.truncate' ? name : action,
    }
    const row = {
      querySelector: (selector) => (selector === '[data-slot="tree-item-label"]' ? label : null),
      getBoundingClientRect: () => box,
    }
    const result = runInNewContext(rowSnapshotExpression(path), {
      document: {
        querySelector: (selector) => {
          calls.push(selector)
          return selector === expectedSelector ? row : null
        },
        querySelectorAll: () => [action],
        activeElement: row,
      },
      getComputedStyle: () => ({ opacity: '0', boxShadow: 'none' }),
    })
    assert.deepEqual(calls, [expectedSelector])
    assert.equal(result.path, path)
    assert.deepEqual(Object.keys(result.boxes), ['row', 'label', 'name', 'bell'])
    assert.deepEqual(JSON.parse(JSON.stringify(result.boxes.bell)), box)
    assert.equal(result.nameHover, true)
    assert.equal(result.bellHover, true)
    assert.equal(result.rowFocused, true)
    assert.equal(result.nameTruncated, false)
  }
})

test('checks stable geometry across row interaction states', () => {
  const boxes = Object.fromEntries(
    ['row', 'label', 'name', 'bell'].map((part) => [
      part,
      Object.fromEntries(['x', 'y', 'width', 'height', 'right', 'bottom'].map((key) => [key, 10])),
    ]),
  )
  assert.doesNotThrow(() => assertStableRowBoxes({ boxes }, { boxes }, 'same row'))
  assert.throws(
    () =>
      assertStableRowBoxes(
        { boxes },
        { boxes: { ...boxes, name: { ...boxes.name, x: 11 } } },
        'shifted row',
      ),
    /name\.x shifted/,
  )
})

test('checks row-name hover is exclusive and does not hover the bell', () => {
  assert.doesNotThrow(() =>
    assertExclusiveRowHover({ nameHovered: true, bellHovered: false, otherActions: [] }, 'row'),
  )
  assert.throws(
    () =>
      assertExclusiveRowHover(
        { nameHovered: true, bellHovered: false, otherActions: [{ opacity: '1' }] },
        'row',
      ),
    /unrelated bells remain hidden/,
  )
})

test('encodes timestamped screencast frames into an evidence video', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holi-smoke-recording-test-'))
  const evidence = join(root, 'evidence')
  let invocation
  try {
    const frames = [
      { image: Buffer.from('frame 0'), timestamp: 1 },
      { image: Buffer.from('frame 1'), timestamp: 1.25 },
    ]
    await encodeScreencast(frames, {
      root,
      evidence,
      filename: 'interaction.webm',
      run: (...args) => {
        invocation = args
        return { status: 0, stderr: '' }
      },
    })
    const manifest = await readFile(join(root, 'interaction.webm-frames', 'frames.txt'), 'utf8')
    assert.match(manifest, /file '0\.png'\nduration 0\.25/)
    assert.match(manifest, /file '1\.png'\nduration 0\.1[0-9]*\nfile '1\.png'/)
    assert.equal(invocation[0], 'ffmpeg')
    assert.equal(invocation[1].at(-1), join(evidence, 'interaction.webm'))
    assert.equal(invocation[2].timeout, 30000)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects empty or untimestamped recordings before invoking the encoder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holi-smoke-recording-test-'))
  try {
    await assert.rejects(
      encodeScreencast([], { root, evidence: root, filename: 'empty.webm' }),
      /must capture real rendered frames/,
    )
    await assert.rejects(
      encodeScreencast([{ image: Buffer.from('frame'), timestamp: NaN }], {
        root,
        evidence: root,
        filename: 'invalid.webm',
        run: () => assert.fail('invalid frames must not be encoded'),
      }),
      /supplies frame timestamps/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
