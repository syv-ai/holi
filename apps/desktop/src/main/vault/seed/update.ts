/**
 * `holi skills update`: bring this release's shipped files (skills, hooks) to
 * a vault that already has its own copies.
 *
 * Shipped files are **the vault's from the moment they are written**, and
 * written only when the vault is created: a vault works in any Claude Code
 * (the desktop app, the web, a plain CLI), so these are ordinary committed
 * files, and nothing Holi does on an open changes them. A newer version reaches
 * a vault only through this update, which replaces a file the vault never
 * touched, 3-way merges one it did, and hands a conflict to an agent session.
 */
import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { merge3, vaultRelPath } from '@holi/shared'
import { writeAtomic } from '../vault-files'
import { runMerges, shippedFiles } from './seed'
import { readSeedState, recordSeeded, untouched } from './state'
import type { SeedContribution } from './types'

/** What `holi skills update` did, one list per outcome, by vault path. */
export interface UpdateReport {
  /** The vault never changed it: replaced with the shipped version. */
  updated: string[]
  /** Shipped, and new to this vault. */
  added: string[]
  /** Both changed it, in different places: both kept. */
  merged: string[]
  /** For an agent: both changed the same lines, or there is no base to merge
   *  from. The shipped version is staged beside it (`stagedPath`). */
  conflicts: string[]
  /** Nothing new to bring: already the shipped version, or the vault's own
   *  changes on top of it. */
  current: string[]
  /** The vault deleted it after Holi seeded it: left deleted. */
  deleted: string[]
}

/** What an update answers across the CLI and IPC: the report, and the
 *  session its conflicts were handed to, if any. */
export type SkillsUpdate =
  | { ok: true; report: UpdateReport; summary: string; terminalId?: string }
  | { ok: false; message: string }

/**
 * Where a conflict's other versions wait for the agent: beside the file, with
 * `.shipped.local` or `.base.local` before its extension. `.local.` keeps them
 * on this machine and out of every commit.
 */
export function stagedPath(rel: string, which: 'shipped' | 'base'): string {
  const slash = rel.lastIndexOf('/')
  const dot = rel.lastIndexOf('.')
  return dot > slash
    ? `${rel.slice(0, dot)}.${which}.local${rel.slice(dot)}`
    : `${rel}.${which}.local`
}

async function removeStaged(root: string, rel: string): Promise<void> {
  for (const which of ['shipped', 'base'] as const) {
    await unlink(join(root, stagedPath(rel, which))).catch(() => undefined)
  }
}

/**
 * Per file, against the base Holi recorded when it wrote it:
 *
 *   - already the shipped text: current;
 *   - absent: added if Holi never wrote it here, left alone if the vault
 *     deleted it;
 *   - untouched since Holi wrote it: replaced;
 *   - changed, with the base's text: 3-way merged, kept when it merges clean;
 *   - otherwise a conflict, the file left as it is and the shipped version
 *     (and the base, when there is one) staged beside it for an agent.
 *
 * A conflict records the shipped version as the base, since the agent resolves
 * against it. Until the agent deletes what was staged, the file stays a
 * conflict: merging the vault's unresolved text against that new base would
 * quietly keep it and drop Holi's changes. Merged files are merged again at
 * the end: a hook script this added is wired in the same run.
 */
export async function updateShipped(
  root: string,
  contributions: readonly SeedContribution[],
): Promise<UpdateReport> {
  const report: UpdateReport = {
    updated: [],
    added: [],
    merged: [],
    conflicts: [],
    current: [],
    deleted: [],
  }
  const state = await readSeedState(root)

  for (const [rel, shipped] of shippedFiles(contributions)) {
    const onDisk = await readFile(join(root, rel), 'utf8').catch(() => null)
    const record = state.files[rel]
    let write: string | null = null
    // A conflict handed off earlier and not yet resolved: the agent deletes
    // what was staged when it is done.
    const pending =
      (await readFile(join(root, stagedPath(rel, 'shipped'))).catch(() => null)) !== null

    if (onDisk === shipped) report.current.push(rel)
    else if (pending && onDisk !== null) {
      // Still the agent's: refresh what it merges from, and nothing else. The
      // base it was given stays, and the record already names this release.
      await writeAtomic(root, vaultRelPath(stagedPath(rel, 'shipped')), shipped)
      await recordSeeded(root, rel, shipped)
      report.conflicts.push(rel)
      continue
    } else if (onDisk === null) {
      if (record !== undefined) report.deleted.push(rel)
      else {
        write = shipped
        report.added.push(rel)
      }
    } else if (untouched(record, onDisk)) {
      write = shipped
      report.updated.push(rel)
    } else {
      const merge = record === undefined ? null : merge3(record.text, onDisk, shipped)
      if (merge?.kind === 'merged') {
        // Only the vault's changes, on top of what it already had: nothing new
        // from Holi, so nothing to write or report.
        if (merge.text === onDisk) report.current.push(rel)
        else {
          write = merge.text
          report.merged.push(rel)
        }
      } else {
        await writeAtomic(root, vaultRelPath(stagedPath(rel, 'shipped')), shipped)
        if (record !== undefined) {
          await writeAtomic(root, vaultRelPath(stagedPath(rel, 'base')), record.text)
        }
        // The agent's resolution is made against this release, so it is the
        // base the next update merges from.
        await recordSeeded(root, rel, shipped)
        report.conflicts.push(rel)
        continue
      }
    }

    if (write !== null) await writeAtomic(root, vaultRelPath(rel), write)
    // The shipped text is the base from here on, whatever the file now holds:
    // a merged file carries the vault's changes on top of it.
    if (onDisk !== null || write !== null) await recordSeeded(root, rel, shipped)
    await removeStaged(root, rel)
  }

  await runMerges(root, contributions)
  return report
}

/**
 * What this release would bring the vault, without writing anything: the
 * shipped files Holi has a newer version of than the one it last brought here,
 * and those new to this vault. Asked on every open, so Holi can say an update
 * exists rather than wait to be asked (docs/features/updates.md).
 *
 * Deliberately quieter than `updateShipped`: a file that differs with no base
 * on this machine (a teammate's clone that never seeded it) is not counted,
 * because nothing says Holi changed it rather than the vault; nor is one the
 * vault deleted, or one already handed to an agent.
 */
export async function pendingShipped(
  root: string,
  contributions: readonly SeedContribution[],
): Promise<string[]> {
  const state = await readSeedState(root)
  const pending: string[] = []
  for (const [rel, shipped] of shippedFiles(contributions)) {
    const onDisk = await readFile(join(root, rel), 'utf8').catch(() => null)
    if (onDisk === shipped) continue
    const record = state.files[rel]
    if (onDisk === null) {
      if (record === undefined) pending.push(rel)
      continue
    }
    if (record === undefined || record.text === shipped) continue
    const handedOff =
      (await readFile(join(root, stagedPath(rel, 'shipped'))).catch(() => null)) !== null
    if (!handedOff) pending.push(rel)
  }
  return pending
}

/** The report in one line, for the notification and the CLI. */
export function describeUpdate(report: UpdateReport, sessionStarted: boolean): string {
  const parts = [
    [report.updated.length, 'updated'],
    [report.added.length, 'added'],
    [report.merged.length, 'merged'],
  ] as const
  const done = parts.filter(([n]) => n > 0).map(([n, what]) => `${n} ${what}`)
  const conflicts = report.conflicts.length
  if (done.length === 0 && conflicts === 0) return 'Skills are up to date.'
  const head = done.length > 0 ? `Skills: ${done.join(', ')}.` : ''
  const tail =
    conflicts === 0
      ? ''
      : `${conflicts} ${conflicts === 1 ? 'needs' : 'need'} merging by hand` +
        (sessionStarted
          ? ': a session is on it.'
          : ', with the new version staged beside each as a .shipped.local file.')
  return [head, tail].filter((t) => t !== '').join(' ')
}

/**
 * The first turn of the session that resolves an update's conflicts. One of
 * the few sends Holi submits: resolving them is a job the user asked for.
 */
export async function updateConflictPrompt(root: string, conflicts: string[]): Promise<string> {
  const lines: string[] = []
  for (const rel of conflicts) {
    const base = stagedPath(rel, 'base')
    const hasBase = (await readFile(join(root, base)).catch(() => null)) !== null
    lines.push(
      `- \`${rel}\`: Holi's new version is \`${stagedPath(rel, 'shipped')}\`` +
        (hasBase ? `; the version this vault started from is \`${base}\`` : '') +
        '.',
    )
  }
  return [
    'Holi ships newer versions of these files, and this vault has changed them too, so they could not be merged automatically:',
    '',
    ...lines,
    '',
    "Merge each one in place: bring in Holi's changes and keep this vault's own. Where the two contradict, keep what this vault meant and say so. Then delete the `.shipped.local` and `.base.local` files, and summarise what changed.",
  ].join('\n')
}
