import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidence = resolve(process.argv[2] ?? join(process.cwd(), 'agent-inbox-550-evidence'))
const root = await mkdtemp(join(tmpdir(), 'holi-550-'))
const nonce = randomUUID()
await mkdir(evidence, { recursive: true })
try {
  const build = spawnSync('pnpm', ['exec', 'electron-vite', 'build'], {
    cwd: desktop,
    stdio: 'inherit',
    env: { PATH: process.env.PATH },
  })
  if (build.status !== 0) throw new Error('Production Electron build failed')
  await writeFile(
    join(evidence, 'bootstrap.json'),
    JSON.stringify(
      {
        root,
        nonce,
        status: 'built-production-bootstrap',
        limitation:
          'Actual inbox navigation has not been implemented or verified by this bootstrap slice.',
      },
      null,
      2,
    ),
  )
  console.log(
    `Production build completed. Bootstrap artifacts/evidence: ${evidence}; isolated root: ${root}`,
  )
} finally {
  // Preserve the isolated root for inspection; callers may remove this disposable directory.
}
