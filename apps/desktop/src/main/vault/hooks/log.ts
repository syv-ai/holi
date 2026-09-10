/**
 * What the pre-commit transforms did, in a file the agent can read.
 *
 * **There was no agent-readable log surface in Holi before this one.** It
 * exists because a transform that rewrites files silently is indistinguishable
 * from a bug: the user sees a diff they did not make, and has nowhere to look.
 * The agent is the fast path — it reads this file and can say what happened —
 * and the sync status bar is the floor for when no session is open.
 *
 * **Machine-local** (`.local.`, D65): it is a record of what happened on this
 * clone. Committing it would put one machine's transform history in everyone's
 * repo and, worse, make every commit dirty the log that the next commit then
 * has to include.
 *
 * **Capped, keeping the newest.** The oldest entries are the ones nobody will
 * ever ask about, and a log that grows forever is one the agent cannot read in
 * a single tool call.
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

/** Rewrite the file with only its last `MAX_LINES` lines, when it has grown
 *  past them. Read-and-rewrite rather than anything cleverer: this runs at most
 *  once per commit, on a file measured in kilobytes. */
async function trim(abs: string): Promise<void> {
  const text = await readFile(abs, 'utf8')
  const lines = text.split('\n')
  // A trailing '' from the final newline; keep the split stable either way.
  const hasTrailing = lines.at(-1) === ''
  const body = hasTrailing ? lines.slice(0, -1) : lines
  if (body.length <= MAX_LINES) return
  await writeFile(abs, body.slice(-MAX_LINES).join('\n') + '\n', 'utf8')
}
