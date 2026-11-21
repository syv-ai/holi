import type { SpawnOptions } from 'node:child_process'
import type { openLeaseTransport } from './posix-lease-transport'

export function receiptPid(text: string): number {
  const pid = Number(text)
  if (!/^[1-9]\d{0,9}$/.test(text) || pid <= 1 || pid > 0x7fffffff)
    throw new Error('Invalid POSIX launch receipt PID.')
  return pid
}

export function environmentFrame(options: SpawnOptions, childProcess: boolean): Buffer {
  // Match Node's inherited enumerable keys. Provider env never runs the
  // helper and does not appear on disk or in argv.
  const env = options.env ?? process.env
  const vars: string[] = []
  for (const key in env) {
    if (env[key] === undefined) continue
    const entry = `${key}=${env[key]}`
    if (entry.includes('\0')) throw new TypeError('NUL in POSIX launch environment.')
    vars.push(`${entry}\0`)
  }
  const coverage = process.env.NODE_V8_COVERAGE
  if (childProcess && env.NODE_V8_COVERAGE === undefined && coverage)
    vars.push('NODE_V8_COVERAGE=' + coverage + '\0')
  const payload = Buffer.from(vars.join(''))
  if (payload.length > 8 * 1024 * 1024)
    throw new RangeError('POSIX launch environment is too large.')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(payload.length)
  return Buffer.concat([header, payload])
}

function decode(line: string) {
  switch (line) {
    case 'START':
    case 'GO':
    case 'TERM':
    case 'KILL':
      return { kind: line }
  }
  const [kind, first, second, extra] = line.split(' ')
  if (second === undefined && first !== undefined) {
    if (kind === 'ROOT' || kind === 'WRONG' || kind === 'REAPER')
      return { kind, pid: receiptPid(first) }
    if (kind === 'SIGNAL' && /^[1-9]\d{0,2}$/.test(first)) return { kind, sig: Number(first) }
  }
  if (extra === undefined && first !== undefined && second !== undefined) {
    if (kind === 'READY') return { kind, anchor: receiptPid(first), reaper: receiptPid(second) }
    if (kind === 'ERROR' && /^[a-z-]+$/.test(first) && /^[1-9]\d{0,9}$/.test(second))
      return { kind, failure: new Error(`POSIX launch ${first} failed (errno ${second}).`) }
  }
  throw invalidReceipt(line)
}

export function invalidReceipt(line: string): Error {
  return new Error(`Invalid POSIX launch protocol receipt: ${JSON.stringify(line)}`)
}

/** Bounded report framing and exec receipt decoding, independent of which
 * identities or transitions the lease is allowed to accept. */
export function leaseReceipts(
  transport: Pick<ReturnType<typeof openLeaseTransport>, 'readReport' | 'readExec' | 'closeExec'>,
) {
  let history = ''
  let pending = ''
  let discarding = false
  let execText = ''
  let execResult: number | null | undefined
  const limit = 128
  return {
    history: () => history,
    collect(
      receive: (receipt: ReturnType<typeof decode>, line: string) => void,
      note: (error: unknown) => void,
    ): boolean {
      try {
        const text = transport.readReport()
        if (text) {
          history = (history + text).slice(-4096)
          const lines = (pending + text).split('\n')
          pending = lines.pop()!
          for (const line of lines) {
            try {
              if (!discarding) {
                if (line.length > limit) throw new Error('Oversized POSIX launch receipt.')
                receive(decode(line), line)
              }
            } catch (error) {
              note(error)
            }
            discarding = false
          }
          if (pending.length > limit || discarding) {
            pending = ''
            discarding = true
            note(new Error('Oversized POSIX launch receipt.'))
          }
        }
        if (text === null) {
          if (pending) note(new Error('Truncated POSIX launch receipt.'))
          return true
        }
      } catch (error) {
        note(error)
      }
      return false
    },
    execution(): number | null | undefined {
      if (execResult !== undefined) return execResult
      const text = transport.readExec()
      if (text) execText += text
      if (execText.length > 12) throw new Error('Oversized POSIX exec receipt.')
      if (text !== null && !execText.includes('\n')) return undefined
      if (execText && !/^[1-9]\d{0,3}\n$/.test(execText))
        throw new Error('Invalid POSIX exec receipt.')
      transport.closeExec()
      return (execResult = execText ? -Number(execText) : null)
    },
  }
}
