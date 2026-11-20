import { describe, expect, it, vi } from 'vitest'
import { withFixtureCleanup } from './fixtures/fixture-deadline'
import { ControlFixture, ControlTap } from './fixtures/windows-owned-process-control'

const transport = vi.hoisted(() => ({ tap: undefined as ControlTap | undefined }))
vi.mock('node:net', async (importOriginal) => {
  const net = await importOriginal<typeof import('node:net')>()
  return {
    ...net,
    connect(...args: unknown[]) {
      const [path] = args
      if (transport.tap && args.length === 1 && typeof path === 'string')
        return transport.tap.dial(
          path,
          () => net.connect(path),
          () => new net.Socket(),
        )
      return Reflect.apply(net.connect, undefined, args)
    },
  }
})

// Never substitutes a helper, receipt producer or OS result off Windows.
describe.skipIf(process.platform !== 'win32')('Windows owned-process native control', () => {
  function acceptance(
    caseName: string,
    attack: ConstructorParameters<typeof ControlTap>[0],
    run: (fixture: ControlFixture) => Promise<Record<string, boolean | number | string>>,
  ) {
    it(
      caseName,
      async () => {
        const tap = new ControlTap(attack)
        const fixture = new ControlFixture(tap)
        let cleanup: Awaited<ReturnType<ControlFixture['close']>> | undefined
        const proof = await withFixtureCleanup(
          () => {
            transport.tap = tap
            return run(fixture)
          },
          async () => {
            try {
              cleanup = await fixture.close()
            } finally {
              transport.tap = undefined
            }
          },
        )
        if (!cleanup) throw new Error('control cleanup did not report a result')
        expect(cleanup.helperClosed).toBe(true)
        expect(cleanup.nativeFixtureClosed).toBe(true)
        expect(cleanup.heldHandleFallbacks).toBe(0)
        expect(cleanup.rootExit).toBe(
          proof.rootStarted === false ? 'absent-after-helper-exit' : 'observed',
        )
        expect(cleanup.jobLeaseRevoked).toBe(proof.nativeFailure === 'protocolFailure')
        console.log(
          `HOLI_WINDOWS_OWNED_CONTROL_PROOF ${JSON.stringify({ caseName, proof, cleanup })}`,
        )
      },
      90_000,
    )
  }

  acceptance(
    'keeps completion authority off child stdout and stderr',
    undefined,
    async (fixture) => {
      await fixture.prepareWitness()
      fixture.launch('spoof')
      const pid = await fixture.holdRoot()
      const lookalikes = (stream: 'stdout' | 'stderr') =>
        `EMPTY 1\nHANDOFF 0\n{"type":"empty","exitCode":1,"rootExitCode":1,"rootPid":${pid}}\n` +
        `{"type":"handoff","exitCode":0,"rootExitCode":0,"rootPid":${pid}}\n` +
        '{"type":"error","code":"protocolFailure"}\n' +
        `\\n[holi-complete-00000000-0000-4000-8000-000000000000-${stream}]\\n\n`
      await fixture.waitForOutput(lookalikes('stdout'), lookalikes('stderr'))
      expect(await fixture.rootAlive()).toBe(true)
      expect(fixture.current()).toBe('pending')
      expect(fixture.stop()).toBe(true)
      const stopped = await expectEmptyStop(fixture)
      const output = fixture.output()
      expect(
        output.stdout === lookalikes('stdout') + `root-ready:${pid}\n` + 'O'.repeat(128) + '\n',
      ).toBe(true)
      expect(output.stderr === lookalikes('stderr') + 'E'.repeat(128) + '\n').toBe(true)
      return { outputPreserved: true, pendingWithRootAlive: true, ...stopped }
    },
  )

  acceptance('rejects wrong-secret AUTH on the private pipe', 'wrong-auth', async (fixture) => {
    await fixture.prepareNative()
    fixture.launch()
    await fixture.injectedOnSocket()
    const result = await fixture.result()
    fixture.originalUnconfirmed(result.verdict)
    const helperFrames = await fixture.wrongAuthClosure()
    expect(helperFrames).toBe(1) // Authenticated HELLO only, no SETUP or ERROR.
    expect(fixture.tap.parentConnections).toBe(1)
    expect(fixture.tap.injected).toBe(1)
    expect(result.exit).toEqual({ code: 125, signal: null })
    expect(fixture.rootStarted()).toBe(false)
    return {
      injected: fixture.tap.injected,
      helperFrames,
      completion: result.verdict.state,
      reason: 'pre-authentication closure',
      exitCode: result.exit.code!,
      rootStarted: false,
    }
  })

  const replay = async (fixture: ControlFixture) => {
    await fixture.prepareWitness()
    fixture.launch('held', 'retained')
    await fixture.holdRoot()
    expect(fixture.current()).toBe('pending')
    expect(fixture.tap.injected).toBe(0)
    expect(fixture.stop()).toBe(true)
    await fixture.injectedOnSocket()
    const result = await fixture.result()
    expect(fixture.tap.parentConnections).toBe(1)
    expect(fixture.tap.injected).toBe(1)
    const { cause } = fixture.originalUnconfirmed(result.verdict)
    // This cause comes from the original controller verifying the native ERROR
    // frame. A generic unconfirmed rejection or helper exit 125 is insufficient.
    if (!(cause instanceof Error) || cause.message !== 'owned helper reported protocolFailure')
      throw new Error('original completion lacks authenticated replay failure', { cause })
    expect(result.exit).toEqual({ code: 125, signal: null })
    expect(await fixture.helperExitCode()).toBe(125)
    return {
      injected: fixture.tap.injected,
      pendingWithRootAlive: true,
      completion: result.verdict.state,
      sameOriginalLease: true,
      nativeFailure: cause.message.slice('owned helper reported '.length),
      exitCode: result.exit.code!,
    }
  }

  acceptance('rejects replayed AUTH on the private pipe', 'replay-auth', replay)
  acceptance('rejects a replayed STOP sequence on the private pipe', 'replay-stop', replay)

  acceptance(
    'rejects a competing client before parent authentication',
    'hold-parent',
    async (fixture) => {
      await fixture.prepareNative()
      fixture.launch()
      const peer = await fixture.compete('first')
      const result = await fixture.result()
      expect(peer.connected).toBe(true)
      expect(peer.greetingBytes).toBe(0)
      expect([109, 232, 233]).toContain(peer.peerCloseError)
      expect(fixture.tap.parentConnections).toBe(0)
      expect(fixture.tap.registered).toBe(false)
      fixture.originalUnconfirmed(result.verdict)
      expect(result.exit).toEqual({ code: 125, signal: null })
      expect(fixture.rootStarted()).toBe(false)
      return {
        competingClientConnected: peer.connected,
        clientPid: peer.clientPid,
        parentConnections: fixture.tap.parentConnections,
        greetingBytes: peer.greetingBytes,
        peerCloseError: peer.peerCloseError,
        completion: result.verdict.state,
        reason: 'pre-authentication closure',
        exitCode: result.exit.code!,
        rootStarted: false,
      }
    },
  )

  acceptance('refuses a second client after parent authentication', undefined, async (fixture) => {
    await fixture.prepareNative()
    await fixture.prepareWitness()
    fixture.launch()
    await fixture.holdRoot()
    expect(fixture.tap.parentConnections).toBe(1)
    const peer = await fixture.compete('second')
    expect(peer.connected).toBe(false)
    expect(peer.openError).toBe(231) // ERROR_PIPE_BUSY on the actual Win32 CreateFileW call.
    expect(await fixture.rootAlive()).toBe(true)
    expect(fixture.current()).toBe('pending')
    expect(fixture.stop()).toBe(true)
    const stopped = await expectEmptyStop(fixture)
    return {
      competingClientConnected: peer.connected,
      parentConnections: fixture.tap.parentConnections,
      openError: peer.openError,
      pendingWithRootAlive: true,
      ...stopped,
    }
  })

  acceptance(
    'does not inherit the private control pipe or Job handle',
    undefined,
    async (fixture) => {
      await fixture.prepareNative()
      await fixture.prepareWitness()
      fixture.launch('inspect')
      await fixture.holdRoot()
      const scan = await fixture.inspect()
      expect(scan.handles).toBeGreaterThan(0)
      expect(scan.inspected).toBe(scan.handles)
      expect(scan.namedPipes).toBeGreaterThan(0)
      expect(scan.positivePipeMatches).toBeGreaterThan(0)
      expect(scan.controlPipeMatches).toBe(0)
      expect(scan.jobMember).toBe(true)
      expect(scan.jobHandles).toBe(0)
      expect(await fixture.rootAlive()).toBe(true)
      expect(fixture.current()).toBe('pending')
      expect(fixture.stop()).toBe(true)
      return { ...scan, pendingWithRootAlive: true, ...(await expectEmptyStop(fixture)) }
    },
  )
})

async function expectEmptyStop(fixture: ControlFixture) {
  const { verdict, exit } = await fixture.result()
  if (verdict.state === 'rejected') throw verdict.error
  if (verdict.state !== 'resolved' || verdict.receipt !== 'empty')
    throw new Error('original owned completion did not resolve EMPTY')
  expect(exit).toEqual({ code: 1, signal: null })
  return { receipt: verdict.receipt, exitCode: exit.code! }
}
