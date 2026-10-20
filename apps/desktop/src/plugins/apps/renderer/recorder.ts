/**
 * Recording for a vault app (`holi.record`), done here in the renderer.
 *
 * An app's frame cannot record for itself: its origin is opaque, and Chromium
 * refuses media capture to an opaque origin whatever the frame's permissions
 * policy says ("MSM: Renderer requested a URL it's not allowed to use: null").
 * So the app asks and this records, in Holi's own document, and hands back the
 * finished audio as a `Blob`, which crosses `postMessage` as it is. Only for an
 * app granted `recording` (`AppFrame` checks before calling).
 *
 * The microphone and the system's sound (a share of the main screen, whose
 * audio main answers as `loopback`) are mixed into one track. The share's
 * video is never recorded.
 */

export interface RecordOptions {
  /** The microphone. Default true. */
  microphone?: boolean
  /** The computer's sound: the meeting, whatever app plays it. Default true. */
  system?: boolean
}

export interface Recording {
  /** How loud the mix is right now, 0..1 (RMS of the live signal). */
  level(): number
  /** The mix's spectrum now: `bands` values 0..1, lowest pitch first. */
  spectrum(bands: number): number[]
  /** The audio so far, and every capture let go. */
  stop(): Promise<Blob>
  /** Let every capture go, keeping nothing (the app went away). */
  discard(): void
}

/** Why the computer's sound could not be had, almost always: the system has
 *  not let Holi record the screen. Said in words the person can act on. */
const NO_SCREEN =
  'Holi may not record the computer’s sound. On a Mac, allow Holi (shown as Electron in ' +
  'development) under System Settings › Privacy & Security › Screen & System Audio ' +
  'Recording, then restart Holi'

function optionsOf(params: unknown): Required<RecordOptions> {
  const raw = params !== null && typeof params === 'object' ? (params as RecordOptions) : {}
  return { microphone: raw.microphone !== false, system: raw.system !== false }
}

/** The first type this machine's `MediaRecorder` can write. */
function recordingType(): string | undefined {
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) =>
    MediaRecorder.isTypeSupported(t),
  )
}

export async function startRecording(params: unknown): Promise<Recording> {
  const { microphone, system } = optionsOf(params)
  if (!microphone && !system) throw new Error('record.start needs microphone or system')
  const streams: MediaStream[] = []
  const context = new AudioContext()
  const release = (): void => {
    for (const s of streams) for (const t of s.getTracks()) t.stop()
    void context.close().catch(() => {})
  }
  try {
    const mix = context.createMediaStreamDestination()
    // Every source goes through one bus, which feeds the recording and a
    // meter. The meter is a tap: it is not connected onward, so it adds no sound.
    const bus = context.createGain()
    const meter = context.createAnalyser()
    meter.fftSize = 1024
    meter.smoothingTimeConstant = 0.6
    bus.connect(mix)
    bus.connect(meter)
    const samples = new Float32Array(meter.fftSize)
    const bins = new Uint8Array(meter.frequencyBinCount)
    if (system) {
      const share = await navigator.mediaDevices
        .getDisplayMedia({ video: true, audio: true })
        .catch((err: unknown) => {
          throw new Error(`${NO_SCREEN} (${err instanceof Error ? err.message : String(err)})`)
        })
      streams.push(share)
      if (share.getAudioTracks().length === 0) throw new Error('no system audio was shared')
      context.createMediaStreamSource(new MediaStream(share.getAudioTracks())).connect(bus)
    }
    if (microphone) {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      })
      streams.push(mic)
      context.createMediaStreamSource(mic).connect(bus)
    }
    const type = recordingType()
    const recorder = new MediaRecorder(mix.stream, type === undefined ? {} : { mimeType: type })
    const chunks: Blob[] = []
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    }
    recorder.start(1000)
    return {
      level() {
        meter.getFloatTimeDomainData(samples)
        let sum = 0
        for (const v of samples) sum += v * v
        // Speech sits around -30 dB RMS; scale so it fills most of the range.
        return Math.min(1, Math.sqrt(sum / samples.length) * 6)
      },
      spectrum(bands) {
        meter.getByteFrequencyData(bins)
        // Speech lives between about 80 Hz and 5 kHz: spread that range over
        // the bands on a log scale, so low and high voices both move bars.
        const hz = context.sampleRate / meter.fftSize
        const lo = Math.max(1, Math.floor(80 / hz))
        const hi = Math.min(bins.length - 1, Math.floor(5000 / hz))
        const out: number[] = []
        for (let b = 0; b < bands; b++) {
          const from = Math.floor(lo * Math.pow(hi / lo, b / bands))
          const to = Math.max(from + 1, Math.floor(lo * Math.pow(hi / lo, (b + 1) / bands)))
          let peak = 0
          for (let i = from; i < to; i++) peak = Math.max(peak, bins[i]!)
          out.push(peak / 255)
        }
        return out
      },
      async stop() {
        const stopped = new Promise<void>((done) => (recorder.onstop = () => done()))
        if (recorder.state !== 'inactive') recorder.stop()
        await stopped
        release()
        return new Blob(chunks, { type: recorder.mimeType || type || 'audio/webm' })
      },
      discard() {
        if (recorder.state !== 'inactive') recorder.stop()
        release()
      },
    }
  } catch (err) {
    release()
    throw err
  }
}
