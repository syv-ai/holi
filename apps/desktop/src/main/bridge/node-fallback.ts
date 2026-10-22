/**
 * Holi's last-resort `node`.
 *
 * Every hook Holi seeds into a vault is `node "<script>"`, run by `/bin/sh`
 * with the environment Holi gave `claude`. An app opened from the Dock or
 * Finder has launchd's PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), which has no
 * `node` on it: macOS ships none. Without one every hook exits 127, which
 * Claude Code treats as non-blocking, so the turn signals, the focus context
 * and the Google send gate all quietly stop running.
 *
 * So the running app's own executable, which is Node when asked
 * (`ELECTRON_RUN_AS_NODE`), is offered as `node`, in a directory the agent's
 * PATH ends with. A `node` the machine has comes first and wins.
 */
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nodeFallbackDir } from '../bin'

/** `text` as one shell word. */
const quote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`

function script(execPath: string): string {
  return `#!/bin/sh
# Holi's last-resort node: the app's own executable, run as Node. Used only
# when no other node is on PATH ahead of this directory.
exec env ELECTRON_RUN_AS_NODE=1 ${quote(execPath)} "$@"
`
}

/**
 * Write the shim and make it executable; answers its directory.
 *
 * Rewritten on every launch rather than written once: the app may have moved
 * or been updated since, and a stale path would be a `node` that does not run.
 */
export async function installNodeFallback(userDataDir: string, execPath: string): Promise<string> {
  const dir = nodeFallbackDir(join(userDataDir, 'bin'))
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'node')
  await writeFile(path, script(execPath), { mode: 0o755 })
  // `writeFile`'s mode is ignored when the file already exists.
  await chmod(path, 0o755)
  return dir
}
