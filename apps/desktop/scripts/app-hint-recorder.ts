import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WebContents } from 'electron'

/** Records only this owned renderer, serially, with one image in memory at a time. */
export function recordAppHintWindow(contents: WebContents, root: string) {
  const directory = join(root, 'app-hint-frames')
  mkdirSync(directory)
  const started = performance.now()
  const timestamps: number[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let failure: unknown
  let bytes = 0
  let dimensions: { width: number; height: number } | undefined
  const sample = async (): Promise<void> => {
    const before = performance.now()
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      assert(timestamps.length < 900 && before - started < 90_000, 'recording exceeded 90 seconds')
      const image = await Promise.race([
        contents.capturePage(),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error('owned frame capture timed out')), 3_000)
        }),
      ])
      assert(!image.isEmpty(), 'owned recording frame was empty')
      const size = image.getSize()
      dimensions ??= size
      assert.deepEqual(size, dimensions, 'owned recording dimensions changed')
      const png = image.toPNG()
      bytes += png.length
      assert(bytes <= 200 * 1024 * 1024, 'owned recording exceeded frame storage limit')
      writeFileSync(join(directory, `${String(timestamps.length).padStart(5, '0')}.png`), png)
      timestamps.push(performance.now() - started)
    } catch (error) {
      failure = error
    } finally {
      clearTimeout(deadline)
      if (!stopped && !failure)
        timer = setTimeout(
          () => {
            pending = sample()
          },
          Math.max(0, 100 - (performance.now() - before)),
        )
    }
  }
  let pending = sample()
  return {
    async stop() {
      stopped = true
      clearTimeout(timer)
      await pending
      if (failure) throw failure
      assert(timestamps.length >= 2, 'owned recording produced too few frames')
      const elapsedMs = performance.now() - started
      // Use each actual capture time, not an assumed frame rate or a stills slideshow.
      // The first image covers only the initial capture latency; the final repeat
      // lets the concat demuxer honor the last real frame's measured duration.
      const starts = [0, ...timestamps.slice(1)]
      const manifest = timestamps.flatMap((_, index) => [
        `file '${String(index).padStart(5, '0')}.png'`,
        `duration ${((index + 1 < starts.length ? starts[index + 1]! : elapsedMs) - starts[index]!) / 1000}`,
      ])
      manifest.push(`file '${String(timestamps.length - 1).padStart(5, '0')}.png'`)
      writeFileSync(
        join(directory, 'frames.ffconcat'),
        `ffconcat version 1.0\n${manifest.join('\n')}\n`,
      )
      return {
        capture: 'owned AppFrame BrowserWindow.webContents.capturePage',
        frames: timestamps.length,
        elapsedMs,
        timestampsMs: timestamps,
        dimensions,
        frameBytes: bytes,
      }
    },
  }
}
