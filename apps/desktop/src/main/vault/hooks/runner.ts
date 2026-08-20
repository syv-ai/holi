/**
 * Run the enabled pre-commit transforms, restage what they rewrote, and let the
 * commit through whatever happens.
 *
 * **A transform never vetoes a commit, and that is the load-bearing rule.**
 * Holi auto-commits, non-interactively, and that commit IS the user's save. A
 * transform is an opinion about formatting or link hygiene; an opinion does not
 * get to outrank someone's words. So a transform that throws is caught, logged,
 * pushed to the agent, and the commit proceeds. Only a future *integrity* check
 * could earn the right to stop a commit, and it would still need a UI surface
 * rather than a silent refusal (D76).
 *
 * **The vault's settings choose which transforms run — never what one is.**
 * `core.hooksPath` pointed into the tracked tree would mean a teammate's push
 * runs their code on your laptop, on every commit, with your filesystem. That
 * is D74's escalation argument with a different filename. The script body ships
 * in the binary; `.holi/settings.json` carries booleans and nothing else.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { appendHookLog } from './log'
import type { StagedChanges } from './staged'
import type { TransformResult } from './relink'

const exec = promisify(execFile)

export type TransformName = 'relink' | 'archive-done' | 'normalize-md'

export interface Transform {
  name: TransformName
  /** **May never throw as a veto.** The runner catches, logs, notifies, and the
   *  commit proceeds regardless. */
  run(root: string, staged: StagedChanges): Promise<TransformResult>
}

/** The committed enable list. Keys ARE the `TransformName` values, kebab and
 *  all: a camelCase settings key beside a kebab transform name is a mapping
 *  table that exists only to be got wrong once. */
export type HookSettings = Partial<Record<TransformName, boolean>>

export interface HookRun {
  /** Restaged by the runner, so THIS commit carries the fix. */
  changed: string[]
  failed: { name: TransformName; error: string }[]
  /** Tripped the breaker and was skipped. */
  disabled: TransformName[]
}

export interface RunOpts {
  settings: HookSettings
  transforms: Transform[]
  /** Push a summary to a running agent. Absent, or throwing, is normal: no
   *  session open is the common case, not an error. */
  notify?: (summary: string) => void
}

/** How many consecutive failures before a transform sits out the session. */
const BREAKER_LIMIT = 3

/**
 * Consecutive failures per transform, **in memory and per session**.
 *
 * Deliberately not in the log: a restart is a fair reason to try again, and
 * persisting it would turn one bad afternoon into a transform that is off
 * forever with no obvious way to notice.
 */
const failures = new Map<TransformName, number>()

/** Test seam — the breaker is process-global by design, so tests reset it. */
export function resetBreaker(): void {
  failures.clear()
}

export async function runPreCommit(
  root: string,
  staged: StagedChanges,
  opts: RunOpts,
): Promise<HookRun> {
  const run: HookRun = { changed: [], failed: [], disabled: [] }
  const notes: string[] = []

  for (const transform of opts.transforms) {
    if (opts.settings[transform.name] !== true) continue

    if ((failures.get(transform.name) ?? 0) >= BREAKER_LIMIT) {
      run.disabled.push(transform.name)
      notes.push(
        `${transform.name}: disabled for this session after ${BREAKER_LIMIT} consecutive ` +
          `failures — restart Holi to try it again`,
      )
      continue
    }

    try {
      const result = await transform.run(root, staged)
      failures.set(transform.name, 0)
      run.changed.push(...result.changed)
      notes.push(...result.notes)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.set(transform.name, (failures.get(transform.name) ?? 0) + 1)
      run.failed.push({ name: transform.name, error: message })
      notes.push(`${transform.name}: FAILED — ${message} (the commit was not blocked)`)
    }
  }

  run.changed = [...new Set(run.changed)].sort()
  if (run.changed.length > 0) {
    try {
      await restage(root, run.changed)
    } catch (error) {
      // Even this cannot stop the commit. The cost is that the rewrite lands in
      // the NEXT commit rather than this one, which is worse than restaging and
      // far better than refusing to save.
      const message = error instanceof Error ? error.message : String(error)
      notes.push(`restage FAILED — ${message}; the rewrite will land in the next commit`)
    }
  }

  await appendHookLog(root, notes)
  if (notes.length > 0 && opts.notify !== undefined) {
    try {
      opts.notify(notes.join('\n'))
    } catch {
      // No agent listening. Normal, and never an error — an error here would
      // become the failure it was trying to report.
    }
  }
  return run
}

/** `git add -A --` on exactly the touched paths: `-A` so a path the transform
 *  *removed* (archive-done moves files) is staged as the deletion it is, and
 *  `--` so a path that looks like a flag is still a path. */
async function restage(root: string, paths: string[]): Promise<void> {
  await exec('git', ['add', '-A', '--', ...paths], { cwd: root })
}
