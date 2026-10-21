/**
 * Holi's housekeeping of the agent's two short-lived layers
 * (docs/features/agent-memory.md): scratch notes under `.holi/memory/` whose
 * `expires` has passed, and work-log days older than `WORK_LOG_KEEP_DAYS`.
 * Both are `.local.` files on this machine, so deleting them takes nothing from
 * anyone else. Code on a timer, not a prompt and not a hook: it runs when the
 * vault opens and every `SWEEP_EVERY_MS` while it is open.
 *
 * No Electron import: this loads under plain Node like the rest of the plugin.
 */
import type { Dirent } from 'node:fs'
import { readdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { MEMORY_DIR, isExpiredScratch, isLocalOnlyPath, localDate } from '@holi/shared'
import { staleWorkLogs, WORK_LOG_DIR, WORK_LOG_KEEP_DAYS } from '../inbox/work-log'

/** Hourly: a scratch note set to end at 15:00 is gone by 16:00. The session
 *  overview already leaves an expired one out, so the minute does not matter. */
export const SWEEP_EVERY_MS = 60 * 60 * 1000

/** A directory's entries, or none when it is missing (a vault with no memory
 *  yet, a machine with no log yet). */
async function entries(abs: string): Promise<Dirent[]> {
  try {
    return await readdir(abs, { withFileTypes: true })
  } catch {
    return []
  }
}

/** Every personal markdown file under `.holi/memory/`, as vault paths.
 *  Symlinks are skipped, not followed: one could point out of the vault. */
async function personalMemories(root: string, rel = MEMORY_DIR): Promise<string[]> {
  const out: string[] = []
  for (const entry of await entries(join(root, rel))) {
    const path = `${rel}/${entry.name}`
    if (entry.isDirectory()) out.push(...(await personalMemories(root, path)))
    else if (entry.isFile() && path.endsWith('.md') && isLocalOnlyPath(path)) out.push(path)
  }
  return out
}

/** Delete what has expired in the vault at `root`; the vault paths deleted. A
 *  file that cannot be read or deleted is left for the next sweep. */
export async function sweepAgentMemory(root: string, now: Date): Promise<string[]> {
  const doomed: string[] = []
  for (const path of await personalMemories(root)) {
    const text = await readFile(join(root, path), 'utf8').catch(() => null)
    if (text !== null && isExpiredScratch(path, text, now)) doomed.push(path)
  }
  const logs = (await entries(join(root, WORK_LOG_DIR)))
    .filter((e) => e.isFile())
    .map((e) => e.name)
  for (const name of staleWorkLogs(logs, localDate(now), WORK_LOG_KEEP_DAYS)) {
    doomed.push(`${WORK_LOG_DIR}/${name}`)
  }
  const deleted: string[] = []
  for (const path of doomed) {
    await unlink(join(root, path)).then(
      () => deleted.push(path),
      (err: unknown) => console.error(`[agent] sweep ${path}:`, err),
    )
  }
  return deleted
}
