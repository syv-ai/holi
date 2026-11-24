import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidence = resolve(process.argv[2] ?? join(process.cwd(), 'agent-inbox-550-evidence'))
const root = await mkdtemp(join(tmpdir(), 'holi-550-'))
const nonce = randomUUID()
try {
  try {
    await lstat(evidence)
    throw new Error(`Evidence path already exists; refusing to overwrite: ${evidence}`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await mkdir(evidence, { recursive: false, mode: 0o700 })
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
  await rm(root, { recursive: true, force: true })
}
