import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function encodeScreencast(frames, { root, evidence, filename, run = spawnSync }) {
  assert(frames.length > 0, 'native screencast must capture real rendered frames')
  const frameRoot = join(root, filename + '-frames')
  await mkdir(frameRoot)
  const manifest = []
  await Promise.all(
    frames.map((frame, index) => writeFile(join(frameRoot, `${index}.png`), frame.image)),
  )
  for (const [index, frame] of frames.entries()) {
    assert(Number.isFinite(frame.timestamp), 'native screencast supplies frame timestamps')
    manifest.push(`file '${index}.png'`)
    // CDP emits only changed frames; keep elapsed interaction time.
    manifest.push(
      `duration ${Math.max(0.001, (frames[index + 1]?.timestamp ?? frame.timestamp + 0.1) - frame.timestamp)}`,
    )
  }
  manifest.push(`file '${frames.length - 1}.png'`)
  const manifestPath = join(frameRoot, 'frames.txt')
  await writeFile(manifestPath, manifest.join('\n') + '\n')
  const encoded = run(
    'ffmpeg',
    [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      manifestPath,
      '-an',
      '-c:v',
      'libvpx-vp9',
      '-deadline',
      'realtime',
      '-cpu-used',
      '8',
      '-threads',
      '2',
      '-fps_mode',
      'vfr',
      '-pix_fmt',
      'yuv420p',
      join(evidence, filename),
    ],
    { encoding: 'utf8', timeout: 30000 },
  )
  assert.equal(encoded.status, 0, `${filename} encode failed: ${encoded.stderr}`)
}
