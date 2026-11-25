#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = resolve(fileURLToPath(new URL('..', import.meta.url)))
const evidence = resolve(process.argv[2] ?? '')
const phase = process.argv[3] ?? 'pilot'
if (!process.argv[2] || !['pilot', 'compare'].includes(phase)) {
  console.error(
    'Usage: node run-window-effects-investigation.mjs <unique-evidence-dir> [pilot|compare]',
  )
  process.exit(2)
}
if (process.platform !== 'darwin') throw new Error('Window effects investigation requires macOS')
await mkdir(evidence, { recursive: false })
const id = randomUUID()
const protocol = {
  id,
  phase,
  status: 'implementation checkpoint; measurements are intentionally not started',
  pilot: { warmupSeconds: 30, sampleSeconds: 30 },
  compare: {
    pairs: ['AB', 'BA', 'AB', 'BA', 'AB'],
    warmupSeconds: 180,
    steadySeconds: 120,
    intervalSeconds: 1,
    activity: '30 seconds deterministic scroll/resize followed by 30 seconds recovery',
  },
  decision:
    'Require paired steady physical-footprint savings >=64 MiB and >=15%, consistent in >=4/5 pairs, without correctness/accessibility or CPU/GPU/WindowServer regression. Pilot never gives a final recommendation; freeze tolerances from native pilot noise before opaque comparisons.',
  safeguards: [
    'No production behavior, defaults, or settings are changed.',
    'Renderer build and disposable isolated profiles precede measurement.',
    'Capture process identities via Electron app metrics; system memory is not deduplicated.',
    'GPU vmmap and WindowServer observations are separate and outside timed sampling.',
    'Unavailable counters are recorded as unavailable, never zero; no privilege escalation.',
    'Only owned process handles/groups may be terminated; retain profiles if absence is unconfirmed.',
  ],
  limitation:
    'This early diagnostic checkpoint does not run the app, build native code, or collect measurements.',
}
await writeFile(resolve(evidence, 'protocol.json'), `${JSON.stringify(protocol, null, 2)}\n`)
await writeFile(
  resolve(evidence, 'manifest.json'),
  `${JSON.stringify({ id, phase, createdAt: new Date().toISOString(), evidenceDirectory: evidence, runtimeCreated: false, measurementsStarted: false }, null, 2)}\n`,
)
console.log(
  `Evidence protocol recorded (${phase}); no app or measurements started. Desktop scripts: ${desktop}`,
)
