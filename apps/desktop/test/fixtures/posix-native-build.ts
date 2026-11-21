import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function buildPosixTestHelper(directory: string, url: URL) {
  execFileSync('/usr/bin/cc', ['--version'], { timeout: 2000, stdio: 'ignore' })
  const binary = join(directory, url.pathname.split('/').at(-1)!.replace(/\.c$/, ''))
  execFileSync(
    '/usr/bin/cc',
    ['-std=c11', '-Wall', '-Wextra', '-Werror', fileURLToPath(url), '-o', binary],
    {
      cwd: directory,
      timeout: 10_000,
      stdio: 'pipe',
    },
  )
  return binary
}

export function buildLeaseForTests() {
  const directory = mkdtempSync(join(tmpdir(), 'holi-native-build-'))
  try {
    return {
      directory,
      binary: buildPosixTestHelper(
        directory,
        new URL('../../src/main/native/posix-lease.c', import.meta.url),
      ),
    }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}
