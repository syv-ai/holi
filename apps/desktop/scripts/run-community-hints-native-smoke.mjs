import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidence = resolve(process.argv.find((arg) => arg !== '--' && !arg.endsWith('.mjs')) ?? '/tmp/holi-510/native')
await mkdir(evidence, { recursive: true })
assert.deepEqual(await readdir(evidence), [], `refusing to overwrite existing evidence: ${evidence}`)
const root = await mkdtemp(join(tmpdir(), 'holi-510-native-'))
try {
  const build = spawnSync('pnpm', ['exec', 'vite', 'build', '--config', 'vite.config.ts'], {
    cwd: desktop, encoding: 'utf8',
  })
  if (build.status !== 0) throw new Error(`Vite build failed: ${build.stderr}`)
  const gap = {
    ok: false,
    issue: 510,
    harness: 'community-host-hints-native',
    failure: 'Native scenario driver is incomplete; no behavioral result is claimed.',
    coverageGaps: [
      'Trusted CDP scenario execution, interaction evidence, attack rejection checks, and supervisor/process cleanup verification are not implemented yet.',
      'The temporary build currently invokes the app Vite build rather than compiling the isolated smoke entries; this is a prerequisite gap, not a passing smoke run.',
    ],
    isolatedTemporaryRoot: root,
  }
  await writeFile(join(evidence, 'result.json'), JSON.stringify(gap, null, 2))
  throw new Error(`Issue #510 community native smoke cannot claim proof: ${gap.coverageGaps.join(' ')}`)
} finally {
  await rm(root, { recursive: true, force: true })
}
