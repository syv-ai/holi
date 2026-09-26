/**
 * What the pre-commit transforms did, in a file the agent can read.
 *
 * A transform that rewrites files silently is indistinguishable from a bug, so
 * this log is where the agent can look to say what happened.
 *
 * **Machine-local** (`.local.`, D65): committing it would make every commit
 * dirty the log the next commit then has to include.
 *
 * **Capped, keeping the newest**, so the agent can read it in one tool call.
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const HOOKS_LOG_FILE = '.holi/state/hooks.local.log'

/** Roughly a few hundred commits' worth of transform notes. */
const MAX_LINES = 2000

/**
 * Append one run's notes, stamped. Never throws: this is the least important
 * write in the system, and a log failure that broke a commit would be the
 * transform-breaks-your-save failure the whole design refuses.
 */
export async function appendHookLog(root: string, notes: string[]): Promise<void> {
  if (notes.length === 0) return
  const at = new Date().toISOString()
  const text = notes.map((note) => `${at}  ${note}`).join('\n') + '\n'
  const abs = join(root, HOOKS_LOG_FILE)

  try {
    await mkdir(dirname(abs), { recursive: true })
    await appendFile(abs, text, 'utf8')
    await trim(abs)
  } catch {
    // Deliberately silent. See the doc comment.
  }
}

export async function readHookLog(root: string): Promise<string> {
  return readFile(join(root, HOOKS_LOG_FILE), 'utf8').catch(() => '')
}

/** Keep only the last `MAX_LINES` lines. Read-and-rewrite is fine: this runs
 *  at most once per commit, on a file measured in kilobytes. */
async function trim(abs: string): Promise<void> {
  const text = await readFile(abs, 'utf8')
  const lines = text.split('\n')
  // A trailing '' from the final newline; keep the split stable either way.
  const hasTrailing = lines.at(-1) === ''
  const body = hasTrailing ? lines.slice(0, -1) : lines
  if (body.length <= MAX_LINES) return
  await writeFile(abs, body.slice(-MAX_LINES).join('\n') + '\n', 'utf8')
}
