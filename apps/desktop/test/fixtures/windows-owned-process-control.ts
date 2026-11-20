import { ChildProcess, spawn, type SpawnOptions } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import type { PrivateCompletion } from '../../src/main/owned-process-completion'
import {
  launchOwned,
  ownedLaunchControl,
  windowsAdapterLaunch,
} from '../../src/main/owned-process-launch'
import { UnconfirmedOwnedProgramError } from '../../src/main/owned-program-lifetime'
import { FixtureDeadlineError, fixtureResult, pollFixture, within } from './fixture-deadline'
import {
  fixtureNonce,
  startWitness,
  type WindowsOwnedProcessWitness,
  type WitnessProcess,
} from './windows-owned-process-witness'

type Attack = 'wrong-auth' | 'replay-auth' | 'replay-stop' | 'hold-parent'
type Exit = { code: number | null; signal: NodeJS.Signals | null }
type Verdict =
  | { state: 'pending' }
  | { state: 'resolved'; receipt: PrivateCompletion }
  | { state: 'rejected'; error: unknown }
type Peer = {
  clientPid: number
  connected: boolean
  openError: number
  peerCloseError: number
  greetingBytes: number
}
type Cleanup = {
  rootExit: 'observed' | 'absent-after-helper-exit' | 'no-launch'
  helperClosed: boolean
  nativeFixtureClosed: boolean
  witnessClosed: boolean
  socketsClosed: true
  tempRemoved: true
  heldHandleFallbacks: number
  jobLeaseRevoked: boolean
}
type HandleScan = {
  handles: number
  inspected: number
  namedPipes: number
  positivePipeMatches: number
  controlPipeMatches: number
  jobHandles: number
  jobMember: boolean
}
const pipePrefix = '\\\\.\\pipe\\'
const controlName = /^holi-owned-[a-f0-9-]{36}$/
const rootScript = fileURLToPath(
  new URL('./windows-owned-process-control-root.cjs', import.meta.url),
)

// Passively count complete frames to EOF. The production controller authenticates
// HELLO; the raw observer never interprets unauthenticated bytes as native evidence.
function readUntilEof(socket: Socket) {
  const result = fixtureResult<number>()
  let frames = 0
  let partial = 0
  let bytes = 0
  socket.on('data', (chunk: Buffer) => {
    bytes += chunk.length
    if (bytes > 32 * 1024) {
      result.settle({ error: new Error('raw helper transcript exceeded its limit') })
      return
    }
    for (const byte of chunk) {
      if (byte === 10 && partial > 0) {
        frames++
        partial = 0
      } else if (byte === 10 || ++partial >= 4096) {
        result.settle({ error: new Error('invalid raw helper framing') })
        return
      }
    }
  })
  socket.once('end', () => {
    if (partial) result.settle({ error: new Error('partial helper record at EOF') })
    else result.settle({ value: frames })
  })
  socket.once('error', (error) => result.settle({ error }))
  socket.once('close', () => {
    result.settle({ error: new Error('helper socket closed without EOF') })
  })
  return result
}

export class ControlTap {
  private target?: string
  private readonly sockets = new Map<Socket, Promise<void>>()
  private connected?: Promise<void>
  private transcript?: ReturnType<typeof readUntilEof>
  private readonly injectedWrite = fixtureResult<void>()
  private auth?: Buffer
  private replayArmed = false
  private closing?: Promise<void>
  parentConnections = 0
  injected = 0
  registered = false

  constructor(private attack?: Attack) {}

  dial(path: string, open: () => Socket, unconnected: () => Socket): Socket {
    const target = path.slice(pipePrefix.length)
    if (!path.startsWith(pipePrefix) || !controlName.test(target)) return open()
    if (this.target && this.target !== target) throw new Error('unexpected second control launch')
    this.target = target
    // The first-client case withholds only the parent dial. It doesn't substitute a
    // server or bypass the helper's kernel client-PID check.
    const socket = this.attack === 'hold-parent' ? unconnected() : open()
    const closed = new Promise<void>((resolve) => socket.once('close', resolve))
    this.sockets.set(socket, closed)
    socket.once('connect', () => {
      this.parentConnections++
      this.connected = closed
      if (this.attack === 'wrong-auth') this.transcript = readUntilEof(socket)
    })
    const write = socket.write
    socket.write = (...args: unknown[]) => {
      const [frame] = args
      if (!Buffer.isBuffer(frame)) return Reflect.apply(write, socket, args)
      const { envelope, type } = parseParentFrame(frame)
      if (type === 'registered' && envelope.seq === 1) this.registered = true
      if (this.injected !== 0) return Reflect.apply(write, socket, args)
      let replacement: Buffer | undefined
      if (this.attack === 'wrong-auth' && type === 'auth' && envelope.seq === 0) {
        const wrongKey = randomBytes(32)
        const wrongMac = createHmac('sha256', wrongKey)
          .update(`1\n${envelope.launchId}\nparent\n0\n${envelope.payloadBase64}`)
          .digest('base64')
        wrongKey.fill(0)
        if (wrongMac === envelope.macBase64) throw new Error('wrong AUTH did not change the MAC')
        replacement = Buffer.from(`${JSON.stringify({ ...envelope, macBase64: wrongMac })}\n`)
      } else if (this.attack === 'replay-auth' || this.attack === 'replay-stop') {
        if (type === 'auth' && envelope.seq === 0) this.auth = Buffer.from(frame)
        else if (type === 'stop' && envelope.seq === 2 && this.replayArmed && this.auth) {
          // Only replay actual signed bytes, at the runtime STOP. A helper ignoring
          // the replay would still see a real STOP and could otherwise return EMPTY 1.
          replacement = Buffer.concat([this.attack === 'replay-auth' ? this.auth : frame, frame])
        }
      }
      if (!replacement) return Reflect.apply(write, socket, args)
      this.injected++
      return write.call(socket, replacement, undefined, (error?: Error | null) => {
        this.injectedWrite.settle(error ? { error } : { value: undefined })
      })
    }
    return socket
  }

  leaf(): string {
    if (!this.target) throw new Error('production control transport was not captured')
    return this.target
  }

  replayInjected(): boolean {
    return this.replayArmed && this.injected === 1
  }

  armReplay(): void {
    if (this.attack !== 'replay-auth' && this.attack !== 'replay-stop') return
    if (!this.auth || !this.registered || this.injected !== 0)
      throw new Error('replay requires the original AUTH and untouched REGISTERED')
    this.replayArmed = true
  }

  injectedOnSocket(): Promise<void> {
    return this.injectedWrite.wait(
      this.attack === 'wrong-auth' ? 16_000 : 3_000,
      'injected control write',
    )
  }

  async wrongAuthClosure(): Promise<number> {
    if (!this.transcript || !this.connected) throw new Error('missing connected AUTH socket')
    const frames = await this.transcript.wait(3_000, 'wrong AUTH EOF')
    await within(this.connected, 3_000, 'wrong AUTH socket close')
    return frames
  }

  private disarm(): void {
    this.attack = undefined
    this.auth?.fill(0)
    this.auth = undefined
  }

  close(): Promise<void> {
    return (this.closing ??= this.closeSockets())
  }

  private async closeSockets(): Promise<void> {
    this.disarm()
    for (const socket of this.sockets.keys()) socket.destroy()
    await within(Promise.all(this.sockets.values()), 3_000, 'control socket close')
    this.sockets.clear()
  }
}

function parseParentFrame(bytes: Buffer) {
  try {
    const envelope = JSON.parse(bytes.toString())
    if (envelope.version !== 1 || envelope.direction !== 'parent') throw new Error()
    const { type } = JSON.parse(Buffer.from(envelope.payloadBase64, 'base64').toString())
    return { envelope, type }
  } catch {
    throw new Error('unrecognized production parent frame')
  }
}

function until<T>(read: () => T | undefined, ms: number, stage: string) {
  return pollFixture(read, performance.now() + ms, stage, 20)
}

function capture(stream: Readable | null) {
  if (!stream) throw new Error('missing fixture output stream')
  let text = ''
  let invalid = false
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    if (text.length + chunk.length > 16_384) invalid = true
    if (!invalid) text += chunk
  })
  stream.on('error', () => (invalid = true))
  return () => {
    if (invalid) throw new Error('fixture output errored or exceeded its limit')
    return text
  }
}

function observe(child: ChildProcess) {
  const closed = new Promise<Exit>((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })),
  )
  const exit = fixtureResult<void>()
  child.once('exit', () => exit.settle({ value: undefined }))
  return {
    child,
    closed,
    exit,
    exited: () => exit.current !== undefined,
    stdout: capture(child.stdout),
  }
}

async function ensureClosed(process: ReturnType<typeof observe>, ms: number): Promise<number> {
  try {
    await within(process.closed, ms, 'child close')
    return 0
  } catch (error) {
    if (!(error instanceof FixtureDeadlineError)) throw error
    const { child } = process
    const wasLive = child.exitCode === null && child.signalCode === null
    if (wasLive && !ChildProcess.prototype.kill.call(child, 'SIGKILL'))
      throw new Error('stable child handle termination failed')
    await within(process.closed, 3_000, 'stable child teardown')
    return Number(wasLive)
  }
}

function parseLine(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value as Record<string, unknown>
  } catch {
    throw new Error('malformed private fixture record')
  }
}

function integer(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`invalid native observation: ${key}`)
  return value
}

function boolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key]
  if (typeof value !== 'boolean') throw new Error(`invalid native observation: ${key}`)
  return value
}

export class ControlFixture {
  private readonly dir = mkdtempSync(join(tmpdir(), 'holi-native-control-'))
  private readonly nonce = fixtureNonce()
  private readonly powershell = windowsAdapterLaunch(process.env).file
  private readonly rootImage = resolve(process.execPath)
  private witness?: WindowsOwnedProcessWitness
  private identity?: WitnessProcess
  private heldHelper?: WitnessProcess
  private nativeHelperBirth?: string
  private helper?: ReturnType<typeof observe> & { stderr: () => string }
  private native?: ReturnType<typeof observe>
  private nativeReply = 1 // First complete line is the readiness marker.
  private control?: NonNullable<ReturnType<typeof ownedLaunchControl>>
  private retained = false
  private closing?: Promise<Cleanup>
  private status: Verdict = { state: 'pending' }
  private completion?: Promise<Verdict>

  constructor(readonly tap: ControlTap) {}

  async prepareWitness(): Promise<void> {
    if (this.witness) return
    this.witness = await startWitness({ powershellPath: this.powershell, deadlineMs: 10_000 })
    // Readiness prewarms compilation; the test runner is not a cleanup target.
  }

  async prepareNative(): Promise<void> {
    if (this.native) return
    const source = readFileSync(
      new URL('./windows-owned-process-control-native.ps1', import.meta.url),
      'utf8',
    )
    const bundled = gzipSync(source).toString('base64')
    const bootstrap = `$b=[Convert]::FromBase64String('${bundled}');$m=[IO.MemoryStream]::new($b);$g=[IO.Compression.GzipStream]::new($m,[IO.Compression.CompressionMode]::Decompress);$r=[IO.StreamReader]::new($g,[Text.Encoding]::UTF8);& ([ScriptBlock]::Create($r.ReadToEnd()))`
    const child = spawn(
      this.powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', bootstrap],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    )
    let spawnError: NodeJS.ErrnoException | undefined
    child.on('error', (error) => (spawnError = error))
    child.stdin.on('error', () => undefined)
    const native = (this.native = observe(child))
    const stderr = capture(child.stderr)
    await until(
      () => {
        if (spawnError) throw spawnError
        if (/^ready\r?\n/.test(native.stdout())) return true
        // Do not report the encoded bootstrap or a raw PowerShell error record.
        const compilerId = /\bCS\d{4}\b/.exec(stderr())?.[0]
        if (compilerId) throw new Error(`native fixture compile failed (${compilerId})`)
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(
            `native fixture exited before readiness (${child.exitCode ?? child.signalCode})`,
          )
      },
      15_000,
      'native fixture readiness',
    )
  }

  launch(
    mode: 'held' | 'spoof' | 'inspect' = 'held',
    session: 'ordinary' | 'retained' = 'ordinary',
  ): void {
    const args = [rootScript, this.dir, this.nonce, mode]
    const options: SpawnOptions = {
      cwd: this.dir,
      stdio: [mode === 'inspect' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    }
    this.retained = session === 'retained'
    if (!this.witness && !this.native) throw new Error('prepare a stable helper observer first')
    const child = launchOwned(
      { file: this.rootImage, args, verbatim: false },
      options,
      process.pid,
      this.retained,
      undefined,
      {
        pauseAuth: async ({ pid, birth }) => {
          if (pid !== child.pid) throw new Error('HELLO did not name the launched helper')
          if (this.witness) {
            this.heldHelper = await this.witness.pin({ pid, expectedImage: this.powershell, birth })
            if (await this.witness.exited(this.heldHelper.id))
              throw new Error('HELPER exited before AUTH')
          } else await this.holdNativeHelper(pid, birth)
        },
        beforeJoin: async () => {
          if (!this.tap.replayInjected() || !this.helper) return
          // On authenticated ERROR the retained lease immediately starts its
          // producer join. Let the Helper finish its own rejection before that
          // join disconnects and kills it; the controller's stop watchdog stays armed.
          try {
            await this.helper.exit.wait(5_000, 'replay helper native exit')
          } catch (error) {
            if (!(error instanceof FixtureDeadlineError)) throw error
            // If it failed to exit, let the original join force cleanup. The
            // assertion still requires unforced exit 125, not fallback termination.
          }
        },
      },
    )
    child.on('error', () => undefined)
    this.helper = { ...observe(child), stderr: capture(child.stderr) }
    this.control = ownedLaunchControl(child)
    if (!child.ownedCompletion || !child.pid || !this.control)
      throw new Error('production owned launch did not start')
    this.completion = child.ownedCompletion.then(
      (receipt) => (this.status = { state: 'resolved', receipt }),
      (error: unknown) => (this.status = { state: 'rejected', error }),
    )
  }

  async holdRoot(): Promise<number> {
    if (!this.witness || !this.helper || !this.control)
      throw new Error('fixture not ready to pin root')
    const parentPid = this.helper.child.pid
    const { control } = this
    const helperIdentity = await within(control.identity, 15_000, 'authenticated helper HELLO')
    if (helperIdentity.pid !== parentPid || this.heldHelper?.birth !== helperIdentity.birth)
      throw new Error('helper HELLO did not match the pre-AUTH held process')
    const pid = await until(
      () => {
        if (this.status.state !== 'pending')
          throw new Error('completion settled before root readiness')
        const ready = this.rootMarker('root-ready')
        const { rootPid, helperLastPhase, rootState } = control.diagnostics()
        if (
          ready !== undefined &&
          rootPid === ready &&
          helperLastPhase === 'after-root-resume' &&
          rootState === 'running'
        )
          return ready
      },
      12_000,
      'root readiness',
    )
    if (!this.tap.registered || this.tap.parentConnections !== 1)
      throw new Error('authenticated root lacked its original parent registration')
    if (this.rootMarker('root-started') !== pid) throw new Error('missing root start marker')
    this.identity = await this.witness.pin({
      pid,
      expectedImage: this.rootImage,
      nonce: this.nonce,
      parentPid,
    })
    if (!(await this.rootAlive())) throw new Error('witness root is not live')
    if (BigInt(this.identity.birth) < BigInt(helperIdentity.birth))
      throw new Error('pinned root predates authenticated helper')
    this.tap.armReplay()
    return pid
  }

  async rootAlive(): Promise<boolean> {
    if (!this.witness || !this.identity) throw new Error('root identity is not pinned')
    return !(await this.witness.exited(this.identity.id))
  }

  private rootMarker(name: 'root-started' | 'root-ready'): number | undefined {
    let text: string
    try {
      text = readFileSync(join(this.dir, name), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const marker = parseLine(text)
    const pid = integer(marker, 'pid')
    if (pid === 0 || marker.nonce !== this.nonce) throw new Error('root marker identity mismatch')
    return pid
  }

  rootStarted(): boolean {
    return (
      this.control?.diagnostics().rootStarted === true ||
      this.rootMarker('root-started') !== undefined
    )
  }

  current(): Verdict['state'] {
    return this.status.state
  }

  output(): { stdout: string; stderr: string } {
    if (!this.helper) throw new Error('no owned helper')
    return { stdout: this.helper.stdout(), stderr: this.helper.stderr() }
  }

  async waitForOutput(stdoutPrefix: string, stderrPrefix: string): Promise<void> {
    await until(
      () => {
        if (this.status.state !== 'pending')
          throw new Error('completion settled while collecting child output')
        const { stdout, stderr } = this.output()
        if (stdout.startsWith(stdoutPrefix) && stderr.startsWith(stderrPrefix)) return true
      },
      4_000,
      'stdio lookalikes',
    )
  }

  stop(): boolean {
    if (!this.helper) throw new Error('no owned helper to stop')
    return this.helper.child.kill('SIGTERM')
  }

  async result() {
    if (!this.completion || !this.helper) throw new Error('no owned completion')
    const verdict = await within(this.completion, 8_000, 'original owned completion')
    if (!this.control) throw new Error('missing original owned control')
    await within(this.control.joinControlClose(), 3_000, 'original control close')
    const exit = await within(this.helper.closed, 8_000, 'owned helper close')
    if (!this.helper.exited()) throw new Error('no native helper exit observed')
    return { verdict, exit }
  }

  helperExitCode(): Promise<number> {
    if (!this.heldHelper || !this.witness) throw new Error('helper identity is not pinned')
    return this.witness.exitCode(this.heldHelper.id)
  }

  originalUnconfirmed(verdict: Verdict): UnconfirmedOwnedProgramError {
    if (
      !this.control ||
      verdict.state !== 'rejected' ||
      !(verdict.error instanceof UnconfirmedOwnedProgramError) ||
      verdict.error.lease !== this.control.lease
    )
      throw new Error('original owned completion did not reject with its own cleanup lease')
    return verdict.error
  }

  async injectedOnSocket() {
    if (!this.completion) throw new Error('no original control completion')
    const failureBeforeWrite = this.completion.then((verdict) => {
      if (this.tap.injected === 0) {
        if (verdict.state === 'rejected') throw verdict.error
        throw new Error('original completion settled before the injection')
      }
    })
    // Do not let a setup or HELLO failure masquerade as a write deadline. Once
    // injected, the actual write callback is still required for evidence.
    const write = this.tap.injectedOnSocket()
    await Promise.race([write, failureBeforeWrite.then(() => write)])
  }

  async wrongAuthClosure() {
    if (!this.control || !this.helper) throw new Error('no owned helper')
    // Authenticate the single greeting with the original launch's verifier, not
    // the raw frame counter or the process exit code.
    const hello = await within(this.control.identity, 3_000, 'wrong AUTH helper HELLO')
    if (
      hello.pid !== this.helper.child.pid ||
      this.nativeHelperBirth !== hello.birth ||
      this.tap.registered
    )
      throw new Error('unexpected admission on the wrong AUTH socket')
    return this.tap.wrongAuthClosure()
  }

  async compete(op: 'first' | 'second'): Promise<Peer> {
    if (op === 'first') {
      const pid = this.helper?.child.pid
      if (!pid) throw new Error('missing launched helper for first-client observation')
      await this.holdNativeHelper(pid) // No HELLO is possible before a rejected peer.
    }
    const record = await this.probe({ op, target: this.tap.leaf() })
    const clientPid = integer(record, 'clientPid')
    if (clientPid === process.pid || clientPid !== this.native?.child.pid)
      throw new Error('competing pipe open was not made by the distinct native client')
    return {
      clientPid,
      connected: boolean(record, 'connected'),
      openError: integer(record, 'openError'),
      peerCloseError: integer(record, 'peerCloseError'),
      greetingBytes: integer(record, 'greetingBytes'),
    }
  }

  async inspect(): Promise<HandleScan> {
    const stdin = this.helper?.child.stdin
    if (!stdin || !this.identity) throw new Error('no pinned root probe input')
    const target = this.tap.leaf()
    // This is only the Win32 pipe name, after spawn; never the launch spec or credential.
    stdin.write(`${target}\n`)
    const request = await until(
      () => {
        const line = /^probe-request:(.*)\r?\n/m.exec(this.output().stdout)?.[1]
        if (line) return parseLine(line)
      },
      4_000,
      'root probe handshake',
    )
    if (
      request.pid !== this.identity.pid ||
      request.target !== target ||
      request.positive !== `holi-test-probe-${this.nonce}`
    )
      throw new Error('root probe handshake mismatch')
    const record = await this.probe({
      op: 'inspect',
      pid: this.identity.pid,
      birth: this.identity.birth,
      target,
      positive: request.positive,
    })
    return {
      handles: integer(record, 'handles'),
      inspected: integer(record, 'inspected'),
      namedPipes: integer(record, 'namedPipes'),
      positivePipeMatches: integer(record, 'positivePipeMatches'),
      controlPipeMatches: integer(record, 'controlPipeMatches'),
      jobHandles: integer(record, 'jobHandles'),
      jobMember: boolean(record, 'jobMember'),
    }
  }

  private async holdNativeHelper(pid: number, expectedBirth?: string) {
    const { birth } = await this.probe({
      op: 'hold-helper',
      pid,
      expectedBirth,
      parentPid: process.pid,
      image: this.powershell,
    })
    if (
      typeof birth !== 'string' ||
      !/^\d{1,20}$/.test(birth) ||
      (expectedBirth && birth !== expectedBirth)
    )
      throw new Error('invalid native held helper birth')
    this.nativeHelperBirth = birth
  }

  private async rootSnapshot(): Promise<number[]> {
    await this.prepareNative()
    const { pids } = await this.probe({
      op: 'snapshot',
      image: this.rootImage,
      nonce: this.nonce,
      helperPid: this.helper?.child.pid,
    })
    if (
      !Array.isArray(pids) ||
      pids.some(
        (pid: unknown) =>
          typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff,
      )
    )
      throw new Error('invalid root snapshot')
    return pids
  }

  private async probe(request: Record<string, unknown>) {
    const native = this.native
    if (!native?.child.stdin) throw new Error('no native fixture input')
    native.child.stdin.write(`${JSON.stringify(request)}\n`)
    const reply = this.nativeReply++
    return until(
      () => {
        const lines = native.stdout().split(/\r?\n/)
        if (lines.length > reply + 1) {
          const record = parseLine(lines[reply]!)
          if (
            typeof record.error === 'string' &&
            /^[a-z][a-z0-9-]{2,40}(?::\d{1,10})?$/.test(record.error)
          )
            throw new Error(`native fixture failed: ${record.error}`)
          return record
        }
        if (native.child.exitCode !== null || native.child.signalCode !== null)
          throw new Error('native fixture exited before replying')
      },
      request.op === 'first' ? 20_000 : 5_000,
      'native fixture reply',
    )
  }

  close(): Promise<Cleanup> {
    return (this.closing ??= this.closeAndVerify())
  }

  private async closeAndVerify(): Promise<Cleanup> {
    const errors: unknown[] = []
    let heldHandleFallbacks = 0
    let rootExit: Cleanup['rootExit'] = 'no-launch'
    let jobLeaseRevoked = false
    let helperClosed = false
    let nativeFixtureClosed = false
    let witnessClosed = false
    const cleanup = async (run: () => void | Promise<void>) => {
      try {
        await run()
      } catch (error) {
        errors.push(error)
      }
    }
    const closeNative = async () => {
      if (!this.native || nativeFixtureClosed) return
      this.native.child.stdin?.end()
      heldHandleFallbacks += await ensureClosed(this.native, 2_000)
      const { code, signal } = await this.native.closed
      if (code !== 0 || signal !== null || !this.native.exited())
        throw new Error('native fixture exit was not clean')
      nativeFixtureClosed = true
    }
    // Only the handle scan can hold duplicated root handles. Close that inspector
    // before verifying exit. An unpinned launch still needs its read-only snapshot.
    if (this.identity) await cleanup(closeNative)
    await cleanup(async () => {
      if (!this.helper) return
      if (!this.helper.exited()) this.helper.child.kill('SIGTERM')
      heldHandleFallbacks += await ensureClosed(this.helper, 6_000)
      if (!this.helper.exited()) throw new Error('helper closed without a native exit')
      helperClosed = true
    })
    await cleanup(() => this.tap.close())
    if (this.control)
      await cleanup(() => within(this.control!.joinControlClose(), 3_000, 'original control close'))
    await cleanup(async () => {
      // Also join the original lease for a failure before REGISTERED: AUTH can
      // already have allowed the helper to duplicate a parent Job handle.
      if (!this.retained || !this.control) return
      await within(this.control.lease.revoke(), 22_000, 'original Job lease drain')
      jobLeaseRevoked = true
    })
    await cleanup(async () => {
      if (this.identity && this.witness) {
        const { witness } = this
        const id = this.identity.id
        const waitForRootExit = (deadline: number) =>
          pollFixture(
            async () => (await witness.exited(id)) || undefined,
            deadline,
            'pinned root exit',
            20,
          )
        // Only the grace deadline, not an observer failure, permits termination.
        try {
          await waitForRootExit(performance.now() + 3_000)
        } catch (error) {
          if (!(error instanceof FixtureDeadlineError) || error.stage !== 'pinned root exit')
            throw error
          await witness.terminate(id)
          heldHandleFallbacks++
          await waitForRootExit(performance.now() + 3_000)
        }
        rootExit = 'observed'
      } else if (this.helper) {
        if (!helperClosed) throw new Error('unconfirmed helper exit; cannot certify root absence')
        // No phase or sentinel alone excludes a suspended root. Query after
        // helper exit so it cannot admit another process after the snapshot.
        const matches = await this.rootSnapshot()
        if (matches.length !== 0) {
          if (matches.length !== 1) throw new Error('ambiguous nonce-bearing root snapshot')
          await this.prepareWitness()
          // Re-verify the snapshot's PID through a handle before any cleanup.
          const witness = this.witness!
          const root = await witness.pin({
            pid: matches[0]!,
            expectedImage: this.rootImage,
            nonce: this.nonce,
          })
          await witness.terminate(root.id)
          await pollFixture(
            async () => (await witness.exited(root.id)) || undefined,
            performance.now() + 3_000,
            'snapshot root exit',
            20,
          )
          throw new Error('nonce-bearing root survived helper exit')
        }
        if (this.rootStarted()) throw new Error('started root was not pinned for exit verification')
        if (!this.nativeHelperBirth || this.tap.registered)
          throw new Error('missing pre-admission helper identity')
        const helperExit = await this.probe({ op: 'helper-exit' })
        if (integer(helperExit, 'code') !== (await this.helper.closed).code)
          throw new Error('held helper DWORD disagrees with observed close')
        rootExit = 'absent-after-helper-exit'
      }
    })
    if (!this.identity) await cleanup(closeNative)
    await cleanup(async () => {
      if (this.heldHelper && this.witness && !(await this.witness.exited(this.heldHelper.id)))
        throw new Error('held helper still running after close')
    })
    await cleanup(async () => {
      if (!this.witness) return
      await within(this.witness.close(), 22_000, 'process witness close')
      witnessClosed = true
    })
    if (errors.length) throw new AggregateError(errors, 'native control fixture cleanup unverified')
    rmSync(this.dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 })
    return {
      rootExit,
      helperClosed,
      nativeFixtureClosed,
      witnessClosed,
      socketsClosed: true,
      tempRemoved: true,
      heldHandleFallbacks,
      jobLeaseRevoked,
    }
  }
}
