import type { ChildProcess } from 'node:child_process'
import type { PtyProcess } from '../../main/host/pty'

const DESTROY_OUTPUT_MS = 200

/** Model the pinned node-pty Unix output socket with the real stdout pipe.
 * The root edge is synchronous; public exit belongs to the socket close,
 * including a close caused by node-pty's 200 ms destroy backstop. */
export function leasedPty(child: ChildProcess, deliver: () => Promise<void>) {
  const output = child.stdout!
  let outputClosed = false
  let rootExit: { exitCode: number } | undefined
  let listener: ((event: { exitCode: number }) => void) | undefined
  let backstop: ReturnType<typeof setTimeout> | undefined
  let path: 'output' | 'backstop' = 'output'
  let settled!: () => void
  const outputSettled = new Promise<void>((resolve) => (settled = resolve))
  const publish = () => {
    if (!rootExit || !outputClosed) return
    const event = rootExit
    rootExit = undefined
    void deliver().then(() => {
      listener?.(event)
      settled()
    })
  }
  const pty: PtyProcess & { _boundClose: boolean } = {
    pid: child.pid!,
    _boundClose: false,
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
    outputClosed = true
    clearTimeout(backstop)
    backstop = undefined
    publish()
  })
  child.once('exit', (code) => {
    rootExit = { exitCode: code ?? -1 }
    // Set the pinned own field even if the surrogate pipe already closed:
    // Runtime's root-exit observer must run before public exit can dispatch.
    pty._boundClose = true
    if (outputClosed) publish()
    else {
      backstop = setTimeout(() => {
        backstop = undefined
        path = 'backstop'
        output.destroy()
      }, DESTROY_OUTPUT_MS)
    }
  })
  return { pty, outputSettled, path: () => path, timerPending: () => backstop !== undefined }
}
