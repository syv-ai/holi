import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import test from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
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
  const rejected = assert.rejects(pending, (error) => error === reason)
  await nextTurn()
  controller.abort(reason)
  await rejected
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

function heldAcknowledgement() {
  let acknowledge
  const pending = new Promise((resolve) => {
    acknowledge = resolve
  })
  return { pending, acknowledge }
}

function pointerPage(afterInput = () => {}) {
  const events = []
  return {
    events,
    page: {
      call: async (method, event) => {
        assert.equal(method, 'Input.dispatchMouseEvent')
        events.push(event)
        await afterInput(event)
      },
    },
  }
}

test(
  'native mdx cancellation stops the click without waiting for pending pointer movement',
  { timeout: 5000 },
  async () => {
    const controller = new AbortController()
    const { clickPointerAt } = createMdxSmokeUi(controller.signal)
    const movement = heldAcknowledgement()
    const { page, events } = pointerPage(() => movement.pending)
    const point = { x: 10, y: 20 }
    const clicking = clickPointerAt(page, point, () => point)
    const reason = new Error('fixture interrupted')
    const rejected = assert.rejects(clicking, (error) => error === reason)
    await nextTurn()
    controller.abort(reason)
    await rejected
    movement.acknowledge()
    await nextTurn()
    assert.deepEqual(events, [{ type: 'mouseMoved', ...point }])
  },
)

test(
  'native mdx pointer deadline rejects before a stalled acknowledgement returns',
  { timeout: 5000 },
  async () => {
    const { clickPointerAt } = createMdxSmokeUi(new AbortController().signal)
    const movement = heldAcknowledgement()
    const { page, events } = pointerPage(() => movement.pending)
    const point = { x: 10, y: 20 }
    await assert.rejects(
      clickPointerAt(page, point, () => point, performance.now() + 100),
      /Timed out/,
    )
    movement.acknowledge()
    await nextTurn()
    assert.deepEqual(events, [{ type: 'mouseMoved', ...point }])
  },
)

test('native mdx click presses only if movement leaves the same target under the pointer', async () => {
  const { clickPointerAt } = createMdxSmokeUi(new AbortController().signal)
  const point = { x: 10, y: 20 }
  for (const replaceOnMove of [false, true]) {
    let covered = false
    const { page, events } = pointerPage(({ type }) => {
      if (type === 'mouseMoved') covered = replaceOnMove
    })
    const click = clickPointerAt(page, point, ({ x, y }) =>
      !covered && x === point.x && y === point.y ? point : null,
    )
    const moved = { type: 'mouseMoved', ...point }
    if (replaceOnMove) {
      await assert.rejects(click)
      assert.deepEqual(events, [moved])
    } else {
      await click
      const leftClick = { ...point, button: 'left', clickCount: 1 }
      assert.deepEqual(events, [
        moved,
        { type: 'mousePressed', ...leftClick },
        { type: 'mouseReleased', ...leftClick },
      ])
    }
  }
})

for (const held of ['editor focus', 'shortcut keydown']) {
  test(
    `native mdx Find sends no further keys after a late ${held} acknowledgement`,
    { timeout: 5000 },
    async () => {
      const { findInFile } = createMdxSmokeUi(new AbortController().signal)
      const ack = heldAcknowledgement()
      const nativeKeys = []
      const editor = {
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 20, height: 40 }),
        contains: (element) => element === editor,
        matches: (selector) => selector === '.cm-content',
      }
      const document = {
        querySelector: (selector) => (selector === '.cm-content' ? editor : null),
        elementFromPoint: (x, y) => (x === 10 && y === 20 ? editor : null),
        hasFocus: () => document.activeElement !== null,
        activeElement: null,
      }
      let waitingForAcknowledgement = false
      const { page: pointer } = pointerPage(({ type }) => {
        if (type === 'mouseReleased') document.activeElement = editor
      })
      const page = {
        evaluate: async (expression) => {
          const result = runInNewContext(expression, { document })
          if (held === 'editor focus' && document.activeElement === editor) {
            waitingForAcknowledgement = true
            await ack.pending
          }
          return result
        },
        call: async (method, event) => {
          if (method === 'Input.dispatchMouseEvent') return pointer.call(method, event)
          nativeKeys.push({ method, ...event })
          if (
            held === 'shortcut keydown' &&
            method === 'Input.dispatchKeyEvent' &&
            event.type === 'keyDown'
          ) {
            waitingForAcknowledgement = true
            await ack.pending
          }
        },
      }
      await assert.rejects(findInFile(page, 'fixture', performance.now() + 250), /Timed out/)
      assert(waitingForAcknowledgement, `Find did not reach ${held}`)
      ack.acknowledge()
      await nextTurn()
      assert.deepEqual(
        nativeKeys,
        held === 'shortcut keydown'
          ? [
              {
                method: 'Input.dispatchKeyEvent',
                type: 'keyDown',
                key: 'f',
                code: 'KeyF',
                windowsVirtualKeyCode: 70,
                modifiers: process.platform === 'darwin' ? 4 : 2,
              },
            ]
          : [],
      )
    },
  )
}

test('native mdx stage operations share one absolute deadline', { timeout: 5000 }, async () => {
  const { untilDeadline } = createMdxSmokeUi(new AbortController().signal)
  const deadline = performance.now() + 100
  const recording = heldAcknowledgement()
  let started = false
  await assert.rejects(
    untilDeadline(() => {
      started = true
      return recording.pending
    }, deadline),
    /Timed out/,
  )
  assert(started)
  await assert.rejects(
    untilDeadline(() => assert.fail('no observation after expiry'), deadline),
    /Timed out/,
  )
})

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
