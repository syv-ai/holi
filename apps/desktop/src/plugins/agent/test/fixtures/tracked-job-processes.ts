import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ownedProcessDrain, spawnOwnedProgram } from '../../../../main/plugin-api'

export function absent(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
    throw error
  }
}

/** Track only newly launched children in this fixture's unique tmpdir root. */
export function trackedJobProcesses(root: string) {
  const children: Array<{
    child: ReturnType<typeof spawnOwnedProgram>
    closed: Promise<void>
  }> = []
  return {
    get count() {
      return children.length
    },
    spawn(bin: string, args: string[], opts: { cwd: string; env: Record<string, string> }) {
      const child = spawnOwnedProgram(bin, args, {
        ...opts,
        posixGroupLease: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
      children.push({ child, closed })
      if (child.pid !== undefined) {
        appendFileSync(join(root, 'job-processes.jsonl'), JSON.stringify({ pid: child.pid }) + '\n')
      }
      return child
    },
    async drain() {
      const results = await Promise.allSettled(
        children.map(async ({ child, closed }) => {
          const lease = child[ownedProcessDrain]
          if (lease !== undefined) await lease.drain()
          else if (process.platform === 'win32' && child.pid !== undefined) child.kill('SIGTERM')
          else if (process.platform !== 'win32')
            throw new Error(`Fixture process has no lease in ${root}`)
          const pid = child.pid
          const deadline = Date.now() + 5_000
          const confirmed = () =>
            pid === undefined || (absent(pid) && (process.platform === 'win32' || absent(-pid)))
          while (!confirmed() && Date.now() < deadline) await delay(20)
          if (!confirmed())
            throw new Error(`Fixture process ${pid} not absent; evidence at ${root}`)
          await closed
        }),
      )
      const errors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      )
      if (errors.length > 0) throw new AggregateError(errors, `Fixture drain failed: ${root}`)
    },
  }
}
