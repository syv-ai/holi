/**
 * Captures a meeting in the renderer as stereo chunks for the transcribe
 * plugin's main side: the microphone on the left, the computer's sound on the
 * right (a silent channel when one is off), 16 kHz, each chunk a 16-bit WAV
 * cut at a pause (`chunker.ts`). Main mixes it down for speech recognition and
 * tells Me from Them by which side is louder.
 *
 * The computer's sound is a share of the main screen whose audio main answers
 * as `loopback` (`setDisplayMediaRequestHandler` in main's `index.ts`); the
 * share's video is never used. If the system refuses it, capture goes on with the microphone,
 * and the other way round; only when neither can be had does it fail. A source
 * that ends midway (a headset unplugged) leaves its side silent and the rest
 * running.
 *
 * Raw samples come from an AudioWorklet (`pcm-tap.ts`); resampling, cutting
 * and encoding happen here, a block at a time, and a chunk's memory is let go
 * once it has been handed on, so a long meeting does not grow the page.
 */

import type { Capture, CaptureOptions } from '../../shared/meeting'
import { Chunker, type ClosedChunk } from './chunker'
import { PCM_TAP, PCM_TAP_SOURCE, type TapMessage } from './pcm-tap'
import { Resampler } from './resampler'
import { loudness } from './rms'
import { encodeWav } from './wav'

const RATE = 16_000
/** Frames (20 ms each) per level report: about 25 a second. */
const LEVEL_FRAMES = 2
/** How long `stop` waits for the worklet's last samples. */
const FLUSH_WAIT_MS = 500

/** Why the computer's sound could not be had, almost always, in words the person can act on. */
const NO_SCREEN =
  'Holi may not record the computer’s sound. On a Mac, allow Holi under System Settings › ' +
  'Privacy & Security › Screen & System Audio Recording, then restart Holi'

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop()
}

async function systemAudio(): Promise<MediaStream> {
  const share = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
  if (share.getAudioTracks().length === 0) {
    stopTracks(share)
    throw new Error('no system audio was shared')
  }
  // The video is only the ticket to the audio: ask it to idle.
  for (const track of share.getVideoTracks()) {
    void track.applyConstraints({ frameRate: 1 }).catch(() => {})
  }
  return share
}

function microphone(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
  })
}

export async function startCapture(options: CaptureOptions): Promise<Capture> {
  if (!options.microphone && !options.system) {
    throw new Error('capture needs the microphone or the computer’s sound')
  }
  const streams: MediaStream[] = []
  const context = new AudioContext()
  const release = (): void => {
    for (const stream of streams) stopTracks(stream)
    void context.close().catch(() => {})
  }
  try {
    const problems: string[] = []
    let system: MediaStream | undefined
    let mic: MediaStream | undefined
    if (options.system) {
      system = await systemAudio().catch((err: unknown) => {
        problems.push(`${NO_SCREEN} (${message(err)})`)
        return undefined
      })
      if (system) streams.push(system)
    }
    if (options.microphone) {
      mic = await microphone().catch((err: unknown) => {
        problems.push(`The microphone could not be used (${message(err)})`)
        return undefined
      })
      if (mic) streams.push(mic)
    }
    if (!system && !mic) throw new Error(problems.join('. '))

    const url = URL.createObjectURL(new Blob([PCM_TAP_SOURCE], { type: 'text/javascript' }))
    try {
      await context.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }
    // Each merger input is one channel: left the mic, right the computer.
    const merger = context.createChannelMerger(2)
    if (mic) context.createMediaStreamSource(mic).connect(merger, 0, 0)
    if (system) {
      const audio = new MediaStream(system.getAudioTracks())
      context.createMediaStreamSource(audio).connect(merger, 0, 1)
    }
    const tap = new AudioWorkletNode(context, PCM_TAP, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'discrete',
    })
    merger.connect(tap)
    // The tap outputs silence; reaching the destination keeps the graph pulling it.
    tap.connect(context.destination)

    const left = new Resampler(context.sampleRate, RATE)
    const right = new Resampler(context.sampleRate, RATE)
    let loudest = 0
    let framesSinceLevel = 0
    const chunker = new Chunker({
      sampleRate: RATE,
      minChunk: options.minChunk,
      maxChunk: options.maxChunk,
      onFrame: (level) => {
        loudest = Math.max(loudest, level)
        if (++framesSinceLevel < LEVEL_FRAMES) return
        options.onLevel?.(loudness(loudest))
        loudest = 0
        framesSinceLevel = 0
      },
    })
    const emit = (chunk: ClosedChunk): void => {
      options.onChunk({
        n: chunk.n,
        start: chunk.start,
        duration: chunk.duration,
        wav: encodeWav([chunk.left, chunk.right], RATE),
      })
    }
    const take = (l: Float32Array, r: Float32Array): void => {
      for (const chunk of chunker.push(l, r)) emit(chunk)
    }

    let flushed: (() => void) | undefined
    tap.port.onmessage = (event: MessageEvent<TapMessage>) => {
      if (event.data === 'flushed') flushed?.()
      else take(left.push(event.data.left), right.push(event.data.right))
    }
    await context.resume().catch(() => {})

    let stopping: Promise<void> | undefined
    return {
      sources: { microphone: mic !== undefined, system: system !== undefined },
      problems,
      stop() {
        stopping ??= (async () => {
          // The worklet's last block, then its 'flushed' (messages arrive in order).
          await new Promise<void>((done) => {
            flushed = done
            setTimeout(done, FLUSH_WAIT_MS)
            tap.port.postMessage('flush')
          })
          tap.port.onmessage = null
          merger.disconnect()
          tap.disconnect()
          release()
          take(left.flush(), right.flush())
          const last = chunker.flush()
          if (last) emit(last)
        })()
        return stopping
      },
    }
  } catch (err) {
    release()
    throw err
  }
}
