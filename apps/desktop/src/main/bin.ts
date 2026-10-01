/**
 * Finding a command-line tool from a GUI app. A Dock-launched app does not
 * inherit a login shell's PATH, so `claude` or `pre-commit` installed under
 * `~/.local/bin` is not on `process.env.PATH`. Look there first, then in the
 * usual install directories.
 */
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where tools usually land; relative entries are under the home directory. */
const FALLBACK_BIN_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '.local/bin',
  '.bun/bin',
  '.volta/bin',
  '.npm-global/bin',
  'n/bin',
]

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The fallback directories, absolute. */
function fallbackDirs(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME ?? homedir()
  return FALLBACK_BIN_DIRS.map((dir) => (dir.startsWith('/') ? dir : join(home, dir)))
}

/** The executable `name` on PATH, else in a fallback directory, else null. */
export function resolveBin(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of [...(env.PATH ?? '').split(':'), ...fallbackDirs(env)]) {
    if (!dir) continue
    const candidate = join(dir, name)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

/** PATH with the fallback directories after it, for a tool that runs others
 *  (pre-commit's `language: system` hooks find their commands on it). */
export function toolPath(env: NodeJS.ProcessEnv = process.env): string {
  return [...(env.PATH ?? '').split(':').filter(Boolean), ...fallbackDirs(env)].join(':')
}
