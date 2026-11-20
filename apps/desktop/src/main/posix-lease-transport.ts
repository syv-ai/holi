import { execFileSync } from 'node:child_process'
import {
  closeSync,
  constants,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const leaseEnvironment = { PATH: '/usr/bin:/bin', LC_ALL: 'C' }

/** Own both named and inherited FIFO lifetimes. A read does bounded work:
 * undefined is not ready, null is EOF on this read (not a lifetime proof). */
export function openLeaseTransport(parent: string | undefined, inherited: boolean) {
  const buffer = Buffer.alloc(4096)
  const directory = mkdtempSync(resolve(parent ?? tmpdir(), 'holi-launch-'))
  const controlPath = join(directory, 'control')
  const reportPath = join(directory, 'report')
  const execPath = join(directory, 'exec')
  const paths = [controlPath, reportPath, execPath]
  const fds = new Set<number>()
  const open = (path: string, flags: number) => {
    const fd = openSync(path, flags | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    fds.add(fd)
    return fd
  }
  const close = (fd: number) => {
    if (fds.delete(fd)) closeSync(fd)
  }
  const closeAll = () => {
    for (const fd of fds) {
      try {
        close(fd)
      } catch {
        /* preserve first failure */
      }
    }
  }
  const remove = () => {
    closeAll()
    rmSync(directory, { recursive: true, force: true })
  }
  let control: number, report: number, result: number
  const mapped: number[] = []
  try {
    execFileSync('/usr/bin/mkfifo', ['-m', '600', ...paths], {
      env: leaseEnvironment,
      cwd: '/',
      stdio: 'ignore',
      timeout: 1000,
      killSignal: 'SIGKILL',
    })
    report = open(reportPath, constants.O_RDONLY)
    result = open(execPath, constants.O_RDONLY)
    // Paired nonblocking descriptors are portable, unlike FIFO O_RDWR.
    const reader = open(controlPath, constants.O_RDONLY)
    control = open(controlPath, constants.O_WRONLY)
    if (inherited) {
      mapped.push(reader, open(reportPath, constants.O_WRONLY), open(execPath, constants.O_WRONLY))
      for (const path of paths) rmSync(path)
    } else close(reader)
  } catch (error) {
    try {
      remove()
    } catch {
      /* original preparation error wins */
    }
    throw error
  }

  function read(fd: number): string | null | undefined {
    if (!fds.has(fd)) return
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const n = readSync(fd, buffer, 0, buffer.length, null)
        return n === 0 ? null : buffer.toString('utf8', 0, n)
      } catch (error) {
        const { code } = error as NodeJS.ErrnoException
        if (code === 'EAGAIN') return
        if (code !== 'EINTR' || attempt === 3) throw error
      }
    }
  }

  return {
    directory,
    mapped,
    dropMapped() {
      // A failure closing one descriptor must not strand the other copies.
      let failure: unknown
      for (const fd of mapped) {
        try {
          close(fd)
        } catch (error) {
          failure ??= error
        }
      }
      if (failure) throw failure
    },
    controlClosed: () => !fds.has(control),
    closeControl: () => close(control),
    readReport: () => read(report),
    readExec: () => read(result),
    closeExec: () => close(result),
    post(bytes: Buffer, offset = 0): number {
      try {
        return writeSync(control, bytes, offset, bytes.length - offset)
      } catch (error) {
        const { code } = error as NodeJS.ErrnoException
        if (code === 'EAGAIN' || code === 'EINTR') return 0
        throw error
      }
    },
    remove,
    retainFailure(evidence: string) {
      closeAll()
      writeFileSync(join(directory, 'failure'), evidence, { flag: 'wx', mode: 0o600 })
    },
  }
}
