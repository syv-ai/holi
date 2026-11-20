import { spawn } from 'node:child_process'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { connect } from 'node:net'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect } from 'vitest'
import { ownedJobLease } from '../../src/main/owned-process-broker'
import { windowsAdapterLaunch } from '../../src/main/owned-process-launch'
import {
  createOwnedProtocol,
  type OwnedProcessMessage,
} from '../../src/main/owned-process-protocol'
import {
  fixtureChild,
  fixtureChildAlive,
  fixtureResult,
  pollFixture,
  stopFixtureChild,
  withFixtureCleanup,
  within,
} from './fixture-deadline'
import {
  fixtureNonce,
  startWitness,
  type WindowsOwnedProcessWitness,
} from './windows-owned-process-witness'

const teardownMs = 5_000
const nodeImage = resolve(process.execPath)

type NativeRecord<T extends OwnedProcessMessage['type']> = Extract<OwnedProcessMessage, { type: T }>

// Exercise the real Windows PowerShell producer. Only the parent commands are raw;
// the helper's transcript must pass the normal authenticated decoder through EOF.
// Callers that start without a witness still own cleanup, even before opening the pipe.
export function startRawProducer({
  parentPid = process.pid,
  rootExitGate,
  parentBarrier = false,
  missingExecutable,
}: {
  parentPid?: number
  rootExitGate?: string
  parentBarrier?: boolean
  missingExecutable?: string
} = {}) {
  const launchId = randomUUID()
  const secret = randomBytes(32)
  const nonce = fixtureNonce()
  const controlPipe = `holi-owned-${randomUUID()}`
  const retain = rootExitGate !== undefined
  const mode = retain ? 'retained' : 'ordinary'
  const jobs = retain ? { jobId: randomUUID(), commitGuardId: randomUUID() } : undefined
  const job = ownedJobLease({
    prepared: jobs && { ...jobs, launchId, secret, parentPid },
    joinProducer: async () => {
      socket?.destroy()
      await stopFixtureChild(child, teardownMs, 'raw native helper')
    },
  })
  const adapter = windowsAdapterLaunch(process.env)
  const child = spawn(adapter.file, adapter.args, {
    cwd: adapter.cwd,
    env: adapter.env,
    windowsHide: true,
  })
  const observed = fixtureChild(child)
  const helperExit = fixtureResult<{ helperExitCode: number | null; at: number }>()
  child.once('exit', (code) =>
    helperExit.settle({ value: { helperExitCode: code, at: performance.now() } }),
  )
  child.stdin.on('error', () => undefined)
  let stderr = ''
  if (missingExecutable) {
    // Retain enough to verify one bounded line, but never log the raw output.
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk.slice(0, 1025 - stderr.length)
    })
  } else child.stderr.resume()
  // Stdout is readiness only; authenticated records come from the private pipe.
  let stdout = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
  // The retained Root exits on a private gate so the witness holds both handles
  // before READY. The grandchild inherits neither relay pipe and outlives the Root.
  const root = retain
    ? `const fs=require('node:fs');const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)',process.argv[1]],{stdio:'ignore',detached:true,windowsHide:true});c.once('spawn',()=>{console.log('root-ready:'+process.pid+'\\ngrandchild-ready:'+c.pid);c.unref();setInterval(()=>{if(fs.existsSync(${JSON.stringify(rootExitGate)}))process.exit(0)},20)})`
    : 'console.log("root-ready:"+process.pid);setInterval(()=>{},1000)'
  child.stdin.end(
    JSON.stringify({
      launchId,
      secret: secret.toString('base64'),
      controlPipe,
      parentPid,
      bin: missingExecutable ?? process.execPath,
      args: ['-e', root, nonce],
      cwd: process.cwd(),
      env: process.env,
      retainDescendantsOnSuccess: retain,
      ...jobs,
      ...(parentBarrier ? { testParentReady: true } : {}),
      stdoutMarker: 'raw-stdout-marker',
      stderrMarker: 'raw-stderr-marker',
    }) + '\n',
  )
  const wire = createOwnedProtocol({ launchId, secret, role: 'parent' })
  const records: OwnedProcessMessage[] = []
  const receivedAt = new Map<OwnedProcessMessage, number>()
  let release: Promise<void> | undefined
  let registered = false
  let connectAttempts = 0
  let writes = 0
  let localClose = false
  let socket: ReturnType<typeof connect> | undefined
  const socketClose = fixtureResult<void>()
  let wireFinished = false
  let socketEof = false
  let wireFailure: unknown
  const held = new Map<
    'helper' | 'root' | 'grandchild',
    { pid: number; exited: () => Promise<boolean> }
  >()

  async function open() {
    const path = `\\\\.\\pipe\\${controlPipe}`
    const deadline = performance.now() + 8_000
    while (!socket) {
      const remaining = deadline - performance.now()
      if (remaining <= 0) throw new Error('raw native control connect deadline exceeded')
      connectAttempts++
      const candidate = connect(path)
      const connected = fixtureResult<boolean>()
      const closed = fixtureResult<void>()
      const onError = () => connected.settle({ value: false })
      candidate.once('connect', () => connected.settle({ value: true }))
      candidate.on('error', onError)
      candidate.once('close', () => closed.settle({ value: undefined }))
      try {
        if (await connected.wait(remaining, 'raw native connect attempt')) socket = candidate
      } finally {
        if (!socket) {
          candidate.destroy()
          await closed.wait(teardownMs, 'raw native connect attempt close')
        }
        candidate.off('error', onError)
      }
      if (!socket) await delay(25)
    }
    socket.on('error', (error: NodeJS.ErrnoException) => {
      wireFailure ??= new Error(`raw native control socket error (${error.code ?? 'unknown'})`)
    })
    socket.on('data', (chunk: Buffer) => {
      try {
        for (const record of wire.push(chunk)) {
          records.push(record)
          receivedAt.set(record, performance.now())
        }
      } catch (error) {
        wireFailure ??= error
      }
    })
    function finishWire() {
      try {
        wire.finish()
        wireFinished = true
      } catch (error) {
        wireFailure ??= error
      }
    }
    socket.once('end', () => {
      socketEof = true
      finishWire()
    })
    socket.once('close', () => {
      if (!socketEof) finishWire() // Includes the deliberate local EOF case.
      socketClose.settle({ value: undefined })
    })
  }

  async function record<T extends OwnedProcessMessage['type']>(type: T, index?: number) {
    return pollFixture(
      () => {
        if (wireFailure) throw wireFailure
        const message =
          index === undefined ? records.find((item) => item.type === type) : records[index]
        if (message && message.type !== type)
          throw new Error(`expected native ${type}, received ${message.type}`)
        return message as NativeRecord<T> | undefined
      },
      performance.now() + 3_000,
      `native ${type}`,
      20,
    )
  }

  async function pin(
    witness: WindowsOwnedProcessWitness,
    role: 'root' | 'grandchild',
    parentPid: number,
  ) {
    const readiness = new RegExp(`^${role}-ready:(\\d+)\\r?$`, 'm')
    const pid = await pollFixture(
      () => {
        const match = readiness.exec(stdout)
        if (match) return Number(match[1])
      },
      performance.now() + 3_000,
      `raw native ${role} readiness`,
      20,
    )
    const identity = await witness.pin({ pid, expectedImage: nodeImage, nonce, parentPid })
    const process = { pid: identity.pid, exited: () => witness.exited(identity.id) }
    held.set(role, process)
    expect(await process.exited()).toBe(false)
    return process
  }

  async function hello(witness: WindowsOwnedProcessWitness) {
    await open()
    const message = await record('hello', 0)
    expect(message).toMatchObject({ helperPid: child.pid, parentPid })
    const identity = await witness.pin({
      pid: message.helperPid,
      birth: message.birth,
      expectedImage: adapter.file,
    })
    const exited = () => witness.exited(identity.id)
    held.set('helper', { pid: identity.pid, exited })
    expect(await exited()).toBe(false)
    return message
  }

  async function send(frame: Buffer) {
    if (!socket || socket.destroyed || socketEof || localClose || !socket.writable)
      throw new Error('raw parent write without an open control pipe')
    if (wireFailure) throw wireFailure
    const at = performance.now()
    await within(
      new Promise<void>((resolve, reject) => {
        socket!.write(frame, (error) => (error ? reject(error) : resolve()))
      }),
      teardownMs,
      'raw parent write',
    )
    writes++
    return at
  }

  return {
    helperAlive: () => fixtureChildAlive(child),
    open,
    hello,
    send,
    record,
    encode: wire.encode,
    get records(): readonly OwnedProcessMessage[] {
      return records
    },
    receivedAt: (record: OwnedProcessMessage) => receivedAt.get(record)!,
    writes: () => writes,
    bytesWritten: () => socket?.bytesWritten ?? 0,
    connectAttempts: () => connectAttempts,
    stdout: () => stdout,
    stderr: () => stderr,
    closeParentEnd() {
      localClose = true
      socket?.destroy()
    },
    async exit(code: number, timeout = 6_500) {
      const deadline = performance.now() + timeout
      const exit = await helperExit.wait(timeout, 'raw native helper exit')
      expect(exit.helperExitCode).toBe(code)
      expect(
        await observed.join(Math.max(1, deadline - performance.now()), 'raw native helper'),
      ).toBe(code)
      if (socket) {
        await socketClose.wait(
          Math.max(1, deadline - performance.now()),
          'raw native control close',
        )
        if (wireFailure) throw wireFailure
        expect(wireFinished).toBe(true)
        expect(socketEof).toBe(!localClose)
      }
      return exit
    },
    async holdRoot(witness: WindowsOwnedProcessWitness) {
      const nativeRoot = await pollFixture(
        () => {
          if (wireFailure) throw wireFailure
          return records.find(
            (r): r is NativeRecord<'phase'> =>
              r.type === 'phase' && r.phase === 'after-root-resume',
          )
        },
        performance.now() + 3_000,
        'raw native Root resumed',
        20,
      )
      const root = await pin(witness, 'root', child.pid!)
      expect(root.pid).toBe(nativeRoot.rootPid)
      expect(records.filter(({ type }) => type === 'root-created')).toEqual([
        { type: 'root-created', rootPid: root.pid },
      ])
      return root
    },
    holdGrandchild: (witness: WindowsOwnedProcessWitness, rootPid: number) =>
      pin(witness, 'grandchild', rootPid),
    async auth(witness: WindowsOwnedProcessWitness) {
      const { helperPid, parentPid, birth, parentBirth } = await hello(witness)
      if (retain) job.bindForAuth(parentBirth)
      await send(wire.encode({ type: 'auth', helperPid, parentPid, mode }))
      const setup = await record('setup', 1)
      expect(setup.mode).toBe(mode)
      expect(setup.parentBirth).toBe(parentBirth)
      expect(BigInt(setup.parentBirth) <= BigInt(birth)).toBe(true)
      if (retain) {
        if (setup.mode !== 'retained') throw new Error('retained SETUP missing native Job handles')
        job.adopt(setup)
        registered = true
      } else {
        expect(setup.jobHandle).toBeNull()
        expect(setup.commitGuardId).toBeNull()
        expect(setup.commitGuardHandle).toBeNull()
      }
      const { mode: _mode, parentBirth: _birth, ...binding } = setup
      await send(wire.encode({ ...binding, type: 'registered', stop: null }))
      return setup
    },
    rawPayload(payload: Buffer, seq: number) {
      const payloadBase64 = payload.toString('base64')
      const macBase64 = createHmac('sha256', secret)
        .update(`1\n${launchId}\nparent\n${seq}\n${payloadBase64}`)
        .digest('base64')
      return Buffer.from(
        JSON.stringify({
          version: 1,
          launchId,
          direction: 'parent',
          seq,
          payloadBase64,
          macBase64,
        }) + '\n',
      )
    },
    releaseVerifiedEmpty(empty: NativeRecord<'empty'>) {
      if (!registered || !wireFinished || records.at(-1) !== empty)
        throw new Error('cannot release without a joined native EMPTY')
      release = job.releaseEmpty()
    },
    async cleanup() {
      let jobReleased: true | null = null
      await withFixtureCleanup(
        async () => {
          await withFixtureCleanup(
            async () => {
              socket?.destroy()
              if (socket) await socketClose.wait(teardownMs, 'raw native fixture socket close')
            },
            () => stopFixtureChild(child, teardownMs, 'raw native helper'),
          )
        },
        async () => {
          if (release) {
            await within(release, 22_000, 'release verified empty native Job')
            jobReleased = true
          } else if (job.authMayHaveBeenSent) {
            await within(job.lease.revoke(), 22_000, 'revoke original native Job')
          }
        },
      )
      const exited = async (role: 'helper' | 'root' | 'grandchild') => {
        const process = held.get(role)
        if (!process) return null
        return pollFixture(
          async () => (await process.exited()) || undefined,
          performance.now() + teardownMs,
          `held ${role} exit`,
          20,
        )
      }
      return {
        helperClosed: true,
        socketClosed: socket ? !!socketClose.current : null,
        socketEof: socket ? socketEof : null,
        wireFinished: socket ? wireFinished : null,
        helperHandleExited: await exited('helper'),
        rootHandleExited: await exited('root'),
        grandchildHandleExited: await exited('grandchild'),
        jobReleased,
      }
    },
  }
}

export type RawProducer = ReturnType<typeof startRawProducer>
export type RawCleanup = Awaited<ReturnType<RawProducer['cleanup']>>

export async function withRawProducer<T>(
  body: (producer: RawProducer, witness: WindowsOwnedProcessWitness) => Promise<T>,
  rootExitGate?: string,
  missingExecutable?: string,
) {
  const witness = await startWitness()
  const result = await withFixtureCleanup(
    async () => {
      const producer = startRawProducer({ rootExitGate, missingExecutable })
      let cleanup!: RawCleanup
      const proof = await withFixtureCleanup(
        () => body(producer, witness),
        async () => {
          cleanup = await producer.cleanup()
        },
      )
      return { proof, cleanup }
    },
    () => witness.close(),
  )
  return {
    proof: result.proof,
    cleanup: { ...result.cleanup, witnessClosed: true as const, parentClosed: null },
  }
}
