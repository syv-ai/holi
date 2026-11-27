import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { selectScenarios } from './browser-placement-bench-scenarios.mjs'

export function parseBenchmarkOptions(args, platform = process.platform) {
  if (platform === 'win32') throw new Error('Windows process-tree drainage is unsupported')
  const values = new Map()
  const options = new Set([
    '--focus',
    '--out',
    '--seconds',
    '--warmup',
    '--repetitions',
    '--variant',
    '--scenario',
    '--counts',
  ])
  for (let index = 0; index < args.length; index++) {
    const key = args[index]
    if (!options.has(key) || values.has(key)) throw new Error(`invalid benchmark option: ${key}`)
    if (key === '--counts') values.set(key, true)
    else {
      const value = args[++index]
      if (!value || value.startsWith('--')) throw new Error(`missing benchmark value: ${key}`)
      values.set(key, value)
    }
  }
  if (values.get('--focus') !== 'foreground') throw new Error('--focus foreground is required')
  const variant = values.get('--variant') ?? 'baseline'
  if (variant !== 'baseline') throw new Error('only baseline is supported; hybrid is rejected')
  const seconds = Number(values.get('--seconds') ?? 60)
  const warmup = Number(values.get('--warmup') ?? 20)
  const repetitions = Number(values.get('--repetitions') ?? 3)
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 3600)
    throw new Error('--seconds must be 1..3600')
  if (!Number.isFinite(warmup) || warmup < 0 || warmup > 600)
    throw new Error('--warmup must be 0..600')
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20)
    throw new Error('--repetitions must be 1..20')
  const scenario = values.get('--scenario') ?? ''
  selectScenarios(scenario)
  return {
    out: resolve(
      values.get('--out') ?? join(tmpdir(), `holi-547-evidence-${Date.now()}-${process.pid}`),
    ),
    seconds,
    warmup,
    repetitions,
    scenario,
    variant,
    countsOnly: values.has('--counts'),
    focus: 'foreground',
  }
}
