import type { ChildProcess } from 'node:child_process'
import type { PtyProcess } from '../../main/host/pty'

const DESTROY_OUTPUT_MS = 200

/** node-pty 1.1.0 UnixTerminal's own fields and both paths through its native
 * exit callback, using the real stdout pipe in place of the tty socket. */
export function leasedPty(
  child: ChildProcess,
  dispatch: (fire: () => void) => void = (fire) => fire(),
) {
  const output = child.stdout!
  let listener: ((event: { exitCode: number }) => void) | undefined
  let onSocketClose: (() => void) | undefined
  let backstop: ReturnType<typeof setTimeout> | undefined
  let path: 'already-closed' | 'output' | 'backstop' | undefined
  let settled!: () => void
  const outputSettled = new Promise<void>((resolve) => (settled = resolve))
  const pty: PtyProcess & { _boundClose: boolean; _emittedClose: boolean } = {
    pid: child.pid!,
    _boundClose: false,
    _emittedClose: false,
    onData: (cb) => output.on('data', (bytes: Buffer) => cb(bytes.toString())),
    onExit: (cb) => {
      listener = cb
    },
    write: (data) => {
      child.stdin!.write(data)
    },
    resize: () => {},
    kill: () => {
      throw new Error('PTY bypassed its retained POSIX lease')
    },
  }
  output.once('close', () => {
    pty._emittedClose = true
    onSocketClose?.()
  })
  child.once('exit', (code) => {
    const publish = () =>
      dispatch(() => {
        listener?.({ exitCode: code ?? -1 })
        settled()
      })
    if (pty._emittedClose) {
      path = 'already-closed'
      publish()
      return
    }
    if (pty._boundClose) return
    pty._boundClose = true
    backstop = setTimeout(() => {
      backstop = undefined
      path = 'backstop'
      output.destroy()
    }, DESTROY_OUTPUT_MS)
    onSocketClose = () => {
      clearTimeout(backstop)
      backstop = undefined
      path ??= 'output'
      publish()
    }
  })
  return { pty, outputSettled, path: () => path, timerPending: () => backstop !== undefined }
}
