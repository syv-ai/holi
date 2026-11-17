import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export function createNativeProofRecorder({ evaluate, captureScreenshot, frames, startedAt }) {
  const recordFrame = async (stage, expectedTarget) => {
    const hostState = await evaluate(
      `(()=>{const overlay=document.querySelector("[data-host-hints]");if(!overlay)return null;const labels=[...overlay.querySelectorAll("[data-hint-key]")].map(e=>({key:e.getAttribute("data-hint-key"),target:e.getAttribute("data-hint-target"),visible:!!(e.getClientRects().length&&getComputedStyle(e).visibility!=="hidden")}));return {visible:!!(overlay.getClientRects().length&&getComputedStyle(overlay).visibility!=="hidden"),labels}})()`,
    )
    const guestState = await evaluate(
      `(()=>{const target=[...document.querySelectorAll("button")].find(e=>e.textContent.trim()===${JSON.stringify(expectedTarget)});return target?{text:target.textContent.trim(),visible:!!(target.getClientRects().length&&getComputedStyle(target).visibility!=="hidden")}:null})()`,
      true,
    )
    assert(hostState?.visible, `${stage}: host hint overlay is not visible`)
    assert(
      hostState.labels.some((label) => label.target === expectedTarget && label.visible),
      `${stage}: host label missing`,
    )
    assert(
      guestState?.visible && guestState.text === expectedTarget,
      `${stage}: guest target is not visible`,
    )
    const frame = await captureScreenshot()
    const capturedAt = process.hrtime.bigint()
    const afterHost = await evaluate('!!document.querySelector("[data-host-hints]")')
    const afterGuest = await evaluate(
      `(()=>{const e=[...document.querySelectorAll("button")].find(x=>x.textContent.trim()===${JSON.stringify(expectedTarget)});return !!(e&&e.getClientRects().length&&getComputedStyle(e).visibility!=="hidden")})()`,
      true,
    )
    assert(afterHost && afterGuest, `${stage}: labels invalidated during capture`)
    const image = Buffer.from(frame.data, 'base64')
    frames.push({
      image,
      timestamp: Number(capturedAt - startedAt) / 1e9,
      stage,
      labels: hostState.labels,
      guestTarget: guestState.text,
    })
    return image
  }
  const recordUnassertedFrame = async (stage) => {
    const frame = await captureScreenshot()
    frames.push({
      image: Buffer.from(frame.data, 'base64'),
      timestamp: Number(process.hrtime.bigint() - startedAt) / 1e9,
      stage,
    })
  }
  return { recordFrame, recordUnassertedFrame }
}

export async function finalizeScreencast(frames, { root, evidence, filename }) {
  await encodeScreencast(frames, { root, evidence, filename })
  const stat = await import('node:fs/promises').then(({ stat }) => stat(join(evidence, filename)))
  assert(stat.size > 0, `${filename} video is empty`)
  const probe = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      join(evidence, filename),
    ],
    { encoding: 'utf8' },
  )
  assert.equal(probe.status, 0, `${filename} probe failed: ${probe.stderr}`)
  assert(Number(probe.stdout) >= 2.5, `${filename} is too short: ${probe.stdout.trim()}s`)
  return Number(probe.stdout)
}

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
