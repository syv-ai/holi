import { randomBytes } from 'node:crypto'
import { lstat, open, readdir, rm, rmdir } from 'node:fs/promises'
import { join } from 'node:path'

interface MarkedJob {
  id: string
  marker?: string
  finalizationError?: Error
}

/** Windows scratch recovery for one activation's private job namespace. No
 * marker, pid, or other remnant can prove that a crashed launch drained. */
export function createWindowsJobRecovery(scratchRoot: string) {
  async function verifyScratch(): Promise<void> {
    const stat = await lstat(scratchRoot).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null
      throw err
    })
    if (stat === null) return
    // Even an empty-looking link is not this vault's namespace. An unreadable
    // directory, a legacy pid file, or state without a marker is not proof.
    if (!stat.isDirectory() || (await readdir(scratchRoot)).length !== 0)
      throw new Error('Windows job ownership is unproven; its scratch state is retained.')
  }

  async function publishMarker(job: MarkedJob): Promise<void> {
    const marker = join(scratchRoot, `${job.id}.${randomBytes(6).toString('hex')}.owned`)
    const handle = await open(marker, 'wx', 0o600)
    // Never remove a name we failed to acquire. The marker encodes uncertainty,
    // not a pid, and cannot certify drain even when its contents are intact.
    job.marker = marker
    try {
      await handle.writeFile('pending Windows job ownership\n')
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  async function removeMarker(job: MarkedJob): Promise<void> {
    if (job.marker === undefined || job.finalizationError !== undefined) return
    await rm(job.marker, { force: true })
    delete job.marker
  }

  /** Leave must not sweep unexpected new remnants either. */
  function removeEmptyRoot(): Promise<void> {
    return rmdir(scratchRoot).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err
    })
  }

  /** Capture stop failures in settlement order. The host calls throwFirst
   * only after joining every stop, preparation and turn finalizer. */
  function stopFailures() {
    let first: PromiseRejectedResult | undefined
    return {
      record(reason: unknown): void {
        first ??= { status: 'rejected', reason }
      },
      throwFirst(): void {
        if (first !== undefined) throw first.reason
      },
    }
  }

  return { verifyScratch, publishMarker, removeMarker, removeEmptyRoot, stopFailures }
}
