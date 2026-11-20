import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { getSystemErrorName, promisify } from 'node:util'
import { describe, expect, it, onTestFailed } from 'vitest'
import { launchPlan } from '../src/main/launch'
import { spawnOwnedProgram } from '../src/main/owned-process'
import { ownedLaunchControl, spawnOwnedLaunch } from '../src/main/owned-process-launch'
import {
  spawnOwnedLaunchWithHandoffFault,
  spawnOwnedLaunchWithNativeQueryFault,
} from './owned-process-test-adapter'
import { joinOwnedProgram } from '../src/main/owned-program-lifetime'
import {
  fixtureChild,
  fixtureChildAlive,
  fixtureResult,
  pollFixture,
  stopFixtureChild,
  withFixtureCleanup,
  within,
} from './fixtures/fixture-deadline'
import {
  startRawProducer,
  withRawProducer,
  type RawCleanup,
  type RawProducer,
} from './fixtures/windows-owned-process-producer'
import {
  fixtureNonce,
  startWitness,
  type WindowsOwnedProcessWitness,
} from './fixtures/windows-owned-process-witness'
import {
  rejectedStatusReceipt,
  statusCaseMs,
  statusWaitMs,
  withStatusProducer,
  type StatusCleanup,
} from './fixtures/windows-owned-process-status'

const windows = process.platform === 'win32'

const teardownMs = 5_000
const nodeImage = resolve(process.execPath)

function waitForFile(file: string) {
  return pollFixture(
    () =>
      readFile(file, 'utf8').catch((error) => {
        if (error.code !== 'ENOENT') throw error
        return undefined
      }),
    performance.now() + 10_000,
    `fixture handshake at ${file}`,
    20,
  )
}

function diagnostics(child: ReturnType<typeof spawnOwnedProgram>): void {
  fixtureChild(child)
  child.stderr?.resume()
  onTestFailed(() => {
    console.error(
      `[owned-process test failure] pid=${child.pid ?? 'none'} exitCode=${child.exitCode} signalCode=${child.signalCode} lastPhase=${ownedLaunchControl(child)?.diagnostics().helperLastPhase ?? 'none'}`,
    )
  })
}

async function cleanup(
  child: ChildProcess & { ownedCompletion?: Promise<unknown> },
  proof: 'empty' | 'expected-launch-failure' = 'empty',
): Promise<void> {
  const observed = fixtureChild(child)
  await withFixtureCleanup(
    async () => {
      if (fixtureChildAlive(child)) child.kill('SIGKILL')
      // Ordinary Windows launches must prove absence with their authenticated
      // receipt. The negative launch cases expect no such receipt and still
      // must observe actual helper exit and close.
      if (windows && proof === 'empty') {
        if (!child.ownedCompletion) throw new Error('missing owned cleanup receipt')
        expect(await within(child.ownedCompletion, teardownMs, 'managed cleanup receipt')).toBe(
          'empty',
        )
      }
      await observed.join(teardownMs, 'owned helper')
    },
    async () => {
      if (fixtureChildAlive(child))
        await stopFixtureChild(child, teardownMs, 'owned helper after stable-handle termination')
      else await observed.join(teardownMs, 'owned helper')
    },
  )
}

function completion(child: ChildProcess) {
  const done = fixtureChild(child).completion.wait(20_000, 'child completion')
  void done.catch(() => undefined) // Some cases await the receipt before awaiting completion.
  return done
}

async function withWitness(body: (witness: WindowsOwnedProcessWitness) => Promise<void>) {
  const witness = await startWitness()
  await withFixtureCleanup(
    () => body(witness),
    () => witness.close(),
  )
}

describe('spawnOwnedProgram', () => {
  const queryFaultCase = 'fails closed when the native job query handle is invalid'
  it.skipIf(!windows)(
    queryFaultCase,
    async () => {
      const { proof, cleanup } = await withStatusProducer({ tree: true }, async (fixture) => {
        const { child, control, original } = fixture.start(() =>
          spawnOwnedLaunchWithNativeQueryFault(
            launchPlan(fixture.nodeImage, fixture.treeArgs, { platform: 'win32' }),
            { cwd: fixture.dir, stdio: ['ignore', 'pipe', 'pipe'] },
            process.pid,
          ),
        )
        await fixture.holdRoot()
        const rootAliveBeforeRelease = !(await fixture.exited('root'))
        const grandchildAliveBeforeRelease = !(await fixture.exited('grandchild'))
        expect(rootAliveBeforeRelease && grandchildAliveBeforeRelease).toBe(true)
        await fixture.mark('release-0')
        const { receipt, error, sameReceipt, sameLease } = await rejectedStatusReceipt(
          child,
          original,
        )
        if (!(error.cause instanceof Error)) throw new Error('missing authenticated query cause')
        expect(error.cause.message).toBe('owned helper reported nativeQueryFailure')
        const nativeError = error.cause.message.slice('owned helper reported '.length)
        const { helperExitCode } = await fixture.helperStatus()
        const rootExitCode = await fixture.exitCode('root')
        const grandchildExitCode = await fixture.exitCode('grandchild')
        expect(helperExitCode).toBe(125)
        expect(rootExitCode).toBe(0)
        expect(grandchildExitCode).toBe(1)
        // No registered duplicate in ordinary mode. Physical fixture exits must
        // not replace the failed native query or upgrade the original lease.
        const revokeRejectedWithOriginalFailure = await within(
          control.lease.revoke().then(
            () => false,
            (failure: unknown) => failure === error,
          ),
          statusWaitMs,
          'original query-fault lease',
        )
        expect(revokeRejectedWithOriginalFailure).toBe(true)
        return {
          kind: 'query-fault' as const,
          receipt,
          sameReceipt,
          sameLease,
          nativeError,
          helperExitCode,
          rootExitCode,
          grandchildExitCode,
          rootAliveBeforeRelease,
          grandchildAliveBeforeRelease,
          revokeRejectedWithOriginalFailure,
        }
      })
      producerProof(queryFaultCase, proof, cleanup)
    },
    statusCaseMs,
  )

  it.skipIf(!windows)('authenticates empty completion for a successful root', async () => {
    const child = spawnOwnedProgram(
      process.execPath,
      ['-e', 'process.stdout.write("native-empty")'],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    diagnostics(child)
    const done = completion(child)
    let output = ''
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => (output += chunk))
    try {
      expect(child.ownedCompletion).toBeDefined()
      await expect(within(child.ownedCompletion!, teardownMs, 'empty receipt')).resolves.toBe(
        'empty',
      )
      expect(await done).toBe(0) // `close` joins output, the owned receipt alone does not.
      expect(output).toBe('native-empty')
    } finally {
      await cleanup(child)
    }
  })

  it.skipIf(!windows)('settles ordinary roots only after empty owned completion', async () => {
    for (const exitCode of [0, 37]) {
      const child = spawnOwnedProgram(process.execPath, [`-e`, `process.exit(${exitCode})`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      diagnostics(child)
      const done = completion(child)
      const receipt = child.ownedCompletion
      try {
        expect(receipt).toBeDefined()
        expect(await within(receipt!, teardownMs, 'ordinary root empty receipt')).toBe('empty')
        expect(child.ownedCompletion).toBe(receipt)
        expect(await receipt).toBe('empty')
        expect(await done).toBe(exitCode)
      } finally {
        await cleanup(child)
      }
    }
  })

  it('preserves exact argv and output', async () => {
    for (const cwd of [undefined, '.', pathToFileURL(process.cwd() + sep)]) {
      const args = ['one two', '', '☃', 'one\r\ntwo', 'q"uote', 'x'.repeat(12_000)]
      const child = spawnOwnedProgram(
        process.execPath,
        [
          '-e',
          'process.stdout.write(JSON.stringify({ args: process.argv.slice(1), cwd: process.cwd() }))',
          '--',
          ...args,
        ],
        {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, ...(windows ? { HOLI_OWNED_PROCESS_TRACE: '1' } : {}) },
        },
      )
      let error = ''
      child.stderr!.setEncoding('utf8').on('data', (chunk: string) => (error += chunk))
      diagnostics(child)
      const done = completion(child)
      let output = ''
      child.stdout!.setEncoding('utf8').on('data', (chunk: string) => (output += chunk))
      try {
        expect(await done, error).toBe(0)
        expect(JSON.parse(output)).toEqual({ args, cwd: process.cwd() })
      } finally {
        await cleanup(child)
      }
    }
  })

  it.skipIf(!windows)('creates a console root without a visible console', async () => {
    await withWitness(async (witness) => {
      const nonce = fixtureNonce()
      const child = spawnOwnedProgram(
        nodeImage,
        ['-e', 'console.log(process.pid);setInterval(()=>0,1000)', nonce],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      fixtureChild(child)
      await withFixtureCleanup(
        async () => {
          let output = ''
          child.stdout!.setEncoding('utf8').on('data', (chunk: string) => (output += chunk))
          child.stderr!.resume()
          const pid = await pollFixture(
            () => {
              const match = /^(\d+)\r?\n/.exec(output)
              if (match) return Number(match[1])
            },
            performance.now() + 10_000,
            'console root PID',
            20,
          )
          await witness.pin({ pid, expectedImage: nodeImage, nonce, parentPid: child.pid })
          const probe = [
            'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class HoliConsoleProbe { [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid); }\'',
            `[HoliConsoleProbe]::AttachConsole(${pid})`,
          ].join('; ')
          const { stdout } = await promisify(execFile)(
            join(
              process.env.SystemRoot ?? process.env.WINDIR!,
              'System32',
              'WindowsPowerShell',
              'v1.0',
              'powershell.exe',
            ),
            ['-NoProfile', '-NonInteractive', '-Command', probe],
            { windowsHide: true, encoding: 'utf8', timeout: teardownMs },
          )
          expect(stdout.trim()).toBe('False')
        },
        () => cleanup(child),
      )
    })
  })

  it.skipIf(!windows)('resolves a relative executable against the requested cwd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holi-owned-relative-exe-'))
    const bin = join(dir, 'bin')
    await mkdir(bin)
    await copyFile(process.execPath, join(bin, 'tool.exe'))
    const child = spawnOwnedProgram(
      '.\\bin\\tool.exe',
      ['-e', 'process.stdout.write(process.cwd())'],
      { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    try {
      const done = completion(child)
      let output = ''
      child.stdout!.setEncoding('utf8').on('data', (chunk: string) => (output += chunk))
      expect(await done).toBe(0)
      expect(output).toBe(dir)
    } finally {
      await cleanup(child)
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(!windows)('does not resolve the helper from a poisoned vault cwd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holi-owned-poisoned-cwd-'))
    const poison = join(dir, 'powershell.exe')
    let child: ReturnType<typeof spawnOwnedProgram> | undefined
    try {
      await copyFile(process.execPath, poison)
      child = spawnOwnedProgram(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], {
        cwd: dir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      })
      diagnostics(child)
      const done = completion(child)
      let output = ''
      child.stdout!.setEncoding('utf8').on('data', (chunk: string) => (output += chunk))
      expect(await done).toBe(0)
      expect(output).toBe(dir)
    } finally {
      if (child) await cleanup(child)
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(!windows)('handles a missing helper without leaking stdin errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holi-owned-missing-helper-'))
    const previousSystemRoot = process.env.SystemRoot
    process.env.SystemRoot = dir
    let child: ReturnType<typeof spawnOwnedProgram> | undefined
    let childErrors = 0
    let stdinErrors = 0
    try {
      child = spawnOwnedProgram(process.execPath, ['-e', 'process.exit(0)'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      })
      child.on('error', () => childErrors++)
      child.stdin!.on('error', () => stdinErrors++)
      const original = child.ownedCompletion
      const joined = joinOwnedProgram(child, 'win32')
      await expect(completion(child)).rejects.toMatchObject({ code: 'ENOENT' })
      const code = await fixtureChild(child).join(teardownMs, 'missing helper')
      expect(getSystemErrorName(code!)).toBe('ENOENT')
      expect(original).toBeDefined()
      expect(child.ownedCompletion).toBe(original)
      expect(await within(original!, teardownMs, 'definitive missing helper receipt')).toBe(
        'not-started',
      )
      expect(await within(joined, teardownMs, 'missing helper join')).toMatchObject({
        ownership: 'not-started',
        code: null,
        signal: null,
        error: { code: 'ENOENT' },
      })
      const previousStdinErrors = stdinErrors
      child.stdin!.emit('error', Object.assign(new Error('test input failure'), { code: 'EPIPE' }))
      expect(stdinErrors).toBe(previousStdinErrors + 1)
      expect(childErrors).toBe(1)
    } finally {
      if (previousSystemRoot === undefined) delete process.env.SystemRoot
      else process.env.SystemRoot = previousSystemRoot
      await withFixtureCleanup(
        async () => {
          if (child) await cleanup(child, 'expected-launch-failure')
        },
        () => rm(dir, { recursive: true, force: true }),
      )
    }
  })

  it.skipIf(!windows).each([false, true])(
    'terminates descendants before reporting root exit (pipes: %s)',
    async (pipes) => {
      await withOwnedTree(pipes, async ({ child, dir, expectExited }) => {
        const done = completion(child)
        await writeFile(join(dir, 'exit-root'), '')
        expect(await done).toBe(23)
        await expectExited()
      })
    },
    45_000,
  )

  it.skipIf(!windows).each([false, true])(
    'stops the entire owned job and leaves no stop artifact (stdin failure: %s)',
    async (stdinFailure) => {
      await withOwnedTree(false, async ({ child, expectExited }) => {
        const done = completion(child)
        if (stdinFailure) {
          child.stdin!.emit(
            'error',
            Object.assign(new Error('test input failure'), { code: 'EPIPE' }),
          )
        } else {
          expect(child.kill('SIGTERM')).toBe(true)
          expect(child.kill('SIGKILL')).toBe(true)
        }
        expect(await done).toBe(1)
        await expectExited()
      })
    },
    45_000,
  )

  const timeoutCase = 'authenticates EMPTY when a spawn timeout stops a live native tree'
  it.skipIf(!windows)(
    timeoutCase,
    async () => {
      // Include cold PowerShell/Add-Type setup and both witness pins in the caller budget.
      const timeout = 25_000
      const { proof, cleanup } = await withStatusProducer({ tree: true }, async (fixture) => {
        const { child, control, original } = fixture.start(() =>
          spawnOwnedProgram(fixture.nodeImage, fixture.treeArgs, {
            cwd: fixture.dir,
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout,
          }),
        )
        const lease = control.lease
        const joined = joinOwnedProgram(child, 'win32')
        await fixture.holdRoot()
        const rootAliveBeforeTimeout = !(await fixture.exited('root'))
        const grandchildAliveBeforeTimeout = !(await fixture.exited('grandchild'))
        expect(rootAliveBeforeTimeout && grandchildAliveBeforeTimeout).toBe(true)
        expect(control.stopped).toBe(false)
        // The timer is the only STOP source on this path. Physical exits are
        // corroboration, not substitutes for this launch's EMPTY receipt.
        const receipt = await within(original, timeout + statusWaitMs, 'spawn timeout EMPTY')
        expect(receipt).toBe('empty')
        const sameReceipt = child.ownedCompletion === original
        const sameLease = ownedLaunchControl(child)?.lease === lease
        expect(sameReceipt && sameLease).toBe(true)
        const { helperExitCode } = await fixture.helperStatus()
        const rootExitCode = await fixture.exitCode('root')
        const grandchildExitCode = await fixture.exitCode('grandchild')
        expect([helperExitCode, rootExitCode, grandchildExitCode]).toEqual([1, 1, 1])
        const result = await within(joined, statusWaitMs, 'spawn timeout join')
        expect(result).toEqual({ ownership: 'empty', code: 1, signal: null, error: null })
        await within(lease.revoke(), statusWaitMs, 'original empty lease')
        return {
          kind: 'spawn-timeout' as const,
          receipt,
          sameReceipt,
          sameLease,
          rootAliveBeforeTimeout,
          grandchildAliveBeforeTimeout,
          helperExitCode,
          rootExitCode,
          grandchildExitCode,
          joinOwnership: result.ownership,
        }
      })
      producerProof(timeoutCase, proof, cleanup)
    },
    statusCaseMs,
  )

  it.skipIf(!windows)('fails closed when its parent is gone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holi-owned-parent-'))
    const sentinel = join(dir, 'should-not-run')
    let child: ReturnType<typeof spawnOwnedProgram> | undefined
    try {
      child = spawnOwnedProgram(
        process.execPath,
        ['-e', `require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'ran')`],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, ...(windows ? { HOLI_OWNED_PROCESS_TRACE: '1' } : {}) },
        },
        2_000_000_000,
      )
      diagnostics(child)
      expect(await completion(child)).toBe(125)
      await expect(readFile(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      if (child) await cleanup(child, 'expected-launch-failure')
      await rm(dir, { recursive: true, force: true })
    }
  })
})

async function withOwnedTree(
  pipes: boolean,
  body: (tree: {
    child: ReturnType<typeof spawnOwnedProgram>
    dir: string
    expectExited: () => Promise<void>
  }) => Promise<void>,
) {
  await withWitness(async (witness) => {
    const dir = await mkdtemp(join(tmpdir(), 'holi-owned-tree-'))
    await withFixtureCleanup(
      async () => {
        const nonce = fixtureNonce()
        const rootPidFile = join(dir, 'root-pid')
        const descendantPidFile = join(dir, 'descendant-pid')
        const descendant = `const fs=require('node:fs');const file=${JSON.stringify(descendantPidFile)};fs.writeFileSync(file+'.tmp',String(process.pid));fs.renameSync(file+'.tmp',file);process.stdout.write('ready\\n');setInterval(()=>0,1000)`
        // Don't let the root exit or create a descendant before its own HANDLE is held.
        const root = `const fs=require('node:fs');const file=${JSON.stringify(rootPidFile)};fs.writeFileSync(file+'.tmp',String(process.pid));fs.renameSync(file+'.tmp',file);let c;setInterval(()=>{if(!c&&fs.existsSync(${JSON.stringify(join(dir, 'start-descendant'))})){c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)},${JSON.stringify(nonce)}],{stdio:['ignore','pipe',${pipes ? "'inherit'" : "'ignore'"}],windowsHide:true});c.stdout.resume()}if(fs.existsSync(${JSON.stringify(join(dir, 'exit-root'))}))process.exit(23)},20)`
        const child = spawnOwnedProgram(nodeImage, ['-e', root, nonce], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, HOLI_OWNED_PROCESS_TRACE: '1' },
        })
        diagnostics(child)
        child.stdout!.resume()
        await withFixtureCleanup(
          async () => {
            const pin = async (file: string, parentPid: number | undefined) => {
              const pid = Number(await waitForFile(file))
              return witness.pin({ pid, expectedImage: nodeImage, nonce, parentPid })
            }
            const rootIdentity = await pin(rootPidFile, child.pid)
            await writeFile(join(dir, 'start-descendant'), '')
            const descendantIdentity = await pin(descendantPidFile, rootIdentity.pid)
            expect(await witness.exited(descendantIdentity.id)).toBe(false)
            await body({
              child,
              dir,
              async expectExited() {
                expect(await witness.exited(rootIdentity.id)).toBe(true)
                expect(await witness.exited(descendantIdentity.id)).toBe(true)
              },
            })
          },
          () => cleanup(child),
        )
      },
      () => rm(dir, { recursive: true, force: true }),
    )
  })
}

const nativeSetupMs = 15_000
const nativePartialMs = 5_000
const rawCaseMs = 100_000
const readyParentLine = 'test-parent-handle-held\n'

function producerProof(
  caseName: string,
  proof: {
    kind:
      | 'auth-timeout'
      | 'create-process-failure'
      | 'stop-ack'
      | 'schema-rejection'
      | 'parent-before-connect'
      | 'query-fault'
      | 'handoff-fault'
      | 'blocked-stderr'
      | 'spawn-timeout'
  } & Record<string, unknown>,
  cleanup: (RawCleanup & { witnessClosed: true | null; parentClosed: true | null }) | StatusCleanup,
) {
  console.log(`HOLI_WINDOWS_OWNED_PRODUCER_PROOF ${JSON.stringify({ caseName, proof, cleanup })}`)
}

describe.skipIf(!windows)('native owned control producer', () => {
  it(
    'rejects a local pipe client whose PID does not match the held parent',
    async () => {
      const parent = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        stdio: 'ignore',
      })
      fixtureChild(parent)
      await withFixtureCleanup(
        async () => {
          const producer = startRawProducer({ parentPid: parent.pid! })
          await withFixtureCleanup(
            async () => {
              await producer.open()
              await producer.exit(125)
              expect(producer.records).toEqual([])
              expect(producer.stdout()).toBe('')
            },
            () => producer.cleanup(),
          )
        },
        () => stopFixtureChild(parent, teardownMs, 'raw fixture parent'),
      )
    },
    rawCaseMs,
  )

  const preconnectCase = 'exits when the held parent dies before the pipe connects'
  it(
    preconnectCase,
    async () => {
      const parent = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        stdio: 'ignore',
      })
      const observedParent = fixtureChild(parent)
      let cleanup!: RawCleanup
      const proof = await withFixtureCleanup(
        async () => {
          const producer = startRawProducer({ parentPid: parent.pid!, parentBarrier: true })
          return withFixtureCleanup(
            async () => {
              // The stdout barrier is readiness only: native code has opened the parent
              // HANDLE. Never dial the control pipe, even on the cleanup path.
              await expect.poll(producer.stdout, { timeout: 8_000 }).toBe(readyParentLine)
              expect(fixtureChildAlive(parent)).toBe(true)
              expect(producer.helperAlive()).toBe(true)
              const at = performance.now()
              expect(parent.kill('SIGKILL')).toBe(true)
              expect(await observedParent.join(3_000, 'disposable native parent')).toBeNull()
              const parentExitSignal = parent.signalCode
              expect(parentExitSignal).toBe('SIGKILL')
              const { helperExitCode, at: exitedAt } = await producer.exit(125, 3_000)
              const parentKillToHelperExitMs = exitedAt - at
              expect(parentKillToHelperExitMs).toBeGreaterThanOrEqual(0)
              expect(parentKillToHelperExitMs).toBeLessThan(3_000)
              const controlConnectAttempts = producer.connectAttempts()
              expect(controlConnectAttempts).toBe(0)
              expect(producer.records).toEqual([])
              const parentHandleReady = producer.stdout() === readyParentLine
              expect(parentHandleReady).toBe(true)
              return {
                kind: 'parent-before-connect' as const,
                parentHandleReady,
                parentExitSignal,
                helperExitCode,
                parentKillToHelperExitMs,
                controlConnectAttempts,
              }
            },
            async () => {
              cleanup = await producer.cleanup()
            },
          )
        },
        () => stopFixtureChild(parent, teardownMs, 'raw fixture parent'),
      )
      producerProof(preconnectCase, proof, { ...cleanup, witnessClosed: null, parentClosed: true })
    },
    rawCaseMs,
  )

  const silentCase = 'bounds authentication when the genuine parent connects but sends nothing'
  it(
    silentCase,
    async () => {
      const { proof, cleanup } = await withRawProducer(async (producer, witness) => {
        const hello = await producer.hello(witness)
        const { helperExitCode, at } = await producer.exit(125, nativeSetupMs + 1_000)
        const helloToHelperExitMs = at - producer.receivedAt(hello)
        expect(helloToHelperExitMs).toBeGreaterThanOrEqual(nativeSetupMs - 3_000)
        expect(helloToHelperExitMs).toBeLessThanOrEqual(nativeSetupMs + 1_000)
        const helperRecords = producer.records.map(({ type }) => type)
        expect(helperRecords).toEqual(['hello'])
        const controlBytesWritten = producer.bytesWritten()
        expect(controlBytesWritten).toBe(0)
        const rootOutputSeen = producer.stdout() !== ''
        expect(rootOutputSeen).toBe(false)
        return {
          kind: 'auth-timeout' as const,
          helperExitCode,
          helloToHelperExitMs,
          helperRecords,
          controlBytesWritten,
          rootOutputSeen,
        }
      })
      producerProof(silentCase, proof, cleanup)
    },
    rawCaseMs,
  )

  const createFailureCase = 'reports a missing executable separately from authenticated EMPTY'
  it(
    createFailureCase,
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'holi-raw-missing-'))
      const missingExecutable = join(dir, 'missing.exe')
      const { proof, cleanup } = await withFixtureCleanup(
        () =>
          withRawProducer(
            async (producer, witness) => {
              const { mode } = await producer.auth(witness)
              const { helperExitCode } = await producer.exit(125)
              const helperRecords = producer.records.map(({ type }) => type)
              expect(helperRecords).toEqual(['hello', 'setup', 'empty'])
              const empty = producer.records.at(-1)
              if (empty?.type !== 'empty') throw new Error('missing signed native EMPTY')
              // The native helper sends this terminal only after DrainJob has
              // queried zero; stderr is checked separately after stream close.
              expect(empty).toEqual({
                type: 'empty',
                reason: 'launch-failed',
                exitCode: 125,
                rootPid: null,
                rootExitCode: null,
                outputFailed: false,
              })
              expect(producer.stdout() === '').toBe(true)
              const stderr = producer.stderr()
              const diagnostic =
                /^CreateProcess failed \(Win32 error (\d+)\): ([^\r\n]+)\r?\n$/u.exec(stderr)
              const diagnosticDelivered =
                diagnostic?.[0] === stderr &&
                !!diagnostic[2]?.trim() &&
                diagnostic[2].length <= 256 &&
                !stderr.includes('missing.exe')
              expect(diagnosticDelivered).toBe(true)
              const nativeErrorCode = Number(diagnostic?.[1])
              expect(nativeErrorCode).toBe(2) // ERROR_FILE_NOT_FOUND, independent of message locale.
              return {
                kind: 'create-process-failure' as const,
                mode,
                helperExitCode,
                helperRecords,
                empty,
                nativeErrorCode,
                diagnosticDelivered,
              }
            },
            undefined,
            missingExecutable,
          ),
        () => rm(dir, { recursive: true, force: true }),
      )
      producerProof(createFailureCase, proof, cleanup)
    },
    rawCaseMs,
  )

  function assertRejected(producer: RawProducer) {
    const helperRecords = producer.records
      .filter(({ type }) => type !== 'phase' && type !== 'root-created' && type !== 'root-exit')
      .map(({ type }) => type)
    expect(helperRecords).toEqual(['hello', 'setup', 'error']) // In particular: no EMPTY or HANDOFF.
    const error = producer.records.at(-1)
    if (error?.type !== 'error') throw new Error('missing native terminal error')
    expect(error.code).toBe('protocolFailure')
    return { error, helperRecords }
  }

  it.each(['EOF', 'early ACK', 'replay', 'fractional sequence', 'invalid UTF-8'] as const)(
    'fails closed on post-auth %s',
    async (failure) => {
      await withRawProducer(async (producer, witness) => {
        await producer.auth(witness)
        await producer.holdRoot(witness)
        switch (failure) {
          case 'EOF':
            producer.closeParentEnd()
            break
          case 'early ACK':
            await producer.send(producer.encode({ type: 'acknowledge' }))
            break
          case 'replay': {
            const stop = producer.encode({ type: 'stop', signal: 'SIGTERM' })
            await producer.send(Buffer.concat([stop, stop]))
            break
          }
          case 'fractional sequence': {
            const stop = producer.encode({ type: 'stop', signal: 'SIGTERM' })
            await producer.send(Buffer.from(String(stop).replace('"seq":2,', '"seq":2.25,')))
            break
          }
          case 'invalid UTF-8': {
            const payload = Buffer.concat([
              Buffer.from('{"type":"stop","signal":"SIGTERM"'),
              Buffer.from([0xff, 0x7d]),
            ])
            await producer.send(producer.rawPayload(payload, 2))
            break
          }
        }
        await producer.exit(125)
        if (failure !== 'EOF') assertRejected(producer)
        else
          expect(producer.records.some(({ type }) => type === 'empty' || type === 'handoff')).toBe(
            false,
          )
      })
    },
    rawCaseMs,
  )

  function schemaRejection<T extends Record<string, unknown>>(
    caseName: string,
    malformed: 'duplicate-decoded-key' | 'noncanonical-uint' | 'partial-frame',
    inject: (producer: RawProducer) => Promise<(errorAt: number) => T>,
  ) {
    it(
      caseName,
      async () => {
        const { proof, cleanup } = await withRawProducer(async (producer, witness) => {
          const { mode } = await producer.auth(witness)
          const root = await producer.holdRoot(witness)
          const rootAliveBeforeWrite = !(await root.exited())
          expect(rootAliveBeforeWrite).toBe(true)
          const before = producer.writes()
          expect(before).toBe(2) // AUTH + REGISTERED; the Root confirms REGISTERED was accepted.
          const checkInjection = await inject(producer)
          const { helperExitCode } = await producer.exit(125)
          const { error, helperRecords } = assertRejected(producer)
          const commandWrites = producer.writes() - before
          expect(commandWrites).toBe(malformed === 'partial-frame' ? 3 : 1)
          return {
            kind: 'schema-rejection' as const,
            malformed,
            mode,
            helperExitCode,
            helperRecords,
            nativeError: error.code,
            rootAliveBeforeWrite,
            commandWrites,
            ...checkInjection(producer.receivedAt(error)),
          }
        })
        producerProof(caseName, proof, cleanup)
      },
      rawCaseMs,
    )
  }

  schemaRejection(
    'rejects duplicate decoded keys after registration',
    'duplicate-decoded-key',
    async (producer) => {
      const payload = Buffer.from(
        String.raw`{"type":"stop","signal":"SIGTERM","\u0073ignal":"SIGTERM"}`,
      )
      // A permissive decoder would get a legitimate STOP with two spellings of
      // the same key. Sign those exact UTF-8 bytes, not their decoded object.
      await producer.send(producer.rawPayload(payload, 2))
      return () => ({})
    },
  )

  schemaRejection(
    'rejects noncanonical uint tokens after registration',
    'noncanonical-uint',
    async (producer) => {
      const stop = producer.encode({ type: 'stop', signal: 'SIGTERM' }).toString()
      expect(stop.includes('"seq":2,')).toBe(true)
      // Keep the MAC for numeric sequence 2. Only the token spelling changes.
      await producer.send(Buffer.from(stop.replace('"seq":2,', '"seq":2e0,')))
      return () => ({})
    },
  )

  schemaRejection(
    'bounds a partial native control frame from its first byte',
    'partial-frame',
    async (producer) => {
      const valid = producer.encode({ type: 'stop', signal: 'SIGTERM' })
      const prefix = valid.subarray(0, 3)
      expect(prefix.includes(10)).toBe(false)
      const first = await producer.send(prefix.subarray(0, 1))
      await delay(Math.max(0, first + 2_000 - performance.now()))
      await producer.send(prefix.subarray(1, 2))
      await delay(Math.max(0, first + 4_000 - performance.now()))
      const last = await producer.send(prefix.subarray(2, 3))
      // No EOF and no LF. A deadline renewed by the last byte would run nearly
      // 9 s from the first byte; the authenticated error must arrive near 5 s.
      return (errorAt) => {
        const firstByteToErrorMs = errorAt - first
        const lastByteToErrorMs = errorAt - last
        expect(firstByteToErrorMs).toBeGreaterThanOrEqual(nativePartialMs - 100)
        expect(firstByteToErrorMs).toBeLessThanOrEqual(nativePartialMs + 1_500)
        expect(lastByteToErrorMs).toBeGreaterThan(0)
        expect(lastByteToErrorMs).toBeLessThan(3_000)
        return { firstByteToErrorMs, lastByteToErrorMs }
      }
    },
  )

  it(
    'reports the actual root exit code after stopping a still-running job',
    async () => {
      await withRawProducer(async (producer, witness) => {
        await producer.auth(witness)
        const root = await producer.holdRoot(witness)
        await producer.send(producer.encode({ type: 'stop', signal: 'SIGTERM' }))
        await producer.exit(1)
        expect(producer.records.at(-1)).toMatchObject({
          type: 'empty',
          exitCode: 1,
          rootExitCode: 1,
          rootPid: root.pid,
        })
      })
    },
    rawCaseMs,
  )

  for (const ackFirst of [true, false]) {
    const caseName = `gives coalesced STOP priority over READY ACK (ACK first: ${ackFirst})`
    it(
      caseName,
      async () => {
        const dir = await mkdtemp(join(tmpdir(), 'holi-raw-owned-'))
        const gate = join(dir, 'exit-root')
        const { proof, cleanup } = await withFixtureCleanup(
          () =>
            withRawProducer(async (producer, witness) => {
              const { mode } = await producer.auth(witness)
              const root = await producer.holdRoot(witness)
              const grandchild = await producer.holdGrandchild(witness, root.pid)
              await writeFile(gate, '')
              await producer.record('ready')
              const rootExitedAtReady = await root.exited()
              const grandchildAliveAtReady = !(await grandchild.exited())
              expect(rootExitedAtReady).toBe(true)
              expect(grandchildAliveAtReady).toBe(true)
              const ack = { type: 'acknowledge' } as const
              const stop = { type: 'stop', signal: 'SIGTERM' } as const
              const commands = ackFirst ? [ack, stop] : [stop, ack]
              const frames = commands.map((message) => producer.encode(message))
              const commandSeqs = frames.map(
                (frame) => (JSON.parse(frame.toString()) as { seq: number }).seq,
              )
              expect(commandSeqs).toEqual([2, 3])
              const before = producer.writes()
              await producer.send(Buffer.concat(frames))
              const coalescedWrites = producer.writes() - before
              expect(coalescedWrites).toBe(1)
              const { helperExitCode } = await producer.exit(1)
              const helperRecords = producer.records
                .filter(
                  ({ type }) => type !== 'phase' && type !== 'root-created' && type !== 'root-exit',
                )
                .map(({ type }) => type)
              expect(helperRecords).toEqual(['hello', 'setup', 'ready', 'empty'])
              const empty = producer.records.at(-1)
              if (empty?.type !== 'empty') throw new Error('missing native EMPTY')
              expect(producer.records.filter(({ type }) => type === 'root-exit')).toEqual([
                { type: 'root-exit', rootPid: root.pid, rootExitCode: 0 },
              ])
              expect(empty.rootPid).toBe(root.pid)
              const { reason, exitCode, rootExitCode, outputFailed } = empty
              expect({
                reason,
                exitCode,
                rootExitCode,
                outputFailed,
                rootPid: empty.rootPid,
              }).toEqual({
                reason: 'stopped',
                exitCode: 1,
                rootExitCode: 0,
                outputFailed: false,
                rootPid: root.pid,
              })
              expect(await grandchild.exited()).toBe(true) // Before the broker can close the duplicate.
              producer.releaseVerifiedEmpty(empty)
              return {
                kind: 'stop-ack' as const,
                mode,
                helperExitCode,
                helperRecords,
                commandOrder: commands.map(({ type }) => type),
                commandSeqs,
                coalescedWrites,
                rootExitedAtReady,
                grandchildAliveAtReady,
                empty: { reason, exitCode, rootExitCode, outputFailed },
              }
            }, gate),
          () => rm(dir, { recursive: true, force: true }),
        )
        producerProof(caseName, proof, cleanup)
      },
      rawCaseMs,
    )
  }
})

describe.skipIf(!windows)('retained native Job across helper death', () => {
  for (const point of ['before-clear', 'after-clear'] as const) {
    const caseName = `revokes the original Job when the helper dies ${point}`
    it(
      caseName,
      async () => {
        const { proof, cleanup } = await withStatusProducer(
          { tree: true, retained: true },
          async (fixture) => {
            const { child, control, original } = fixture.start(() =>
              spawnOwnedLaunchWithHandoffFault(
                launchPlan(fixture.nodeImage, fixture.treeArgs, { platform: 'win32' }),
                { cwd: fixture.dir, stdio: ['ignore', 'pipe', 'pipe'] },
                point,
              ),
            )
            const ready = fixtureResult<true>()
            control.onReady = () => ready.settle({ value: true })
            await fixture.holdRoot()
            expect(await fixture.exited('grandchild')).toBe(false)
            await fixture.mark('release-0')
            const readyReceived = await ready.wait(statusWaitMs, 'authenticated retained READY')
            const rootExitCode = await fixture.exitCode('root')
            expect(rootExitCode).toBe(0)
            expect(await fixture.exited('grandchild')).toBe(false)
            const acknowledged = control.acknowledge()
            expect(acknowledged).toBe(true)
            const { receipt, sameReceipt, sameLease } = await rejectedStatusReceipt(child, original)
            const { helperExitCode } = await fixture.helperStatus()
            expect(helperExitCode).toBe(125)
            // The guard has had its last handle closed. In the after-clear gap the
            // GC must still be live at this point, before any cleanup request.
            const grandchildExitedBeforeRevoke =
              point === 'before-clear'
                ? await fixture.waitForExit('grandchild')
                : await fixture.exited('grandchild')
            expect(grandchildExitedBeforeRevoke).toBe(point === 'before-clear')
            const revoke = control.lease.revoke()
            const revokeIdempotent = control.lease.revoke() === revoke
            expect(revokeIdempotent).toBe(true)
            // The real broker's revoke only resolves after native ActiveProcesses=0.
            await within(revoke, 22_000, 'broker drain of original Job')
            const grandchildExitedAfterRevoke = await fixture.waitForExit('grandchild')
            return {
              kind: 'handoff-fault' as const,
              point,
              receipt,
              sameReceipt,
              sameLease,
              readyReceived,
              acknowledged,
              helperExitCode,
              rootExitCode,
              grandchildExitedBeforeRevoke,
              revokeIdempotent,
              grandchildExitedAfterRevoke,
            }
          },
        )
        producerProof(caseName, proof, cleanup)
      },
      statusCaseMs,
    )
  }

  const blockedStderrCase =
    'proves EMPTY without waiting for blocked provider stderr or its retained relay'
  it(
    blockedStderrCase,
    async () => {
      const { proof, cleanup } = await withStatusProducer(
        { retained: true, pauseStderr: true },
        async (fixture) => {
          const script = `
        const fs = require('node:fs')
        const nonce = process.argv[1]
        // A Windows stdio stream can write synchronously. Keep the control
        // thread responsive by using fs.write on the worker pool instead.
        const bytes = Buffer.alloc(8 * 1024 * 1024, 0x78)
        let offset = 0
        function writeStderr() {
          fs.write(2, bytes, offset, bytes.length - offset, null, (error, written) => {
            if (error || written === 0 || (offset += written) === bytes.length) {
              fs.writeFileSync('stderr-settled', '')
            } else writeStderr()
          })
        }
        writeStderr()
        fs.writeFileSync('root.tmp', JSON.stringify({ pid: process.pid, nonce }))
        fs.renameSync('root.tmp', 'root.json')
        const expires = performance.now() + 45000
        setInterval(() => { if (performance.now() >= expires || fs.existsSync('abort')) process.exit(2) }, 20)
      `
          const { child, control, original } = fixture.start(() =>
            spawnOwnedLaunch(
              launchPlan(fixture.nodeImage, ['-e', script, fixture.nonce], { platform: 'win32' }),
              {
                cwd: fixture.dir,
                env: { ...process.env, HOLI_OWNED_PROCESS_TRACE: '1' },
                stdio: ['ignore', 'pipe', 'pipe'],
              },
              process.pid,
              true,
            ),
          )
          const relayError = fixtureResult<Error>()
          control.onOutputFailure = (error) => relayError.settle({ value: error })
          const stdoutClose = fixtureResult<true>()
          const stderrClose = fixtureResult<true>()
          child.stdout!.once('close', () => stdoutClose.settle({ value: true }))
          child.stderr!.once('close', () => stderrClose.settle({ value: true }))
          await fixture.holdRoot()
          const stderrRelayBackpressured = await pollFixture(
            () => {
              const relay = child.stderr!
              if (!relay.readableFlowing && relay.readableLength >= relay.readableHighWaterMark)
                return true
            },
            performance.now() + statusWaitMs,
            'paused parent stderr relay filled',
            20,
          )
          const rootAliveBeforeStop = !(await fixture.exited('root'))
          expect(rootAliveBeforeStop).toBe(true)
          const stderrWritePending = !existsSync(join(fixture.dir, 'stderr-settled'))
          expect(stderrWritePending).toBe(true)
          const stopAccepted = child.kill()
          expect(stopAccepted).toBe(true)
          const receipt = await within(
            original,
            statusWaitMs,
            'original EMPTY while relay is blocked',
          )
          const sameReceipt = child.ownedCompletion === original
          expect(receipt).toBe('empty')
          expect(sameReceipt).toBe(true)
          // This callback is invoked only for an authenticated EMPTY with outputFailed.
          const outputFailure = await relayError.wait(statusWaitMs, 'authenticated output failure')
          const outputFailed = outputFailure.message === 'owned output relay failed to settle'
          expect(outputFailed).toBe(true)
          const { helperExitCode } = await fixture.helperStatus()
          expect(helperExitCode).toBe(1)
          const stdoutRelayClosed = await stdoutClose.wait(statusWaitMs, 'stdout relay close')
          const stderrRelayClosed = await stderrClose.wait(statusWaitMs, 'stderr relay close')
          return {
            kind: 'blocked-stderr' as const,
            receipt,
            sameReceipt,
            outputFailed,
            stderrWritePending,
            stderrRelayBackpressured,
            rootAliveBeforeStop,
            stopAccepted,
            helperExitCode,
            stdoutRelayClosed,
            stderrRelayClosed,
          }
        },
      )
      producerProof(blockedStderrCase, proof, cleanup)
    },
    statusCaseMs,
  )
})
