import { createHmac, timingSafeEqual } from 'node:crypto'
import { TextDecoder } from 'node:util'

export type LaunchMode = 'ordinary' | 'retained'
export type JobAction = 'release' | 'revoke' | 'recover'
type JobBinding = { jobId: string; commitGuardId: string }
type JobRegistration = JobBinding & { jobHandle: string; commitGuardHandle: string }
type OrdinaryRegistration = {
  jobId: string
  jobHandle: null
  commitGuardId: null
  commitGuardHandle: null
}
export type OwnedProcessMessage =
  | { type: 'hello'; helperPid: number; parentPid: number; birth: string; parentBirth: string }
  | ({ type: 'setup'; parentBirth: string } & (
      ({ mode: 'retained' } & JobRegistration) | ({ mode: 'ordinary' } & OrdinaryRegistration)
    ))
  | { type: 'phase'; phase: string; rootPid: number | null; state: string }
  | { type: 'root-created'; rootPid: number }
  | { type: 'root-exit'; rootPid: number; rootExitCode: number }
  | { type: 'ready' }
  | {
      type: 'empty'
      exitCode: number
      rootExitCode: number | null
      rootPid: number | null
      reason: 'natural' | 'stopped' | 'launch-failed'
      outputFailed: boolean
    }
  | { type: 'handoff'; exitCode: 0; rootExitCode: 0; rootPid: number }
  | { type: 'error'; code: OwnedProcessErrorCode }
  | { type: 'auth'; helperPid: number; parentPid: number; mode: LaunchMode }
  | ({ type: 'registered'; stop: OwnedProcessSignal | null } & (
      JobRegistration | OrdinaryRegistration
    ))
  | { type: 'stop'; signal: OwnedProcessSignal }
  | { type: 'acknowledge' }
  | ({ type: 'brokerReady' | 'committed' | 'drained' | 'released' | 'closeSources' } & JobBinding)
  | ({ type: 'grant'; action: JobAction } & JobBinding)
  | ({ type: 'recovered'; action: 'recover'; parentPid: number; parentBirth: string } & JobBinding &
      RecoveryEvidence)

type RecoveryEvidence = {
  [K in 'job' | 'guard' as `${K}State`]: 'absent' | 'closed-zero'
} & {
  [K in 'job' | 'guard' as `${K}${'Before' | 'After' | 'ActiveBefore' | 'ActiveAfter'}`]:
    number | null
}

type OwnedProcessErrorCode =
  | 'nativeQueryFailure'
  | 'helperFailure'
  | 'launchFailure'
  | 'parentUnavailable'
  | 'controlFailure'
  | 'protocolFailure'
export type OwnedProcessSignal = 'SIGTERM' | 'SIGKILL' | 'SIGINT' | 'SIGHUP' | 'SIGQUIT'
type Role = 'parent' | 'helper'

export interface OwnedProtocol {
  encode(message: OwnedProcessMessage): Buffer
  push(chunk: Buffer): OwnedProcessMessage[]
  readonly partial: boolean
  finish(): void
}

const frameBytes = 4096
const transcriptBytes = 32 * 1024
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** Flat strict JSON: tokenize before decoding so escaped aliases cannot overwrite keys
 * and numeric fields cannot smuggle exponents, fractions, or negative zero. */
function parseObject(bytes: Buffer): Record<string, unknown> {
  const text = decoder.decode(bytes)
  const start = /^[ \t\r\n]*\{/.exec(text)
  if (!start) throw new Error()
  const member =
    /[ \t\r\n]*("(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*")[ \t\r\n]*:[ \t\r\n]*("(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*"|0|[1-9][0-9]*|null|true|false)[ \t\r\n]*([,}])/y
  member.lastIndex = start[0].length
  const record: Record<string, unknown> = Object.create(null)
  for (;;) {
    const match = member.exec(text)
    if (!match) throw new Error()
    const key: string = JSON.parse(match[1]!)
    if (Object.hasOwn(record, key)) throw new Error()
    record[key] = JSON.parse(match[2]!)
    if (match[3] === '}') {
      if (!/^[ \t\r\n]*$/.test(text.slice(member.lastIndex))) throw new Error()
      return record
    }
  }
}

/** Bounded authenticated frames. The caller owns transcript ordering and deadlines. */
export function createOwnedProtocol({
  launchId,
  secret,
  role,
}: {
  launchId: string
  secret: Buffer
  role: Role
}): OwnedProtocol {
  if (
    !launchId ||
    /[\r\n]/.test(launchId) ||
    !Buffer.isBuffer(secret) ||
    secret.length !== 32 ||
    (role !== 'parent' && role !== 'helper')
  )
    throw new Error('Invalid owned-process protocol configuration')
  const key = Buffer.from(secret)
  const inbound = role === 'parent' ? 'helper' : 'parent'
  const pending = Buffer.allocUnsafe(frameBytes - 1)
  let length = 0
  let sent = 0
  let received = 0
  let total = 0
  let stickyError: Error | undefined
  let finished = false
  const fail = (message: string): never => {
    stickyError ??= new Error(message)
    throw stickyError
  }
  const healthy = () => {
    if (stickyError) throw stickyError
    if (finished) fail('Owned-process protocol is finished')
  }
  const account = (count: number) => {
    total += count
    if (total > transcriptBytes) fail('Owned-process protocol byte limit exceeded')
  }
  const mac = (direction: Role, seq: number, payload: string) =>
    createHmac('sha256', key)
      .update(`1\n${launchId}\n${direction}\n${seq}\n${payload}`, 'utf8')
      .digest()
  const decode = (bytes: Buffer) => {
    try {
      const e = parseObject(bytes)
      if (
        !exact(e, ['version', 'launchId', 'direction', 'seq', 'payloadBase64', 'macBase64']) ||
        e.version !== 1 ||
        e.launchId !== launchId ||
        e.direction !== inbound ||
        e.seq !== received
      )
        throw new Error()
      const payload = base64(e.payloadBase64)
      const signature = base64(e.macBase64)
      if (
        signature.length !== 32 ||
        !timingSafeEqual(signature, mac(inbound, received, e.payloadBase64 as string))
      )
        throw new Error()
      const message = parseObject(payload)
      validate(message, inbound)
      received++
      return message
    } catch {
      return fail('Invalid owned-process frame')
    }
  }

  return {
    get partial() {
      return length !== 0
    },
    encode(message) {
      healthy()
      try {
        validate(message as Record<string, unknown>, role)
      } catch {
        return fail('Invalid owned-process message')
      }
      const payloadBase64 = Buffer.from(JSON.stringify(message), 'utf8').toString('base64')
      const frame = Buffer.from(
        JSON.stringify({
          version: 1,
          launchId,
          direction: role,
          seq: sent,
          payloadBase64,
          macBase64: mac(role, sent, payloadBase64).toString('base64'),
        }) + '\n',
      )
      if (frame.length > frameBytes) fail('Owned-process frame limit exceeded')
      account(frame.length)
      sent++
      return frame
    },
    push(chunk) {
      healthy()
      if (!Buffer.isBuffer(chunk)) return fail('Invalid owned-process input')
      account(chunk.length)
      const records: OwnedProcessMessage[] = []
      for (let from = 0; from < chunk.length;) {
        const newline = chunk.indexOf(10, from)
        const to = newline === -1 ? chunk.length : newline
        if (length + to - from > pending.length) fail('Owned-process frame limit exceeded')
        if (newline !== -1 && length === 0) records.push(decode(chunk.subarray(from, to)))
        else {
          chunk.copy(pending, length, from, to)
          length += to - from
          if (newline !== -1) records.push(decode(pending.subarray(0, length)))
        }
        if (newline !== -1) length = 0
        from = to + 1
      }
      return records
    },
    finish() {
      if (stickyError) throw stickyError
      if (length) fail('Incomplete owned-process frame')
      finished = true
    },
  }
}

function exact(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function base64(value: unknown) {
  if (typeof value !== 'string') throw new Error()
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) throw new Error()
  return bytes
}

const uint = (value: unknown) =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  !Object.is(value, -0) &&
  value >= 0 &&
  value <= 0xffffffff
const pid = (value: unknown) => uint(value) && (value as number) > 0
const birth = (value: unknown) => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value)
const handle = (value: unknown) =>
  typeof value === 'string' && /^[1-9a-f][0-9a-f]{0,7}$/.test(value)
const id = (value: unknown) =>
  typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
const mode = (value: unknown) => value === 'ordinary' || value === 'retained'
const token = (value: unknown) => typeof value === 'string' && /^[\w=.-]{1,64}$/.test(value)
const oneOf = (value: unknown, ...members: string[]) => members.includes(value as string)
const stopSignal = (value: unknown) =>
  oneOf(value, 'SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGQUIT')

type Validator = (value: unknown) => boolean
const jobBinding = { jobId: id, commitGuardId: id }
const jobRegistration = {
  jobId: id,
  jobHandle: (v: unknown) => v === null || handle(v),
  commitGuardId: (v: unknown) => v === null || id(v),
  commitGuardHandle: (v: unknown) => v === null || handle(v),
}
const recoveryCounts = {
  State: (v: unknown) => oneOf(v, 'absent', 'closed-zero'),
  Before: (v: unknown) => v === null || v === 1,
  After: (v: unknown) => v === null || v === 0,
  ActiveBefore: (v: unknown) => v === null || uint(v),
  ActiveAfter: (v: unknown) => v === null || v === 0,
}
const helper: Record<string, Record<string, Validator>> = {
  hello: { helperPid: pid, parentPid: pid, birth, parentBirth: birth },
  setup: { mode, parentBirth: birth, ...jobRegistration },
  phase: { phase: token, rootPid: (v) => v === null || pid(v), state: token },
  'root-created': { rootPid: pid },
  'root-exit': { rootPid: pid, rootExitCode: uint },
  ready: {},
  empty: {
    exitCode: uint,
    rootExitCode: (v) => v === null || uint(v),
    rootPid: (v) => v === null || pid(v),
    reason: (v) => oneOf(v, 'natural', 'stopped', 'launch-failed'),
    outputFailed: (v) => typeof v === 'boolean',
  },
  handoff: {
    exitCode: (v) => uint(v) && v === 0,
    rootExitCode: (v) => uint(v) && v === 0,
    rootPid: pid,
  },
  error: {
    code: (v) =>
      oneOf(
        v,
        'nativeQueryFailure',
        'helperFailure',
        'launchFailure',
        'parentUnavailable',
        'controlFailure',
        'protocolFailure',
      ),
  },
  brokerReady: jobBinding,
  committed: jobBinding,
  drained: jobBinding,
  released: jobBinding,
  recovered: {
    ...jobBinding,
    action: (v) => v === 'recover',
    parentPid: pid,
    parentBirth: birth,
    ...Object.fromEntries(
      ['job', 'guard'].flatMap((prefix) =>
        Object.entries(recoveryCounts).map(([field, check]) => [prefix + field, check]),
      ),
    ),
  },
}
const parent: typeof helper = {
  auth: { helperPid: pid, parentPid: pid, mode },
  registered: { ...jobRegistration, stop: (v) => v === null || stopSignal(v) },
  stop: { signal: stopSignal },
  acknowledge: {},
  grant: { ...jobBinding, action: (v) => oneOf(v, 'release', 'revoke', 'recover') },
  closeSources: jobBinding,
}

function validate(
  value: Record<string, unknown>,
  direction: Role,
): asserts value is OwnedProcessMessage & Record<string, unknown> {
  const table = direction === 'parent' ? parent : helper
  if (!value || typeof value.type !== 'string' || !Object.hasOwn(table, value.type))
    throw new Error()
  const fields = table[value.type]!
  if (
    !exact(value, ['type', ...Object.keys(fields)]) ||
    !Object.entries(fields).every(([key, check]) => check(value[key]))
  )
    throw new Error()
  if (value.type === 'empty' && (value.rootPid === null) !== (value.rootExitCode === null))
    throw new Error()
  if (value.type === 'setup' || value.type === 'registered') {
    const retained = value.jobHandle !== null
    if (
      retained !== (value.commitGuardHandle !== null) ||
      retained !== (value.commitGuardId !== null) ||
      (value.type === 'setup' && retained !== (value.mode === 'retained')) ||
      (retained &&
        (value.jobHandle === value.commitGuardHandle || value.jobId === value.commitGuardId))
    )
      throw new Error()
  }
  if (value.type === 'recovered') {
    for (const prefix of ['job', 'guard']) {
      const absent = value[prefix + 'State'] === 'absent'
      for (const field of ['Before', 'After', 'ActiveBefore', 'ActiveAfter']) {
        if ((value[prefix + field] === null) !== absent) throw new Error()
      }
    }
  }
  if ('commitGuardId' in fields && value.jobId === value.commitGuardId) throw new Error()
}
