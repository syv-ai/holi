import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const evidence = resolve(process.argv.find((arg) => arg !== '--' && !arg.endsWith('.mjs')) ?? '/tmp/holi-510/native')
await mkdir(evidence, { recursive: true })
assert.deepEqual(await readdir(evidence), [], `refusing to overwrite existing evidence: ${evidence}`)
const root = await mkdtemp(join(tmpdir(), 'holi-510-native-'))
try {
  const gap = {
    ok: false,
    issue: 510,
    harness: 'community-host-hints-native',
    failure: 'Native scenario driver is incomplete; no behavioral result is claimed.',
    coverageGaps: [
      'Trusted CDP scenario execution, interaction evidence, attack rejection checks, and supervisor/process cleanup verification are not implemented yet.',
      'The isolated smoke entries are not bundled or launched by this runner.',
    ],
    isolatedTemporaryRoot: root,
  }
  await writeFile(join(evidence, 'result.json'), JSON.stringify(gap, null, 2))
  throw new Error(`Issue #510 community native smoke cannot claim proof: ${gap.coverageGaps.join(' ')}`)
} finally {
  await rm(root, { recursive: true, force: true })
}
