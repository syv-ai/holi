import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform === 'darwin' || process.platform === 'linux') {
  const source = fileURLToPath(new URL('../src/main/native/posix-lease.c', import.meta.url))
  const output = fileURLToPath(new URL('../build/native/', import.meta.url))
  mkdirSync(output, { recursive: true })
  const staging = mkdtempSync(join(output, '.build-'))
  try {
    const binary = join(staging, 'holi-posix-lease')
    execFileSync(
      process.env.CC || 'cc',
      ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', source, '-o', binary],
      {
        stdio: 'inherit',
        timeout: 30_000,
      },
    )
    renameSync(binary, join(output, 'holi-posix-lease'))
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}
