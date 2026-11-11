/**
 * Silero VAD v5 (MIT, `assets/silero-vad.onnx`, the model the syv.ai backend
 * runs) on onnxruntime-web's WebAssembly build (MIT): no native addon. The
 * model loads once, at the first chunk, and is reused; runs take turns, since
 * one session serves every chunk. A 12 s channel takes tens of milliseconds.
 *
 * Main's build keeps dependencies external, so the runtime's wasm and its
 * loader are read out of `node_modules` in dev and in a built app alike; a
 * built app unpacks them from the asar archive (`electron-builder.yml`), as
 * the loader is imported by path.
 *
 * When the model cannot load or run, `speech` answers null, the chunk goes up
 * whole (`vad.ts`), and the log says so once.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type * as Ort from 'onnxruntime-web'
import { VAD_WINDOW, type ChunkVad } from './vad'

/** Each step sees the last 64 samples of the one before. */
const CONTEXT = 64

/** The bytes of a `data:` URL, as Vite inlines an asset. */
export function dataUrlBytes(url: string): Uint8Array {
  return new Uint8Array(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'))
}

interface Loaded {
  ort: typeof Ort
  session: Ort.InferenceSession
}

async function load(model: Uint8Array): Promise<Loaded> {
  const ort = await import('onnxruntime-web')
  // The plain wasm build, from beside the runtime's entry, out of the asar
  // archive in a built app.
  const dist = dirname(createRequire(__filename).resolve('onnxruntime-web')).replace(
    /([\\/])app\.asar([\\/])/,
    '$1app.asar.unpacked$2',
  )
  ort.env.logLevel = 'error'
  ort.env.wasm.numThreads = 1
  ort.env.wasm.wasmPaths = { mjs: pathToFileURL(join(dist, 'ort-wasm-simd-threaded.mjs')).href }
  ort.env.wasm.wasmBinary = new Uint8Array(
    await readFile(join(dist, 'ort-wasm-simd-threaded.wasm')),
  )
  const session = await ort.InferenceSession.create(model, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  })
  return { ort, session }
}

async function probabilities(
  { ort, session }: Loaded,
  samples: Float32Array,
): Promise<Float32Array> {
  const steps = Math.ceil(samples.length / VAD_WINDOW)
  const probs = new Float32Array(steps)
  const sr = new ort.Tensor('int64', BigInt64Array.from([16_000n]), [])
  let state: Ort.Tensor = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128])
  const x = new Float32Array(CONTEXT + VAD_WINDOW)
  for (let i = 0; i < steps; i++) {
    x.copyWithin(0, VAD_WINDOW, CONTEXT + VAD_WINDOW)
    x.fill(0, CONTEXT)
    x.set(samples.subarray(i * VAD_WINDOW, (i + 1) * VAD_WINDOW), CONTEXT)
    const out = await session.run({
      input: new ort.Tensor('float32', x, [1, CONTEXT + VAD_WINDOW]),
      state,
      sr,
    })
    probs[i] = (out['output']!.data as Float32Array)[0]!
    state = out['stateN']!
  }
  return probs
}

export function createSileroVad(opts: {
  /** The model's bytes. */
  model: () => Uint8Array | Promise<Uint8Array>
  log(level: 'warn', message: string): void
}): ChunkVad {
  let loading: Promise<Loaded> | null = null
  let turn: Promise<unknown> = Promise.resolve()
  let warned = false
  const warn = (what: string, err: unknown) => {
    if (warned) return
    warned = true
    opts.log('warn', `meeting: voice detection ${what}, chunks go up whole: ${String(err)}`)
  }
  return {
    speech(samples) {
      if (loading === null) {
        loading = (async () => load(await opts.model()))()
        loading.catch(() => {})
      }
      const run = turn.then(async () => {
        let loaded: Loaded
        try {
          loaded = await loading!
        } catch (err) {
          // Not loaded once is not loaded: the meeting goes on without it.
          warn('could not load', err)
          return null
        }
        try {
          return await probabilities(loaded, samples)
        } catch (err) {
          warn('failed', err)
          return null
        }
      })
      turn = run
      return run
    },
  }
}
