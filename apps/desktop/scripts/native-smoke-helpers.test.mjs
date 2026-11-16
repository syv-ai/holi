import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeScreencast } from './native-smoke-recording.mjs'
import { assertExclusiveRowHover, assertStableRowBoxes } from './native-smoke-row-assertions.mjs'

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
