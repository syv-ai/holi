import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/** The typst version Holi targets. Templates are authored against it, and the
 * download-on-first-use path (see ensureTypst) pins to it. */
export const TYPST_VERSION = '0.14.1'

export interface ResolveTypstOpts {
  /** Where a downloaded binary is cached (userData/typst). Omitted in tests that
   *  only exercise the PATH branch; wired up in the download task. */
  cacheDir?: string
}

/**
 * Absolute path to a usable typst binary, or null. Resolution order:
 *   1. `TYPST_BIN` env override (tests, power users, the agent front door).
 *   2. a cached download under `cacheDir` (added in the download-on-first-use task).
 *   3. `PATH` (dev — `which typst`).
 * This finds an EXISTING binary only; `ensureTypst` adds the download.
 */
export async function resolveTypstBin(_opts: ResolveTypstOpts = {}): Promise<string | null> {
  const override = process.env.TYPST_BIN
  if (override) return override
  return onPath()
}

/** `typst` on `PATH`, or null. `which` on unix, `where` on Windows. */
export async function onPath(): Promise<string | null> {
  const cmd = process.platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await exec(cmd, ['typst'])
    const first = stdout.split(/\r?\n/).find((l) => l.trim() !== '')
    return first?.trim() ?? null
  } catch {
    return null
  }
}
