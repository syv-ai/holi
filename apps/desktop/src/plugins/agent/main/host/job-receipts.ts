import { execFileSync } from 'node:child_process'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { defaultProbePid, killTree, type PidState } from '../../../../main/plugin-api'
import type { ActivationOwnership, LaunchOwnership } from './ownership'

const JOB_SESSION_ID = /^j[0-9a-f]{12}$/

interface WindowsRecovery {
  probePid(pid: number): PidState
  commandOf(pid: number): string | null
  stopTree(pid: number): void
}

// The pinned Windows sweep uses the command line only after the tree-root
// probe. POSIX never uses argv or a legacy PID receipt as ownership evidence.
const windowsRecovery: WindowsRecovery = {
  probePid: (pid) => defaultProbePid(pid, 'win32'),
  commandOf(pid) {
    try {
      return execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
        ],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
          timeout: 10_000,
        },
      ).trim()
    } catch {
      return null
    }
  },
  stopTree: (pid) => {
    killTree(pid, 'SIGKILL', 'win32')
  },
}

async function sweepWindows(root: string, adapter: WindowsRecovery | undefined) {
  const names = await readdir(root).catch(() => [] as string[])
  if (adapter) {
    for (const name of names) {
      if (!name.endsWith('.pid') || !JOB_SESSION_ID.test(name.slice(0, -4))) continue
      const [first = '', folder = ''] = (
        await readFile(join(root, name), 'utf8').catch(() => '')
      ).split('\n')
      const pid = Number(first.trim())
      if (!Number.isInteger(pid) || pid <= 1 || adapter.probePid(pid) !== 'group-leader') continue
      if (folder === '' || !(adapter.commandOf(pid) ?? '').includes(folder)) continue
      adapter.stopTree(pid)
    }
  }
  await rm(root, { recursive: true, force: true })
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
type Phase = 'PENDING' | 'ACTIVE' | 'FINALIZING' | 'SETTLED'

// ACTIVE is a fully published admission, before any caller teardown. It
// permits cold discard after native EOF proves all owners absent. PENDING and
// FINALIZING record interrupted work, so even native SETTLED cannot bypass
// unfinished output, release, copy-back, or bracket persistence.
const callerFrame = (id: string, phase: Phase) => `HOLI-JOB-1 ${id}\n${phase}\n`

function syncDir(dir: string) {
  const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function publishCaller(path: string, text: string) {
  const temp = `${path}.tmp`
  writeFileSync(temp, text, { flag: 'wx', mode: 0o600, flush: true })
  renameSync(temp, path)
  syncDir(dirname(path))
}

function completeCaller(root: string, id: string): boolean {
  try {
    const fd = openSync(
      join(root, `${id}.turn`),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || stat.mode & 0o077)
        return false
      const bytes = Buffer.alloc(128)
      if (stat.size >= bytes.length) return false
      const length = readSync(fd, bytes, 0, bytes.length, null)
      if (length !== stat.size) return false
      const text = bytes.toString('utf8', 0, length)
      return text === callerFrame(id, 'ACTIVE') || text === callerFrame(id, 'SETTLED')
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    if (!missing(error)) throw error
    return false
  }
}

export function jobScratch({
  scratchRoot: root,
  ownership,
  spawn,
  windowsRecovery: injected,
}: {
  scratchRoot: string
  ownership?: ActivationOwnership
  spawn?: unknown
  windowsRecovery?: WindowsRecovery
}) {
  const windows = process.platform === 'win32'
  const registry = windows ? undefined : ownership
  async function observe() {
    await lstat(root).then(
      (stat) => {
        if (!stat.isDirectory()) throw new Error(`Not a job state directory: ${root}`)
      },
      (error: unknown) => {
        if (!missing(error)) throw error
      },
    )
    // Observe the namespace asynchronously before the registry's all-or-nothing
    // inspection. The registry enumerates it again at the point of deletion.
    return readdir(root).catch((error: unknown) => {
      if (!missing(error)) throw error
      return []
    })
  }
  async function recover() {
    if (windows) return sweepWindows(root, injected ?? (spawn ? undefined : windowsRecovery))
    if (!registry) {
      const entries = await observe()
      if (entries.length) throw new Error(`Retaining unlinked job state: ${entries.join(', ')}.`)
      return
    }
    const checked = new Set<string>()
    await registry.recoverJobs(
      {
        root,
        consumerId(entry) {
          const id = /^(j[0-9a-f]{12})(?:\.(?:agent|pid|turn))?$/.exec(entry)?.[1]
          if (id && !checked.has(id)) {
            if (!completeCaller(root, id))
              throw new Error(`Retaining job ${id}: missing or incomplete caller receipt.`)
            checked.add(id)
          }
          return id
        },
      },
      observe,
    )
  }
  return {
    recover,
    forJob(id: string) {
      const pid = join(root, `${id}.pid`)
      const caller = join(root, `${id}.turn`)
      // A vault's job state stays resumable between turns. Keep each unique
      // link until that shared state is deleted; a native settled link cannot
      // stand in for the next turn's fresh physical proof.
      const turns: LaunchOwnership[] = []
      return {
        turn() {
          let record: LaunchOwnership | undefined
          let didNotLaunch = false
          return {
            get didNotLaunch() {
              return didNotLaunch
            },
            prepare(explicit: boolean) {
              record = registry?.allocate('jobs', id, explicit ? 'explicit' : 'native')
              if (record) {
                turns.push(record)
                publishCaller(caller, callerFrame(id, 'PENDING'))
              }
              if (!windows) rmSync(pid, { force: true })
              return record?.ownershipRecordPath
            },
            writePid(pidValue: number, cwd: string) {
              return mkdir(root, { recursive: true }).then(() =>
                writeFile(pid, `${pidValue}\n${cwd}\n`),
              )
            },
            phase(phase: 'ACTIVE' | 'FINALIZING') {
              if (record) publishCaller(caller, callerFrame(id, phase))
            },
            settle(scoped: boolean) {
              if (record) publishCaller(caller, callerFrame(id, 'SETTLED'))
              // Vault jobs can resume; their idle PID is diagnostic and the
              // next turn replaces it. Scoped jobs are done after this turn.
              if (windows || scoped) rmSync(pid, { force: true })
            },
            nonLaunch() {
              record?.nonLaunch()
              didNotLaunch = true
            },
            fail(error: unknown) {
              record?.fail(error)
            },
          }
        },
        fail(error: unknown) {
          const failures: unknown[] = []
          for (const turn of turns) {
            try {
              turn.fail(error)
            } catch (recordError) {
              failures.push(recordError)
            }
          }
          if (failures.length)
            throw new AggregateError(failures, 'Could not mark job receipts failed.')
        },
        async retire(check: () => void) {
          check()
          await rm(pid, { force: true })
          check()
          if (turns.length) {
            await rm(caller, { force: true })
            check()
            syncDir(root)
            for (const turn of turns) {
              check()
              turn.retire()
            }
            check()
            turns.length = 0
          }
        },
      }
    },
  }
}

export type JobFiles = ReturnType<ReturnType<typeof jobScratch>['forJob']>
export type JobTurnReceipt = ReturnType<JobFiles['turn']>
