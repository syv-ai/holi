import {
  A,
  B,
  adapters,
  deferred,
  harness,
  nestedErrors,
  rig,
  waitForFile,
  waitForGone,
} from './activation-fixture'
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MainPlugin, PluginCtx } from '../../../main/plugin-api'
import { PRESETS } from '../main/harness/record'
import { openTurnLog, TURNS_FILE } from '../main/host/turn-log'
import { agentScratchRoots } from '../main/host/scratch-roots'

const customRow = {
  agents: expect.arrayContaining([
    expect.objectContaining({ harness: expect.objectContaining({ id: harness.id }) }),
  ]),
}

describe('real agent lifecycle repair regressions', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  })
  it.each(['direct', 'machine'] as const)(
    'revokes the real agent before its disposer starts through %s dispatch, preserving dependency finalization and vault B',
    async (doorKind) => {
      const entered = deferred()
      const release = deferred()
      const contexts = new Map<string, PluginCtx>()
      let finalized = false
      const dependent: MainPlugin = {
        info: { id: 'dependent', label: 'Dependent', default: true, requires: ['agent'] },
        activate(ctx) {
          return async () => {
            if (ctx.remote !== A) return
            entered.resolve()
            await release.promise
            expect(await ctx.call('agent.harnesses', {})).toMatchObject({
              agents: expect.any(Array),
            })
            finalized = true
          }
        },
      }
      const { host, enter, call, capabilities, registry, machineCall } = await rig(
        undefined,
        undefined,
        false,
        {
          plugins: [dependent],
          context: (ctx) => contexts.set(ctx.remote, ctx),
        },
      )
      await enter(A)
      await enter(B)
      const closedBefore = adapters.watchCloses
      const stopping = host.stop(A)
      const again = host.stop(A)
      try {
        expect(contexts.get(A)!.activationSignal.aborted).toBe(true)
        expect(contexts.get(B)!.activationSignal.aborted).toBe(false)
        await entered.promise
        // The dependent, not a wrapper around an already-completed agent disposer,
        // holds teardown. Real agent state and registration still exist here.
        expect(adapters.watchCloses).toBe(closedBefore)
        expect(registry.has('agent.sessions', A)).toBe(true)
        if (doorKind === 'direct') {
          for (const door of ['ui', 'cli'] as const) {
            await expect(
              capabilities.dispatch({
                door,
                remote: A,
                name: 'agent.sessions',
                params: { finalization: true },
                beforeInvoke: async () => {},
              }),
            ).rejects.toThrow('no such method')
          }
        } else {
          const refusedCli = await machineCall(A, 'agent', 'sessions')
          expect(refusedCli.status).toBe(422)
          expect(refusedCli.body).toContain('no such method')
          expect((await machineCall(B, 'agent', 'sessions')).status).toBe(200)
        }
        expect(await call(B, 'agent.harnesses')).toMatchObject({ agents: expect.any(Array) })
        expect(finalized).toBe(false)
      } finally {
        release.resolve()
        await Promise.all([stopping, again])
      }
      expect(finalized).toBe(true)
      expect(adapters.watchCloses).toBe(closedBefore + 1)
      await enter(A)
      expect(contexts.get(A)!.activationSignal.aborted).toBe(false)
      expect(await call(A, 'agent.harnesses')).toMatchObject({ agents: expect.any(Array) })
    },
  )

  it.each(['stop', 'stopAll'] as const)(
    'cancels real delayed startup through %s and permits replacement only after a clean drain',
    async (method) => {
      const entered = deferred()
      const release = deferred()
      const contexts: PluginCtx[] = []
      const { host, enter, call, roots } = await rig(undefined, undefined, false, {
        context: (ctx) => contexts.push(ctx),
      })
      adapters.run.mockImplementationOnce(async () => {
        entered.resolve()
        await release.promise
        return '[]'
      })
      const opening = enter(A)
      await entered.promise
      expect(adapters.watchStarts).toBe(1)
      const first = method === 'stop' ? host.stop(A) : host.stopAll()
      const again = host.stop(A)
      try {
        expect(contexts[0]!.activationSignal.aborted).toBe(true)
        expect(adapters.watchCloses).toBe(0)
        expect(roots[A]).not.toBe(roots[B])
      } finally {
        release.resolve()
        await Promise.all([opening, first, again])
      }
      expect(adapters.watchCloses).toBe(1)
      await enter(A)
      expect(contexts).toHaveLength(2)
      expect(contexts[1]!.activationSignal.aborted).toBe(false)
      expect(await call(A, 'agent.harnesses')).toMatchObject({ agents: expect.any(Array) })
    },
  )

  it.each(['stop', 'stopAll'] as const)(
    'propagates real cancelled-start cleanup failure through queued %s and every later stop/restart',
    async (method) => {
      const entered = deferred()
      const release = deferred()
      const contexts = new Map<string, PluginCtx>()
      const { host, enter, call, expectFailedDrain } = await rig(undefined, undefined, false, {
        context: (ctx) => contexts.set(ctx.remote, ctx),
      })
      await enter(B)
      adapters.run.mockImplementationOnce(async () => {
        entered.resolve()
        await release.promise
        return '[]'
      })
      const opening = enter(A).catch((err: unknown) => err)
      await entered.promise
      const cleanupFailure = new Error('native watcher close unproven')
      adapters.watchCloseFailure = { error: cleanupFailure, watch: adapters.watchStarts }
      expectFailedDrain()
      const first = (method === 'stop' ? host.stop(A) : host.stopAll()).catch((err: unknown) => err)
      const again = host.stop(A).catch((err: unknown) => err)
      expect(contexts.get(A)!.activationSignal.aborted).toBe(true)
      release.resolve()
      const activationFailure = await opening
      expect(activationFailure).toMatchObject({ message: 'agent activation failed' })
      expect(nestedErrors(activationFailure)).toContain(cleanupFailure)
      const stoppingFailure = await first
      expect(stoppingFailure).toBeInstanceOf(AggregateError)
      expect(await again).toBe(activationFailure)
      await expect(host.stop(A)).rejects.toBe(activationFailure)
      await expect(enter(A)).rejects.toBe(activationFailure)
      if (method === 'stop') {
        expect(contexts.get(B)!.activationSignal.aborted).toBe(false)
        expect(await call(B, 'agent.harnesses')).toMatchObject({ agents: expect.any(Array) })
      }
      await expect(host.stopAll()).rejects.toMatchObject({
        errors: expect.arrayContaining([activationFailure]),
      })
    },
  )

  it.each(['close', 'timer'] as const)(
    'latches real failed-start %s cleanup, retaining both native error identities',
    async (kind) => {
      const { host, enter, call, expectFailedDrain } = await rig()
      await enter(B)
      const startupFailure = new Error('native activation failed')
      const cleanupFailure = new Error(`native ${kind} cleanup unproven`)
      let restoreTimer = () => {}
      adapters.version.mockImplementationOnce(() => {
        if (kind === 'timer') {
          // A native watcher event arms the real listing watcher's debounce.
          // Its actual unwatch cleanup, not a fake session host, clears it.
          const watcher = [...adapters.watchers].at(-1)!
          watcher.emit('change', 'change', 'sessions/fixture.json')
          const clear = globalThis.clearTimeout
          const timer = vi.spyOn(globalThis, 'clearTimeout').mockImplementationOnce((id) => {
            clear(id)
            throw cleanupFailure
          })
          restoreTimer = () => timer.mockRestore()
        }
        throw startupFailure
      })
      if (kind === 'close')
        adapters.watchCloseFailure = { error: cleanupFailure, watch: adapters.watchStarts + 1 }
      expectFailedDrain()
      try {
        const failure = await enter(A).catch((err: unknown) => err)
        restoreTimer()
        expect(failure).toMatchObject({ message: 'agent activation failed' })
        expect(nestedErrors(failure)).toEqual(
          expect.arrayContaining([startupFailure, cleanupFailure]),
        )
        await expect(host.stop(A)).rejects.toBe(failure)
        expect(await call(B, 'agent.harnesses')).toMatchObject({ agents: expect.any(Array) })
        await expect(host.stopAll()).rejects.toMatchObject({ errors: [failure] })
        await expect(enter(A)).rejects.toBe(failure)
        await expect(call(A, 'agent.sessions')).rejects.toThrow('no such method')
      } finally {
        restoreTimer()
      }
    },
  )
})

it('keeps real job and fenced scratch cleanup within its activated vault', async () => {
  const { host, enter, call, userData, roots } = await rig()
  await enter(A)
  await enter(B)
  const owners = await readdir(join(userData, 'agent-scratch'))
  expect(owners).toHaveLength(2)
  const scratch = owners.map((owner) => join(userData, 'agent-scratch', owner))
  const a = await agentScratchRoots(userData, { remote: A, root: roots[A] })
  const b = await agentScratchRoots(userData, { remote: B, root: roots[B] })
  expect(dirname(a.jobs)).not.toBe(dirname(b.jobs))
  expect(scratch).toEqual(expect.arrayContaining([dirname(a.jobs), dirname(b.jobs)]))
  const legacy = [join(userData, 'agent-jobs'), join(userData, 'agent-fenced')]
  for (const root of [
    ...scratch.flatMap((owner) => [join(owner, 'jobs'), join(owner, 'fenced')]),
    ...legacy,
  ]) {
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'ownership-sentinel'), root)
  }
  const contents = async (root: string) => readFile(join(root, 'ownership-sentinel'), 'utf8')
  await expect(call(B, 'agent.harnesses')).resolves.toMatchObject({ agents: expect.any(Array) })

  await host.stop(A)
  await expect(contents(b.jobs)).resolves.toBe(b.jobs)
  await expect(contents(b.fenced)).resolves.toBe(b.fenced)
  await expect(contents(a.jobs)).rejects.toThrow()
  await expect(contents(a.fenced)).rejects.toThrow()
  await expect(contents(legacy[0]!)).resolves.toBe(legacy[0])
  await expect(contents(legacy[1]!)).resolves.toBe(legacy[1])

  await enter(A)
  await expect(call(B, 'agent.harnesses')).resolves.toMatchObject({ agents: expect.any(Array) })
  await expect(contents(b.jobs)).resolves.toBe(b.jobs)
  await host.stop(A)
  await expect(contents(b.fenced)).resolves.toBe(b.fenced)
})

it('serializes overlapping PTY history updates across activations and drains stop A', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'holi-agent-history-'))
  const sharedId = 'p0123456789ab'
  const prior = {
    id: sharedId,
    provider: 'pi',
    name: 'Prior session',
    state: 'idle',
    startedAt: 1,
    conversationId: '123e4567-e89b-42d3-a456-426614174000',
  }
  await writeFile(
    join(userData, 'agent-pty-history.json'),
    JSON.stringify({ [A]: [prior], [B]: [prior] }),
  )
  const { host, enter, call, roots } = await rig(userData)
  await enter(A)
  await enter(B)
  const pi = {
    ...PRESETS.find((preset) => preset.id === 'pi')!,
    command: { bin: process.execPath, args: [] },
  }
  await call(A, 'agent.harnessSave', { harness: pi })
  const aStarted = (await call(A, 'agent.start', { provider: 'pi', prompt: 'A work' })) as {
    ok: boolean
    sessionId: string
  }
  const bStarted = (await call(B, 'agent.start', { provider: 'pi', prompt: 'B work' })) as {
    ok: boolean
    sessionId: string
  }
  expect(aStarted.ok).toBe(true)
  expect(bStarted.ok).toBe(true)
  expect(adapters.pty.slice(-2).map((session) => session.cwd)).toEqual([roots[A], roots[B]])

  const historyFile = join(userData, 'agent-pty-history.json')
  const aRenameEntered = deferred()
  const releaseARename = deferred()
  adapters.historyRename = {
    source: historyFile,
    entered: aRenameEntered.resolve,
    wait: releaseARename.promise,
  }
  const stopA = call(A, 'agent.stop', { id: aStarted.sessionId })
  await aRenameEntered.promise

  const bExitObserved = deferred()
  const releaseBExit = deferred()
  adapters.heldExit = {
    cwd: roots[B],
    entered: bExitObserved.resolve,
    wait: releaseBExit.promise,
  }
  const bMutationAdmitted = deferred()
  adapters.exitObserved = { cwd: roots[B], entered: bMutationAdmitted.resolve }
  const stopB = call(B, 'agent.stop', { id: bStarted.sessionId })
  await bExitObserved.promise
  releaseBExit.resolve()
  await bMutationAdmitted.promise
  // B reached its real PTY exit callback and queued its real history mutation
  // while A's jsonFileStore rename remains blocked.
  let stoppedA = false
  const teardownA = host.stop(A).then(() => {
    stoppedA = true
  })
  const bRenameEntered = deferred()
  const releaseBRename = deferred()
  adapters.historyRename = {
    source: historyFile,
    entered: bRenameEntered.resolve,
    wait: releaseBRename.promise,
  }
  releaseARename.resolve()
  await stopA
  await bRenameEntered.promise
  await teardownA
  expect(stoppedA).toBe(true)
  let stoppedB = false
  void stopB.then(() => {
    stoppedB = true
  })
  expect(stoppedB).toBe(false)
  releaseBRename.resolve()
  await stopB
  expect(stoppedA).toBe(true)
  const afterBothStop = JSON.parse(await readFile(historyFile, 'utf8')) as Record<string, unknown[]>
  expect(afterBothStop[A]).toHaveLength(2)
  expect(afterBothStop[B]).toHaveLength(2)
  expect(afterBothStop[A]?.[1]).toMatchObject({ id: sharedId })
  expect(afterBothStop[B]?.[1]).toMatchObject({ id: sharedId })
  await host.stop(A)
  await host.stop(B)
  await enter(A)
  await enter(B)
  expect(await call(A, 'agent.history')).toEqual(
    expect.arrayContaining([prior, expect.objectContaining({ id: aStarted.sessionId })]),
  )
  expect(await call(B, 'agent.history')).toEqual(
    expect.arrayContaining([prior, expect.objectContaining({ id: bStarted.sessionId })]),
  )
})

it('finalizes busy native sessions discovered during plugin startup', async () => {
  const { host, enter, roots, bridge, syncHolds } = await rig(undefined, undefined, true)
  const sessions = { [A]: 'a1234567', [B]: 'b1234567' }
  const listings: string[] = []
  adapters.run.mockImplementation(async (_bin, args, opts) => {
    if (args.includes('--bg')) return 'backgrounded · abc12345 · Bound run'
    if (args[0] === 'agents') {
      listings.push(opts.cwd)
      const remote = opts.cwd === roots[A] ? A : B
      return JSON.stringify([
        {
          kind: 'background',
          id: sessions[remote],
          name: 'Startup session',
          sessionId:
            remote === A
              ? '123e4567-e89b-42d3-a456-426614174001'
              : '123e4567-e89b-42d3-a456-426614174002',
          cwd: opts.cwd,
          pid: process.pid,
          status: 'busy',
        },
      ])
    }
    return '[]'
  })
  const post = (remote: typeof A | typeof B) =>
    fetch(
      `http://127.0.0.1:${bridge.port()}/turn/end?t=${encodeURIComponent(bridge.tokenForVault(remote))}&job=${sessions[remote]}&pid=${process.pid}`,
      { method: 'POST' },
    )
  try {
    const base = Object.fromEntries(
      await Promise.all(
        ([A, B] as const).map(async (remote) => [
          remote,
          execFileSync('git', ['-C', roots[remote], 'rev-parse', 'HEAD'], {
            encoding: 'utf8',
          }).trim(),
        ]),
      ),
    ) as Record<typeof A | typeof B, string>
    await enter(A)
    await enter(B)
    await vi.waitFor(() => {
      expect(syncHolds.get(A)).toBe(1)
      expect(syncHolds.get(B)).toBe(1)
    })
    expect(listings).toEqual(expect.arrayContaining([roots[A], roots[B]]))

    for (const remote of [A, B] as const) expect((await post(remote)).status).toBe(200)
    for (const remote of [A, B] as const) {
      await vi.waitFor(async () => {
        expect(await openTurnLog(roots[remote]).list()).toEqual([
          expect.objectContaining({
            base: base[remote],
            end: base[remote],
            sessionId: sessions[remote],
          }),
        ])
      })
      await vi.waitFor(() => expect(syncHolds.get(remote)).toBe(0))
    }
  } finally {
    await host.stopAll()
  }
})

it('binds real hook reports, inbox delivery, and native commands to activation vaults', async () => {
  const { host, enter, call, roots, bridge, userData } = await rig(undefined, undefined, true)
  const received: Record<'A' | 'B' | 'A2', string[]> = { A: [], B: [], A2: [] }
  const inboxServers: ReturnType<typeof createServer>[] = []
  const inboxSockets: string[] = []
  const inbox = async (owner: 'A' | 'B' | 'A2') => {
    const socket = join(tmpdir(), `holi-agent-inbox-${process.pid}-${owner}-${Date.now()}.sock`)
    inboxSockets.push(socket)
    const server = createServer((connection) => {
      let bytes = ''
      connection.on('data', (chunk) => (bytes += chunk.toString()))
      connection.on('end', () => received[owner]!.push(bytes))
    })
    inboxServers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socket, resolve)
    })
    return { socket, token: `token_${owner}_123` }
  }
  const post = async (remote: string, path: string, query = '', body = '') => {
    const token = bridge.tokenForVault(remote)
    return fetch(
      `http://127.0.0.1:${bridge.port()}${path}?t=${encodeURIComponent(token)}${query}`,
      {
        method: 'POST',
        body,
      },
    )
  }
  try {
    // The same real Claude job id and conversation id deliberately exist in
    // both listings. Only cwd distinguishes the owners.
    const listingEntered = deferred()
    const releaseListing = deferred()
    let gated = false
    let listingStatusB: 'busy' | 'idle' = 'busy'
    adapters.run.mockImplementation(async (_bin, args, opts) => {
      if (args.includes('--bg')) return 'backgrounded · abc12345 · Bound run'
      if (args[0] === 'agents') {
        if (opts.cwd === roots[A] && !gated) {
          gated = true
          listingEntered.resolve()
          await releaseListing.promise
        }
        return JSON.stringify([
          {
            kind: 'background',
            id: 'abc12345',
            name: 'Owner session',
            sessionId: '123e4567-e89b-42d3-a456-426614174000',
            cwd: opts.cwd,
            pid: process.pid,
            status: opts.cwd === roots[B] ? listingStatusB : 'idle',
          },
        ])
      }
      return '[]'
    })
    const enteringA = enter(A)
    await listingEntered.promise
    expect(adapters.routes.has(A)).toBe(false)
    releaseListing.resolve()
    await enteringA
    expect(adapters.routes.has(A)).toBe(true)
    await enter(B)
    expect(await readFile(join(roots[A], '.fixture-owner'), 'utf8')).toBe(A)
    expect(await readFile(join(roots[B], '.fixture-owner'), 'utf8')).toBe(B)
    host.setDisplayed(B)
    const channelA = await inbox('A')
    const channelB = await inbox('B')

    // Genuine HTTP hook routes populate the two activation-local channels.
    for (const [remote, channel] of [
      [A, channelA],
      [B, channelB],
    ] as const) {
      expect(
        (await post(remote, '/session', '&job=abc12345', JSON.stringify(channel))).status,
      ).toBe(204)
      expect(
        (
          await post(
            remote,
            '/statusline',
            '&job=abc12345',
            JSON.stringify({
              context_window: { used_percentage: remote === A ? 17 : 83 },
              model: { display_name: remote === A ? 'Model A' : 'Model B' },
            }),
          )
        ).status,
      ).toBe(204)
      expect(
        (
          await post(
            remote,
            '/turn/start',
            `&job=abc12345&pid=${process.pid}`,
            JSON.stringify(channel),
          )
        ).status,
      ).toBe(204)
    }
    const aSessions = (await call(A, 'agent.sessions')) as {
      id: string
      state: string
      contextPercent?: number
      model?: string
    }[]
    const bSessions = (await call(B, 'agent.sessions')) as {
      id: string
      state: string
      contextPercent?: number
      model?: string
    }[]
    expect(aSessions).toEqual([
      expect.objectContaining({
        id: 'abc12345',
        state: 'working',
        contextPercent: 17,
        model: 'Model A',
      }),
    ])
    expect(bSessions).toEqual([
      expect.objectContaining({
        id: 'abc12345',
        state: 'working',
        contextPercent: 83,
        model: 'Model B',
      }),
    ])
    const settledA = await post(A, '/turn/end', '&job=abc12345&pending=2')
    expect(settledA.status).toBe(200)

    host.setDisplayed(A)
    await expect(
      call(A, 'agent.message', { session: 'abc12345', text: 'message A' }),
    ).resolves.toEqual({ ok: true })
    host.setDisplayed(B)
    await expect(
      call(B, 'agent.message', { session: 'abc12345', text: 'message B' }),
    ).resolves.toEqual({ ok: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(received.A.join('')).toContain('message A')
    expect(received.A.join('')).toContain(channelA.token)
    expect(received.B.join('')).toContain('message B')
    expect(received.B.join('')).toContain(channelB.token)
    expect(received.A.join('')).not.toContain('message B')
    expect(received.B.join('')).not.toContain('message A')

    // A tiny real Pi RPC child gives the actual capability dispatch distinct
    // owner replies without substituting the session host or dispatch table.
    const rpc = join(userData, 'pi-rpc-fixture')
    await writeFile(
      rpc,
      `#!/usr/bin/env node\nconst readline=require('node:readline');\nprocess.on('SIGTERM',()=>process.exit(0));\nconst rl=readline.createInterface({input:process.stdin});\nrl.on('line',line=>{const c=JSON.parse(line); if(c.type==='prompt'){const text=process.cwd().endsWith('vault-a')?'reply-A':'reply-B'; const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n'); emit({type:'agent_start'}); emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:text}}); emit({type:'message_end',message:{role:'assistant',stopReason:'stop'}}); emit({type:'agent_settled'});} else if(c.type==='get_session_stats'){process.stdout.write(JSON.stringify({type:'response',id:c.id,success:true,data:{}})+'\\n');}});\n`,
    )
    await chmod(rpc, 0o755)
    const pi = { ...PRESETS.find((preset) => preset.id === 'pi')!, command: { bin: rpc, args: [] } }
    await call(A, 'agent.harnessSave', { harness: pi })
    await call(B, 'agent.harnessSave', { harness: pi })
    const launchPi = async (remote: typeof A | typeof B) =>
      call(remote, 'agent.launch', {
        provider: 'pi',
        name: `${remote} reply`,
        prompt: 'answer',
        tools: 'none',
        keep: true,
      }) as Promise<{ ok: boolean; sessionId: string }>
    const piA = await launchPi(A)
    const piB = await launchPi(B)
    expect(piA.ok).toBe(true)
    expect(piB.ok).toBe(true)
    const settledReply = async (remote: typeof A | typeof B, session: string) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = (await call(remote, 'agent.reply', { session })) as {
          output: string | null
        }
        if (result.output !== null) return result
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error(`Pi reply did not settle for ${remote}`)
    }
    const replyA = await settledReply(A, piA.sessionId)
    const replyB = await settledReply(B, piB.sessionId)
    expect(replyA.output).toBe('reply-A')
    expect(replyB.output).toBe('reply-B')
    await expect(call(A, 'agent.reply', { session: piB.sessionId })).rejects.toThrow(/Pi run/)
    await expect(call(B, 'agent.reply', { session: piA.sessionId })).rejects.toThrow(/Pi run/)
    expect(
      adapters.run.mock.calls.some(([, args]) => args.includes('--dangerously-skip-permissions')),
    ).toBe(false)

    const settledTurns = async (remote: typeof A | typeof B, sessionId: string) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const turns = (await call(remote, 'agent.turns')) as { sessionId: string }[]
        if (turns.some((turn) => turn.sessionId === sessionId)) return turns
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error(`Pi turn log did not settle for ${remote}`)
    }
    const turnsA = await settledTurns(A, piA.sessionId)
    const turnsB = await settledTurns(B, piB.sessionId)
    expect(turnsA.map((turn) => turn.sessionId)).toContain('abc12345')
    expect(turnsB.map((turn) => turn.sessionId)).not.toContain('abc12345')
    await expect(call(A, 'agent.reply', { session: 'abc12345' })).rejects.toThrow(/Pi run/)
    await expect(
      call(B, 'agent.message', { session: 'deadbeef', text: 'wrong owner' }),
    ).rejects.toThrow()

    // Stop is dispatched to each activation's real Claude CLI adapter, not to
    // the displayed vault. Its command cwd and private config target are asserted.
    host.setDisplayed(B)
    expect(await call(A, 'agent.stop', { id: 'abc12345' })).toMatchObject({ ok: true })
    host.setDisplayed(A)
    expect(await call(B, 'agent.stop', { id: 'abc12345' })).toMatchObject({ ok: true })
    const stopCommands = adapters.run.mock.calls.filter(
      ([, args]) => args[0] === 'stop' && args[1] === 'abc12345',
    )
    expect(stopCommands.map(([, , opts]) => opts.cwd)).toEqual([roots[A], roots[B]])
    const stopConfigDirs = stopCommands.map(([, , opts]) => opts.env.CLAUDE_CONFIG_DIR)
    expect(stopConfigDirs[0]).toContain('fixture-a-')
    expect(stopConfigDirs[1]).toContain('fixture-b-')
    expect(stopConfigDirs[0]).not.toBe(stopConfigDirs[1])

    // Leaving A unregisters its HTTP routes and releases its channel. Restart
    // A creates fresh routes; B's activation and channel remain live.
    await host.stop(A)
    expect((await post(A, '/turn/start', '&job=abc12345', JSON.stringify(channelA))).status).toBe(
      404,
    )
    await expect(
      call(B, 'agent.message', { session: 'abc12345', text: 'B still live' }),
    ).resolves.toEqual({ ok: true })
    const channelA2 = await inbox('A2')
    await enter(A)
    expect((await post(A, '/session', '&job=abc12345', JSON.stringify(channelA2))).status).toBe(204)
    expect(
      (
        await post(
          A,
          '/statusline',
          '&job=abc12345',
          JSON.stringify({
            context_window: { used_percentage: 29 },
            model: { display_name: 'Model A2' },
          }),
        )
      ).status,
    ).toBe(204)
    host.setDisplayed(B)
    await expect(
      call(A, 'agent.message', { session: 'abc12345', text: 'message A2' }),
    ).resolves.toEqual({ ok: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(received.A2.join('')).toContain('message A2')
    expect(received.A.join('')).not.toContain('message A2')
    const aLive = (await call(A, 'agent.sessions')) as {
      provider: string
      contextPercent?: number
      model?: string
    }[]
    const bLive = (await call(B, 'agent.sessions')) as {
      provider: string
      contextPercent?: number
      model?: string
    }[]
    expect(aLive.filter((session) => session.provider === 'claude')).toEqual([
      expect.objectContaining({ contextPercent: 29, model: 'Model A2' }),
    ])
    expect(bLive.filter((session) => session.provider === 'claude')).toEqual([
      expect.objectContaining({ contextPercent: 83, model: 'Model B' }),
    ])
    expect(bLive.find((session) => session.provider === 'pi')).toMatchObject({ provider: 'pi' })
    expect(
      adapters.run.mock.calls
        .filter(([, args]) => args[0] === 'agents')
        .map(([, , opts]) => opts.cwd),
    ).toContain(roots[A])

    // Keep B busy through the cross-vault assertions above so the real idle
    // recheck cannot release its turn during teardown. Then explicitly end it
    // and wait for the B-owned record before exercising the actual recheck.
    const baseB = execFileSync('git', ['-C', roots[B], 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    const settledB = await post(B, '/turn/end', '&job=abc12345')
    expect(settledB.status).toBe(200)
    const bTurns = async () =>
      (await call(B, 'agent.turns')) as { sessionId: string; base: string }[]
    await vi.waitFor(async () => {
      expect((await bTurns()).find((turn) => turn.sessionId === 'abc12345')).toMatchObject({
        base: baseB,
      })
    })

    // A second turn is intentionally left to the listing's idle confirmation.
    // This crosses the production 1.1s recheck interval and waits on the
    // persisted record rather than sleeping or relying on host.stopAll.
    listingStatusB = 'idle'
    expect(
      (await post(B, '/turn/start', `&job=abc12345&pid=${process.pid}`, JSON.stringify(channelB)))
        .status,
    ).toBe(204)
    await writeFile(join(roots[B], 'idle-recheck.txt'), 'completed turn')
    execFileSync('git', ['-C', roots[B], 'add', 'idle-recheck.txt'])
    execFileSync('git', ['-C', roots[B], 'commit', '-qm', 'fixture turn work'])
    await call(B, 'agent.sessions')
    await vi.waitFor(
      async () => {
        expect((await bTurns()).filter((turn) => turn.sessionId === 'abc12345')).toHaveLength(2)
      },
      { timeout: 5_000, interval: 25 },
    )
  } finally {
    await host.stopAll()
    await Promise.all(
      inboxServers.map(async (server) => {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }),
    )
    await Promise.all(inboxSockets.map((socket) => rm(socket, { force: true })))
    await Promise.all(inboxSockets.map((socket) => expect(access(socket)).rejects.toThrow()))
  }
})

it.each(['success', 'failure'] as const)(
  'drains a real needs-you inbox write before stopping vault A (%s)',
  async (outcome) => {
    const { host, enter, call, roots, bridge, expectFailedDrain } = await rig(
      undefined,
      undefined,
      true,
    )
    const sessions = { [A]: 'abc12345', [B]: 'abc12345' }
    const listingStatus: Record<typeof A | typeof B, 'idle' | 'waiting'> = {
      [A]: 'idle',
      [B]: 'idle',
    }
    let extraWaitingSession = false
    adapters.run.mockImplementation(async (_bin, args, opts) => {
      if (args.includes('--bg')) return 'backgrounded · abc12345 · Bound run'
      if (args[0] === 'agents') {
        const remote = opts.cwd === roots[A] ? A : B
        const rows = [
          {
            kind: 'background',
            id: sessions[remote],
            name: `Session ${remote}`,
            sessionId: '123e4567-e89b-42d3-a456-426614174001',
            cwd: opts.cwd,
            pid: process.pid,
            status: listingStatus[remote],
            ...(listingStatus[remote] === 'waiting' ? { waitingFor: 'permission' } : {}),
          },
        ]
        if (remote === A && extraWaitingSession)
          rows.push({
            kind: 'background',
            id: 'deadbeef',
            name: 'Queued session',
            sessionId: '123e4567-e89b-42d3-a456-426614174003',
            cwd: opts.cwd,
            pid: process.pid,
            status: 'waiting',
            waitingFor: 'permission',
          })
        return JSON.stringify(rows)
      }
      return '[]'
    })
    const postStatusline = (remote: typeof A | typeof B) =>
      fetch(
        `http://127.0.0.1:${bridge.port()}/statusline?t=${encodeURIComponent(bridge.tokenForVault(remote))}&job=abc12345`,
        {
          method: 'POST',
          body: JSON.stringify({
            context_window: { used_percentage: remote === A ? 17 : 83 },
            model: { display_name: `Model ${remote}` },
          }),
        },
      )
    const aInboxPath = join(roots[A], '.holi/state/inbox.local.json')
    const inboxFile = async (remote: typeof A | typeof B) =>
      readFile(join(roots[remote], '.holi/state/inbox.local.json'), 'utf8').then(
        (contents) => JSON.parse(contents) as { entries: { session?: string }[] },
        (error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [] }
          throw error
        },
      )
    const writeEntered = deferred()
    const releaseWrite = deferred()
    let writeAdmitted = false
    try {
      await enter(A)
      await enter(B)
      for (const remote of [A, B] as const) {
        expect(await call(remote, 'agent.sessions')).toEqual([
          expect.objectContaining({ id: 'abc12345', state: 'idle' }),
        ])
      }
      const configDirs = Object.fromEntries(
        ([A, B] as const).map((remote) => {
          const call = adapters.run.mock.calls.find(
            ([, args, opts]) => args[0] === 'agents' && opts.cwd === roots[remote],
          )
          const configDir = call?.[2].env.CLAUDE_CONFIG_DIR
          if (configDir === undefined) throw new Error(`No Claude config dir for ${remote}`)
          return [remote, configDir]
        }),
      ) as Record<typeof A | typeof B, string>
      adapters.historyRename = {
        source: aInboxPath,
        entered: () => {
          writeAdmitted = true
          writeEntered.resolve()
        },
        wait: releaseWrite.promise,
        ...(outcome === 'failure' ? { error: new Error('held inbox rename failed') } : {}),
      }
      listingStatus[A] = 'waiting'
      listingStatus[B] = 'waiting'
      for (const remote of [A, B] as const) expect((await postStatusline(remote)).status).toBe(204)
      // Force an actual capability read after the statusline, then keep
      // delivering real watcher changes until its admitted inbox write begins.
      await call(A, 'agent.sessions')
      for (const remote of [A, B] as const) {
        await mkdir(join(configDirs[remote], 'sessions'), { recursive: true })
      }
      let refreshAttempt = 0
      await vi.waitFor(
        async () => {
          if (!writeAdmitted) {
            const attempt = ++refreshAttempt
            for (const remote of [A, B] as const) {
              await writeFile(
                join(configDirs[remote], 'sessions', `needs-you-refresh-${attempt}.json`),
                '{}',
              )
            }
          }
          expect(writeAdmitted).toBe(true)
        },
        { interval: 200 },
      )
      await writeEntered.promise
      listingStatus[A] = 'idle'
      extraWaitingSession = true
      expect((await postStatusline(A)).status).toBe(204)
      await writeFile(join(configDirs[A], 'sessions', 'queued-needs-you.json'), '{}')
      await vi.waitFor(async () => {
        expect(await call(A, 'agent.sessions')).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: 'abc12345', state: 'idle' }),
            expect.objectContaining({ id: 'deadbeef', state: 'needs-you' }),
          ]),
        )
      })
      let stoppedA = false
      const stoppingA = host.stop(A).then(
        () => {
          stoppedA = true
          return undefined
        },
        (error: unknown) => {
          stoppedA = true
          return error
        },
      )
      await Promise.resolve()
      expect(stoppedA).toBe(false)
      host.setDisplayed(B)
      await vi.waitFor(async () => {
        expect(await call(B, 'agent.sessions')).toEqual([
          expect.objectContaining({ id: 'abc12345', state: 'needs-you' }),
        ])
      })
      await vi.waitFor(async () => {
        expect(await inboxFile(B)).toMatchObject({
          entries: [expect.objectContaining({ session: 'abc12345' })],
        })
      })
      host.setDisplayed(A)
      expect(await inboxFile(A)).toMatchObject({ entries: [] })

      releaseWrite.resolve()
      if (outcome === 'success') {
        expect(await stoppingA).toBeUndefined()
        host.setDisplayed(B)
        expect(await inboxFile(B)).toMatchObject({
          entries: [expect.objectContaining({ session: 'abc12345' })],
        })
        expect((await inboxFile(A)).entries).toEqual([
          expect.objectContaining({ session: 'abc12345' }),
        ])
        extraWaitingSession = false
        await enter(A)
        host.setDisplayed(A)
        expect(await inboxFile(A)).toMatchObject({
          entries: [expect.objectContaining({ session: 'abc12345' })],
        })
        listingStatus[A] = 'idle'
        await call(A, 'agent.sessions')
        listingStatus[A] = 'waiting'
        expect((await postStatusline(A)).status).toBe(204)
        await call(A, 'agent.sessions')
        await vi.waitFor(async () => {
          expect(await inboxFile(A)).toMatchObject({
            entries: [expect.objectContaining({ session: 'abc12345' })],
          })
        })
      } else {
        const stopFailure = await stoppingA
        expect(stopFailure).toBeInstanceOf(Error)
        expect(nestedErrors(stopFailure)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ message: 'held inbox rename failed' }),
          ]),
        )
        expectFailedDrain()
        await expect(host.stop(A)).rejects.toThrow('failed to stop')
        host.setDisplayed(B)
        expect(await inboxFile(B)).toMatchObject({
          entries: [expect.objectContaining({ session: 'abc12345' })],
        })
      }
      await host.stop(B)
    } finally {
      releaseWrite.resolve()
      if (adapters.historyRename?.source === aInboxPath) adapters.historyRename = null
    }
  },
)

it('persists concurrent provider turn reports through each activated vault route', async () => {
  const { host, enter, call, roots, setActive } = await rig(undefined, undefined, true)
  await enter(A)
  await enter(B)
  // Force each real background-session host to finish attaching to its vault
  // before driving the provider's registered hook routes.
  for (const remote of [A, B] as const) {
    setActive(remote)
    await call(remote, 'agent.sessions')
  }
  const jobs = ['a1234567']
  const routesFor = (remote: string) => adapters.routes.get(remote)!
  const report = (remote: string, path: string, job: string) => {
    const query = new URLSearchParams({ job })
    // The fake Claude process is not in a real listing, so identify the active
    // producer with this live test process just as a hook supplies its PID.
    if (path === '/turn/start') query.set('pid', String(process.pid))
    return routesFor(remote).get(path)!.handle(remote, query, '', new AbortController().signal)
  }
  for (const remote of [A, B] as const) {
    setActive(remote)
    await Promise.all(jobs.map((job) => report(remote, '/turn/start', job)))
  }
  const endings = await Promise.all(
    ([A, B] as const).flatMap((remote) => {
      setActive(remote)
      return jobs.map((job) => report(remote, '/turn/end', job))
    }),
  )
  expect(endings).toHaveLength(2)
  expect(endings.every((reply) => reply.status === 200)).toBe(true)

  const expected = expect.arrayContaining(
    jobs.map((job) => expect.objectContaining({ base: expect.any(String), sessionId: job })),
  )
  const aTurns = (await call(A, 'agent.turns')) as { base: string; sessionId: string }[]
  const bTurns = (await call(B, 'agent.turns')) as { base: string; sessionId: string }[]
  expect(aTurns).toHaveLength(1)
  expect(bTurns).toHaveLength(1)
  expect(aTurns).toEqual(expected)
  expect(bTurns).toEqual(expected)
  expect(aTurns.map((turn) => turn.base)).not.toEqual(bTurns.map((turn) => turn.base))
  expect(aTurns.every((turn) => jobs.includes(turn.sessionId))).toBe(true)
  expect(bTurns.every((turn) => jobs.includes(turn.sessionId))).toBe(true)
  await host.stop(A)
  await enter(A)
  expect(await call(A, 'agent.turns')).toEqual(aTurns)
  expect(await call(B, 'agent.turns')).toEqual(bTurns)
  expect(await openTurnLog(roots[A]).list()).toEqual(aTurns)
  expect(await openTurnLog(roots[B]).list()).toEqual(bTurns)
})

it('activates real agents and shares save/remove/reset/reload and remote notifications', async () => {
  const { host, enter, call, sent, userData } = await rig()
  await enter(A)
  await enter(B)
  expect(host.failures(A)).toEqual({})
  expect(host.failures(B)).toEqual({})
  expect(await call(A, 'agent.harnesses')).toEqual(await call(B, 'agent.harnesses'))
  await call(A, 'agent.harnessSave', { harness, create: true })
  expect(await call(B, 'agent.harnesses')).toMatchObject(customRow)
  expect(sent).toContainEqual({ remote: A, name: 'providers' })
  expect(sent).toContainEqual({ remote: B, name: 'providers' })
  await call(B, 'agent.harnessRemove', { id: harness.id })
  expect(await call(A, 'agent.harnesses')).not.toMatchObject(customRow)
  await call(A, 'agent.harnessSave', { harness, create: true })
  await host.stop(A)
  await enter(A)
  expect(host.failures(A)).toEqual({})
  expect(await call(B, 'agent.harnesses')).toMatchObject(customRow)
  await call(B, 'agent.harnessReset')
  expect(await call(A, 'agent.harnesses')).not.toMatchObject(customRow)
  await writeFile(
    join(userData, 'agent-harnesses.json'),
    JSON.stringify({ version: 1, harnesses: [harness] }),
  )
  await call(A, 'agent.harnesses')
  expect(await call(B, 'agent.harnesses')).toMatchObject(customRow)
  const other = await rig()
  await other.enter(A)
  expect(await other.call(A, 'agent.harnesses')).not.toMatchObject(customRow)
})

it('keeps real native provider commands and vault configuration local after a shared edit', async () => {
  const { host, enter, call, capabilities, roots, userData } = await rig()
  await enter(A)
  await enter(B)
  const codex = {
    ...PRESETS[1]!,
    command: { bin: process.execPath, args: ['--first-preset'] },
    env: { OWNER_TEST: 'first', CODEX_HOME: join(userData, 'synthetic-codex') },
  }
  await call(A, 'agent.harnessSave', { harness: codex })
  expect(await call(B, 'agent.start', { provider: 'codex', prompt: 'B first' })).toMatchObject({
    ok: true,
  })
  const first = adapters.pty.at(-1)!
  expect(first.cwd).toBe(roots[B])
  expect(first.bin).toBe(process.execPath)
  expect(first.args).toEqual(expect.arrayContaining(['--first-preset', '--', 'B first']))
  expect(first.env).toMatchObject({ OWNER_TEST: 'first', CODEX_HOME: codex.env.CODEX_HOME })
  await call(A, 'agent.harnessSave', {
    harness: {
      ...codex,
      command: { ...codex.command, args: ['--second-preset'] },
      env: { ...codex.env, OWNER_TEST: 'second' },
    },
  })
  expect(adapters.pty).toHaveLength(1)
  expect(await call(B, 'agent.start', { provider: 'codex', prompt: 'B next' })).toMatchObject({
    ok: true,
  })
  expect(adapters.pty.at(-1)).toMatchObject({
    cwd: roots[B],
    args: expect.arrayContaining(['--second-preset', 'B next']),
    env: { OWNER_TEST: 'second' },
  })
  expect(first.env.OWNER_TEST).toBe('first')
  expect(await call(A, 'agent.start', { provider: 'codex', prompt: 'A next' })).toMatchObject({
    ok: true,
  })
  expect(adapters.pty.at(-1)?.cwd).toBe(roots[A])
  await call(A, 'agent.harnessSave', {
    harness: { ...PRESETS[0]!, command: { bin: process.execPath, args: [] } },
  })
  for (const remote of [A, B] as const) {
    expect(
      await call(remote, 'agent.launch', { name: `${remote} bound`, prompt: `${remote} prompt` }),
    ).toMatchObject({ ok: true })
  }
  const launches = adapters.run.mock.calls.filter(([, args]) => args.includes('--bg'))
  expect(launches).toHaveLength(2)
  expect(launches.map(([, , opts]) => opts.cwd)).toEqual([roots[A], roots[B]])
  expect(launches[0]![2].env.CLAUDE_CONFIG_DIR).not.toBe(launches[1]![2].env.CLAUDE_CONFIG_DIR)
  for (const [bin, args, opts] of launches) {
    expect(bin).toBe(process.execPath)
    expect(args).toContain('--')
    expect(opts.env.CLAUDE_CONFIG_DIR).toContain(join(userData, 'agent-config'))
    expect(args).not.toContain('--dangerously-skip-permissions')
  }
  await expect(
    capabilities.dispatch({ door: 'cli', remote: A, name: 'agent.harnessReset', params: {} }),
  ).rejects.toThrow()
  const schedule = (await call(B, 'schedules.save', {
    draft: { name: 'Bound automation', crons: ['0 0 1 1 *'], prompt: 'Scheduled B', allow: [] },
  })) as { path: string; fingerprint: string }
  await expect(call(B, 'schedules.run', { schedule: schedule.path })).rejects.toThrow()
  await call(B, 'schedules.enable', {
    schedule: schedule.path,
    fingerprint: schedule.fingerprint,
  })
  const scheduleFile = join(roots[B], schedule.path)
  const scheduleText = await readFile(scheduleFile, 'utf8')
  await writeFile(scheduleFile, scheduleText.replace('Scheduled B', 'Changed scheduled B'))
  await expect(call(B, 'schedules.run', { schedule: schedule.path })).rejects.toThrow()
  const changedSchedule = (await call(B, 'schedules.list')) as {
    path: string
    fingerprint?: string
  }[]
  const changed = changedSchedule.find((entry) => entry.path === schedule.path)
  expect(changed?.fingerprint).toBeTruthy()
  await call(B, 'schedules.enable', {
    schedule: schedule.path,
    fingerprint: changed!.fingerprint,
  })
  await call(B, 'schedules.run', { schedule: schedule.path })
  const scheduled = adapters.run.mock.calls
    .filter(([, args]) => args.some((arg) => arg.includes('Changed scheduled B')))
    .at(-1)!
  expect(scheduled[2].cwd).toBe(roots[B])
  expect(scheduled[2].env.CLAUDE_CONFIG_DIR).toBe(launches[1]![2].env.CLAUDE_CONFIG_DIR)
  await host.stop(A)
  expect(await call(B, 'agent.start', { provider: 'codex', prompt: 'B survives' })).toMatchObject({
    ok: true,
  })
  expect(adapters.pty.at(-1)?.cwd).toBe(roots[B])
})

it('rejects late UI config dispatch after A releases ownership but before unregistering', async () => {
  const enteredDispose = deferred()
  const releaseDispose = deferred()
  const { host, enter, call, sent, userData } = await rig(undefined, {
    entered: enteredDispose.resolve,
    wait: releaseDispose.promise,
  })
  let stopping: Promise<void> | undefined
  try {
    await enter(A)
    stopping = host.stop(A)
    await enteredDispose.promise

    // A's real disposer has released its sole owner handle, but the host still
    // serves its capabilities until this wrapper lets stopOne finish.
    await enter(B)
    const codex = {
      ...PRESETS[1]!,
      command: { bin: process.execPath, args: ['--live-owner'] },
    }
    await call(B, 'agent.harnessSave', { harness: codex })
    const disk = await readFile(join(userData, 'agent-harnesses.json'), 'utf8')
    const bListing = await call(B, 'agent.harnesses')
    const bNotices = sent.filter((event) => event.name === 'providers').length
    for (const [name, params] of [
      ['agent.harnessSave', { harness: { ...harness, id: 'late-save' }, create: true }],
      ['agent.harnessRemove', { id: 'codex' }],
      ['agent.harnessReset', {}],
      ['agent.harnesses', {}],
    ] as const) {
      await expect(call(A, name, params)).rejects.toThrow(/disposed|no such method/)
    }
    expect(await readFile(join(userData, 'agent-harnesses.json'), 'utf8')).toBe(disk)
    expect(sent.filter((event) => event.name === 'providers')).toHaveLength(bNotices)
    expect(await call(B, 'agent.harnesses')).toEqual(bListing)

    expect(
      await call(B, 'agent.start', { provider: 'codex', prompt: 'B remains live' }),
    ).toMatchObject({ ok: true })
    expect(adapters.pty.at(-1)).toMatchObject({
      cwd: join(userData, 'vault-b'),
      bin: process.execPath,
      args: expect.arrayContaining(['--live-owner', 'B remains live']),
    })
  } finally {
    releaseDispose.resolve()
    await stopping
    await host.stopAll()
  }
})

it('releases failed activation ownership so a fresh activation reads current disk state', async () => {
  const { host, enter, call, userData } = await rig()
  adapters.version.mockImplementationOnce(() => {
    throw new Error('native activation failed')
  })
  await enter(A)
  expect(host.failures(A).agent).toContain('native activation failed')
  await enter(B)
  await call(B, 'agent.harnessSave', { harness, create: true })
  await host.stop(B)
  await writeFile(
    join(userData, 'agent-harnesses.json'),
    JSON.stringify({ version: 1, harnesses: [] }),
  )
  await enter(A)
  expect(host.failures(A)).toEqual({})
  expect(await call(A, 'agent.providers')).not.toContainEqual(
    expect.objectContaining({ id: harness.id }),
  )
})

it('closes the session watcher after activation failure and retries with one watcher', async () => {
  const { host, enter, registry } = await rig()
  vi.spyOn(registry, 'register').mockImplementationOnce(() => {
    throw new Error('registration adapter failed')
  })

  await enter(A)
  expect(host.failures(A).agent).toContain('registration adapter failed')
  expect(adapters.watchStarts).toBe(1)
  expect(adapters.watchCloses).toBe(1)

  await enter(A)
  expect(host.failures(A)).toEqual({})
  expect(adapters.watchStarts).toBe(2)
  expect(adapters.watchCloses).toBe(1)
  await host.stop(A)
  expect(adapters.watchCloses).toBe(2)
})

it('drains an admitted real activation write while the other activation stays usable', async () => {
  const { host, enter, call, sent, userData } = await rig()
  await enter(A)
  await enter(B)
  await call(A, 'agent.harnessSave', { harness, create: true })
  const entered = deferred()
  const release = deferred()
  adapters.backup = {
    source: join(userData, 'agent-harnesses.json'),
    entered: entered.resolve,
    wait: release.promise,
  }
  const write = call(A, 'agent.harnessReset')
  await entered.promise
  let stopped = false
  const stop = host.stop(A).then(() => {
    stopped = true
  })
  try {
    expect(await call(B, 'agent.providers')).toContainEqual(
      expect.objectContaining({ id: harness.id }),
    )
    expect(stopped).toBe(false)
  } finally {
    release.resolve()
    await Promise.all([write, stop])
  }
  expect(stopped).toBe(true)
  expect(await call(B, 'agent.harnesses')).not.toMatchObject(customRow)
  const before = sent.filter((event) => event.remote === A && event.name === 'providers').length
  await call(B, 'agent.harnessSave', { harness, create: true })
  expect(sent.filter((event) => event.remote === A && event.name === 'providers')).toHaveLength(
    before,
  )
})

it.each([false, true] as const)(
  'drains the real focus report write before stopping its vault (failure: %s)',
  async (failWrite) => {
    const { host, enter, roots, expectFailedDrain } = await rig()
    const enteredWrite = deferred()
    const releaseWrite = deferred()
    const fileA = join(roots[A], '.holi/state/context.local.json')
    const fileB = join(roots[B], '.holi/state/context.local.json')
    adapters.contextRename = {
      destination: fileA,
      entered: enteredWrite.resolve,
      wait: releaseWrite.promise,
      ...(failWrite ? { error: new Error('context rename failed') } : {}),
    }
    const report = (focusedPath: string) => ({
      focusedPath,
      selection: null,
      openPaths: [focusedPath],
      recents: [],
    })
    let stopping: Promise<void> | undefined
    try {
      await enter(A)
      await enter(B)
      host.report(A, report('notes/a.md'))
      host.report(B, report('notes/b.md'))
      await enteredWrite.promise
      let stopped = false
      stopping = host.stop(A).then(() => {
        stopped = true
      })
      expect(stopped).toBe(false)
      host.report(A, report('notes/late.md'))
      host.report(B, report('notes/still-live.md'))
      await vi.waitFor(async () => {
        expect(JSON.parse(await readFile(fileB, 'utf8'))).toMatchObject({
          focusedPath: 'notes/still-live.md',
        })
      })
      expect(stopped).toBe(false)
      releaseWrite.resolve()
      if (failWrite) {
        expectFailedDrain()
        const failure = await stopping!.catch((error: unknown) => error)
        expect(nestedErrors(failure)).toContainEqual(
          expect.objectContaining({ message: 'context rename failed' }),
        )
        await expect(enter(A)).rejects.toBe(failure)
      } else {
        await stopping
        expect(JSON.parse(await readFile(fileA, 'utf8'))).toMatchObject({
          focusedPath: 'notes/a.md',
        })
      }
      expect(await readFile(fileB, 'utf8')).toContain('notes/still-live.md')
    } finally {
      releaseWrite.resolve()
      await stopping?.catch(() => {})
    }
  },
)

it('drains a cancelled background launch before stopping and restarting its original vault', async () => {
  const { host, enter, call, roots, userData } = await rig()
  const entered = deferred()
  const release = deferred()
  const pi = { ...PRESETS[0]!, command: { bin: process.execPath, args: [] } }
  try {
    await enter(A)
    await enter(B)
    await call(A, 'agent.harnessSave', { harness: pi })
    await call(B, 'agent.harnessSave', { harness: pi })
    adapters.run.mockImplementation(async (_bin, args, opts) => {
      if (args.includes('--bg') && opts.cwd === roots[A]) {
        entered.resolve()
        await release.promise
        return 'backgrounded · abc12345 · Late A run'
      }
      if (args.includes('--bg') && opts.cwd === roots[B]) return 'backgrounded · abc12345 · B run'
      return '[]'
    })
    const launch = call(A, 'agent.launch', { provider: 'claude', name: 'A', prompt: 'start' })
    await entered.promise
    await expect(
      call(B, 'agent.launch', { provider: 'claude', name: 'B', prompt: 'works' }),
    ).resolves.toMatchObject({ ok: true })
    const stopping = host.stop(A)
    const joining = host.stop(A)
    let stopped = false
    void stopping.then(() => {
      stopped = true
    })
    expect(stopped).toBe(false)
    release.resolve()
    const result = (await launch) as { ok: boolean; error?: string }
    await Promise.all([stopping, joining])
    expect(result.ok).toBe(false)
    expect(
      adapters.run.mock.calls.filter(([, args]) => args[0] === 'stop').at(-1)?.[2],
    ).toMatchObject({
      cwd: roots[A],
      env: { CLAUDE_CONFIG_DIR: expect.stringContaining(join(userData, 'agent-config')) },
    })
    expect(await call(B, 'agent.harnesses')).toMatchObject({ agents: expect.any(Array) })
    await host.stop(A)
    await enter(A)
    expect(await call(A, 'agent.harnesses')).toMatchObject({ agents: expect.any(Array) })
  } finally {
    release.resolve()
  }
})

it.each(['unsuccessful stop', 'throwing stop'] as const)(
  'keeps cancelled launch cleanup failure latched after %s',
  async (failureKind) => {
    const { host, enter, call, roots, expectFailedDrain } = await rig()
    const entered = deferred()
    const release = deferred()
    const pi = { ...PRESETS[0]!, command: { bin: process.execPath, args: [] } }
    try {
      await enter(A)
      await enter(B)
      await call(A, 'agent.harnessSave', { harness: pi })
      adapters.run.mockImplementation(async (_bin, args, opts) => {
        if (args.includes('--bg') && opts.cwd === roots[A]) {
          entered.resolve()
          await release.promise
          return 'backgrounded · abc12345 · Late A run'
        }
        if (args[0] === 'stop' && opts.cwd === roots[A]) {
          if (failureKind === 'throwing stop') throw new Error('native stop threw')
          throw new Error('native stop returned unsuccessful')
        }
        return '[]'
      })
      const launch = call(A, 'agent.launch', {
        provider: 'claude',
        name: 'A',
        prompt: 'start',
      }).catch((error: unknown) => error)
      await entered.promise
      expectFailedDrain()
      const stop = host.stop(A).catch((error: unknown) => error)
      const again = host.stop(A).catch((error: unknown) => error)
      release.resolve()
      await launch
      const failed = await stop
      expect(failed).toBeInstanceOf(Error)
      expect(await again).toBe(failed)
      await expect(host.stop(A)).rejects.toBe(failed)
      await expect(enter(A)).rejects.toBe(failed)
      expect(await call(B, 'agent.harnesses')).toMatchObject({ agents: expect.any(Array) })
    } finally {
      release.resolve()
    }
  },
)

it('aborts an admitted real HTTP session message only after its native inbox socket physically closes', async () => {
  const { host, enter, call, bridge } = await rig(undefined, undefined, true)
  const session = 'abc12345'
  const sessionUuid = '123e4567-e89b-42d3-a456-426614174000'
  const inboxServers: ReturnType<typeof createServer>[] = []
  const inboxPaths: string[] = []
  const receivedB: string[] = []
  const inbox = async (owner: 'A' | 'B') => {
    const socket = join(
      tmpdir(),
      `holi-agent-activation-${process.pid}-${owner}-${Date.now()}.sock`,
    )
    inboxPaths.push(socket)
    const server = createServer((connection) => {
      let content = ''
      connection.on('data', (chunk) => (content += chunk.toString()))
      connection.on('end', () => {
        if (owner === 'B') receivedB.push(content)
      })
    })
    inboxServers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socket, resolve)
    })
    return { socket, token: `inbox-secret-${owner}` }
  }
  const post = (remote: typeof A | typeof B, path: string, body: unknown) =>
    fetch(
      `http://127.0.0.1:${bridge.port()}${path}?t=${encodeURIComponent(bridge.tokenForVault(remote))}&job=${session}`,
      { method: 'POST', body: JSON.stringify(body) },
    )
  const heldPath = join(tmpdir(), `holi-agent-held-${process.pid}-${Date.now()}.sock`)
  const heldSocket = {
    listeners: new Map<string, ((...args: unknown[]) => void)[]>(),
    sent: [] as string[],
    destroyed: 0,
    on(event: string, listener: (...args: unknown[]) => void) {
      const listeners = this.listeners.get(event) ?? []
      listeners.push(listener)
      this.listeners.set(event, listeners)
      return this
    },
    end(data: string) {
      this.sent.push(data)
    },
    destroy() {
      this.destroyed++
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of this.listeners.get(event) ?? []) listener(...args)
    },
  }
  let message: Promise<unknown> | undefined
  let stopping: Promise<void> | undefined
  try {
    adapters.run.mockImplementation(async (_bin, args, opts) =>
      args[0] === 'agents'
        ? JSON.stringify([
            {
              kind: 'background',
              id: session,
              name: 'Same id',
              sessionId: sessionUuid,
              cwd: opts.cwd,
              pid: process.pid,
              status: 'idle',
            },
          ])
        : '',
    )
    await enter(A)
    await enter(B)
    for (const remote of [A, B] as const) await call(remote, 'agent.sessions')
    const channelA = { socket: heldPath, token: 'inbox-secret-A' }
    const channelB = await inbox('B')
    expect((await post(A, '/session', channelA)).status).toBe(204)
    expect((await post(B, '/session', channelB)).status).toBe(204)

    adapters.heldSocket = { path: heldPath, socket: heldSocket }
    message = call(A, 'agent.message', { session, text: 'held A message' })
    await vi.waitFor(() => expect(heldSocket.listeners.has('connect')).toBe(true))
    heldSocket.emit('connect')
    expect(heldSocket.sent.join('')).toContain('held A message')
    expect(heldSocket.sent.join('')).toContain(channelA.token)

    let messageSettled = false
    void message.then(
      () => {
        messageSettled = true
      },
      () => {
        messageSettled = true
      },
    )
    stopping = host.stop(A)
    let stopSettled = false
    void stopping.then(() => {
      stopSettled = true
    })
    await vi.waitFor(() => expect(heldSocket.destroyed).toBe(1))
    expect(messageSettled).toBe(false)
    expect(stopSettled).toBe(false)

    await expect(call(B, 'agent.message', { session, text: 'B stays live' })).resolves.toEqual({
      ok: true,
    })
    await vi.waitFor(() => expect(receivedB.join('')).toContain('B stays live'))
    expect(receivedB.join('')).toContain(channelB.token)
    expect(receivedB.join('')).not.toContain(channelA.token)

    heldSocket.emit('close')
    const cancelled = await message.catch((error: unknown) => error)
    expect(cancelled).toBeInstanceOf(Error)
    expect(String(cancelled)).not.toContain(channelA.token)
    await stopping
    expect(await call(B, 'agent.harnesses')).toMatchObject({ agents: expect.any(Array) })
    await expect(post(A, '/session', channelA)).resolves.toMatchObject({ status: 404 })
    await enter(A)
    expect(await call(B, 'agent.harnesses')).toMatchObject({ agents: expect.any(Array) })
  } finally {
    heldSocket.emit('close')
    await message?.catch(() => {})
    await stopping?.catch(() => {})
    adapters.heldSocket = null
    await Promise.all(
      inboxServers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    )
    await Promise.all(inboxPaths.map((path) => rm(path, { force: true })))
  }
})

it('keeps admitted HTTP turn finalization bound to its revoked activation', async () => {
  const headEntered = deferred()
  const releaseHead = deferred()
  const disposerEntered = deferred()
  const turnEnded = deferred()
  const agentDisposerStarted = vi.fn()
  const releaseDisposer = deferred()
  const contexts = new Map<string, PluginCtx>()
  const { host, enter, call, roots, bridge, sent, capabilities } = await rig(
    undefined,
    undefined,
    true,
    {
      context: (ctx) => {
        if (!contexts.has(ctx.remote)) contexts.set(ctx.remote, ctx)
      },
      holdAutomationsDisposer: {
        entered: disposerEntered.resolve,
        wait: releaseDisposer.promise,
        turnEnded: turnEnded.resolve,
      },
      agentDisposerStarted,
    },
  )
  const session = 'abc12345'
  const post = (remote: string, path: string) =>
    fetch(
      `http://127.0.0.1:${bridge.port()}${path}?t=${encodeURIComponent(bridge.tokenForVault(remote))}&job=${session}&pid=${process.pid}`,
      { method: 'POST' },
    )
  let stopping: Promise<void> | undefined
  let ending: Promise<Response> | undefined
  try {
    await writeFile(
      join(roots[A], '.holi/settings/plugins.yaml'),
      'plugins:\n  automations: true\n',
    )
    await enter(A)
    await enter(B)
    host.setDisplayed(A)
    for (const remote of [A, B] as const) await call(remote, 'agent.sessions')
    const base = execFileSync('git', ['-C', roots[A], 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    const ctxAtAdmission = contexts.get(A)!
    const presentation = ctxAtAdmission.presentationLease()
    expect(presentation()).toBe(true)
    const finalize = ctxAtAdmission.captureFinalization()
    adapters.headGate = { root: roots[A], entered: headEntered.resolve, wait: releaseHead.promise }
    expect((await post(A, '/turn/start')).status).toBe(204)
    await headEntered.promise
    expect((await post(B, '/turn/start')).status).toBe(204)
    ending = post(A, '/turn/end')
    // Ending the turn synchronously removes it from the coordinator before its
    // response waits for the captured base read and settle finalization.
    await turnEnded.promise
    // The turn-end signal proves the actual HTTP route admitted and ended this
    // turn before activation revoke; the dependent now holds its disposer.
    stopping = host.stop(A)
    await disposerEntered.promise
    expect(contexts.get(A)!.activationSignal.aborted).toBe(true)
    expect(agentDisposerStarted).not.toHaveBeenCalled()
    await expect(
      capabilities.dispatch({ door: 'ui', remote: A, name: 'agent.sessions', params: {} }),
    ).rejects.toThrow('no such method')
    await expect(call(B, 'agent.harnesses')).resolves.toMatchObject({ agents: expect.any(Array) })
    expect((await post(A, '/turn/start')).status).toBe(204)
    releaseHead.resolve()
    await vi.waitFor(async () => {
      expect(await openTurnLog(roots[A]).list()).toEqual([
        expect.objectContaining({ base, sessionId: session }),
      ])
    })
    expect(await readFile(join(roots[A], TURNS_FILE), 'utf8')).toContain(base)
    expect(await openTurnLog(roots[B]).list()).toEqual([])

    const before = sent.length
    const ctx = contexts.get(A)!
    await finalize(async () => {
      ctx.emit(A, 'sessions', [{ id: 'unauthorized' }])
      expect(presentation()).toBe(false)
      await expect(ctx.call('agent.sessions', {})).rejects.toThrow('no longer active')
    })
    expect(sent).toHaveLength(before)
    expect((await ending).status).toBe(204)
    expect((await post(B, '/turn/end')).status).toBe(200)
    expect(await openTurnLog(roots[B]).list()).toEqual([
      expect.objectContaining({ sessionId: session }),
    ])

    const stopAgain = host.stop(A)
    releaseDisposer.resolve()
    await Promise.all([stopping, stopAgain])
    expect(agentDisposerStarted).toHaveBeenCalledOnce()
    await enter(A)
    await expect(finalize(() => ctx.head())).rejects.toThrow('no longer active')
    await expect(finalize(() => ctx.commitNow())).rejects.toThrow('no longer active')
    await expect(finalize(() => ctx.call('agent.sessions', {}))).rejects.toThrow('no longer active')
  } finally {
    releaseHead.resolve()
    releaseDisposer.resolve()
    await ending?.catch(() => {})
    await stopping?.catch(() => {})
  }
})

it('drains actual turn-end record rename before stop without crossing same-id vault records', async () => {
  const { host, enter, call, roots, bridge } = await rig(undefined, undefined, true)
  const enteredRename = deferred()
  const releaseRename = deferred()
  const session = 'abc12345'
  const post = (remote: string, path: string) =>
    fetch(
      `http://127.0.0.1:${bridge.port()}${path}?t=${encodeURIComponent(bridge.tokenForVault(remote))}&job=${session}&pid=${process.pid}`,
      { method: 'POST' },
    )
  try {
    await enter(A)
    await enter(B)
    for (const remote of [A, B] as const) await call(remote, 'agent.sessions')
    expect((await post(A, '/turn/start')).status).toBe(204)
    expect((await post(B, '/turn/start')).status).toBe(204)
    const aRecord = join(roots[A], TURNS_FILE)
    adapters.historyRename = {
      source: aRecord,
      entered: enteredRename.resolve,
      wait: releaseRename.promise,
    }
    const endingA = post(A, '/turn/end')
    await enteredRename.promise
    const endingB = post(B, '/turn/end')
    let stopped = false
    const stopping = host.stop(A).then(() => {
      stopped = true
    })
    expect(stopped).toBe(false)
    releaseRename.resolve()
    const endedA = await endingA
    expect(endedA.status).toBe(204)
    expect(await endedA.text()).toBe('')
    expect((await endingB).status).toBe(200)
    await stopping
    expect(await openTurnLog(roots[A]).list()).toEqual([
      expect.objectContaining({ sessionId: session }),
    ])
    expect(await openTurnLog(roots[B]).list()).toEqual([
      expect.objectContaining({ sessionId: session }),
    ])
    await enter(A)
    expect(await openTurnLog(roots[A]).list()).toHaveLength(1)
    expect(await openTurnLog(roots[B]).list()).toHaveLength(1)
  } finally {
    releaseRename.resolve()
  }
})

it('drains a late provider listing before removing the stopped activation routes', async () => {
  const { host, enter, call, roots, bridge } = await rig()
  const entered = deferred()
  const release = deferred()
  const post = (remote: string, path: string) =>
    fetch(
      `http://127.0.0.1:${bridge.port()}${path}?t=${encodeURIComponent(bridge.tokenForVault(remote))}&job=abc12345&pid=${process.pid}`,
      { method: 'POST' },
    )
  try {
    await enter(B)
    adapters.run.mockImplementation(async (_bin, args, opts) => {
      if (args[0] === 'agents' && opts.cwd === roots[A]) {
        entered.resolve()
        await release.promise
        return JSON.stringify([
          {
            kind: 'background',
            id: 'abc12345',
            name: 'late',
            cwd: roots[A],
            pid: process.pid,
            status: 'idle',
          },
        ])
      }
      if (args[0] === 'agents' && opts.cwd === roots[B]) return '[]'
      return '[]'
    })
    const opening = enter(A)
    await entered.promise
    const stopping = host.stop(A)
    const joining = host.stop(A)
    expect((await post(B, '/statusline')).status).toBe(204)
    expect(adapters.routes.has(A)).toBe(false)
    release.resolve()
    await Promise.all([opening, stopping, joining])
    expect(adapters.routes.has(A)).toBe(false)
    expect((await post(A, '/session')).status).toBe(404)
    expect(await call(B, 'agent.harnesses')).toMatchObject({ agents: expect.any(Array) })
    await enter(A)
    expect(adapters.routes.has(A)).toBe(true)
    expect(await call(B, 'agent.harnesses')).toMatchObject({ agents: expect.any(Array) })
  } finally {
    release.resolve()
  }
})

it.each(['start', 'fork', 'respawn'] as const)(
  'cancels a held real %s capability, drains its late native receipt, and isolates the restarted activation',
  async (operation) => {
    const { host, enter, call, roots, userData, sent } = await rig()
    const entered = deferred()
    const release = deferred()
    const commandCalls: { args: string[]; cwd: string; config: string }[] = []
    const sessionId = 'abc12345'
    const forkId = 'def56789'
    const session = '123e4567-e89b-42d3-a456-426614174000'
    let holdUsed = false
    adapters.run.mockImplementation(async (_bin, args, opts) => {
      const config = opts.env.CLAUDE_CONFIG_DIR
      if (config === undefined) throw new Error('Claude command has no owning configuration.')
      commandCalls.push({ args, cwd: opts.cwd, config })
      if (args[0] === 'agents') {
        return JSON.stringify([
          {
            kind: 'background',
            id: sessionId,
            name: 'Existing session',
            sessionId: session,
            cwd: opts.cwd,
            pid: process.pid,
            status: 'idle',
          },
        ])
      }
      const isTarget =
        (operation === 'start' && args.includes('--bg') && !args.includes('--resume')) ||
        (operation === 'fork' && args.includes('--fork-session')) ||
        (operation === 'respawn' && args[0] === 'respawn')
      if (opts.cwd === roots[A] && isTarget && !holdUsed) {
        holdUsed = true
        entered.resolve()
        await release.promise
        if (operation === 'respawn') return ''
        return `backgrounded · ${operation === 'fork' ? forkId : sessionId} · Late A`
      }
      if (opts.cwd === roots[B] && isTarget) {
        if (operation === 'respawn') return ''
        return `backgrounded · ${sessionId} · B`
      }
      return ''
    })
    const invoke = (remote: typeof A | typeof B) => {
      if (operation === 'start') return call(remote, 'agent.start', { prompt: `${remote} start` })
      if (operation === 'fork') return call(remote, 'agent.duplicate', { id: sessionId })
      return call(remote, 'agent.respawn', { id: sessionId })
    }
    try {
      await enter(A)
      await enter(B)
      const held = invoke(A)
      await entered.promise
      const onA = commandCalls.filter((item) => item.cwd === roots[A]).at(-1)!
      expect(onA.config).toContain(join(userData, 'agent-config'))
      const priorSessionPublications = sent.filter(
        (event) => event.remote === A && event.name === 'sessions',
      ).length
      const resultB = await invoke(B)
      expect(resultB).toMatchObject({ ok: true })
      expect(adapters.pty.filter((args) => args.cwd === roots[A])).toHaveLength(0)

      let stopped = false
      const stopping = host.stop(A).then(() => {
        stopped = true
      })
      expect(stopped).toBe(false)
      await expect(call(A, 'agent.harnesses')).rejects.toThrow(/no such method/)
      expect(await call(B, 'agent.harnesses')).toMatchObject({ agents: expect.any(Array) })
      release.resolve()
      const late = await held
      expect(late).toMatchObject({ ok: false })
      await stopping
      expect(stopped).toBe(true)
      const cleanup = commandCalls.filter(
        (item) => item.cwd === roots[A] && item.args[0] === 'stop',
      )
      expect(cleanup).toContainEqual(
        expect.objectContaining({
          cwd: roots[A],
          config: onA.config,
          args: ['stop', operation === 'fork' ? forkId : sessionId],
        }),
      )
      expect(adapters.pty.filter((args) => args.cwd === roots[A])).toHaveLength(0)
      expect(sent.filter((event) => event.remote === A && event.name === 'sessions')).toHaveLength(
        priorSessionPublications,
      )
      expect(
        commandCalls
          .filter((item) => item.cwd === roots[B])
          .every((item) => item.config !== onA.config),
      ).toBe(true)

      await enter(A)
      expect(await call(A, 'agent.harnesses')).toMatchObject({ agents: expect.any(Array) })
      expect(await call(B, 'agent.harnesses')).toMatchObject({ agents: expect.any(Array) })
      expect(
        commandCalls
          .filter((item) => item.cwd === roots[B])
          .every((item) => item.config !== onA.config),
      ).toBe(true)
    } finally {
      release.resolve()
    }
  },
)

it('retains failed cleanup of a cancelled real respawn and refuses replacement', async () => {
  const { host, enter, call, roots, expectFailedDrain } = await rig()
  const entered = deferred()
  const release = deferred()
  let holdUsed = false
  adapters.run.mockImplementation(async (_bin, args, opts) => {
    if (args[0] === 'agents')
      return JSON.stringify([
        {
          kind: 'background',
          id: 'abc12345',
          name: 'Existing session',
          sessionId: '123e4567-e89b-42d3-a456-426614174000',
          cwd: opts.cwd,
          pid: process.pid,
          status: 'idle',
        },
      ])
    if (opts.cwd === roots[A] && args[0] === 'respawn' && !holdUsed) {
      holdUsed = true
      entered.resolve()
      await release.promise
      return ''
    }
    if (opts.cwd === roots[A] && args[0] === 'stop') throw new Error('respawn cleanup failed')
    return ''
  })
  try {
    await enter(A)
    await enter(B)
    const respawning = call(A, 'agent.respawn', { id: 'abc12345' })
    await entered.promise
    expect(await call(B, 'agent.respawn', { id: 'abc12345' })).toMatchObject({ ok: true })
    expectFailedDrain()
    const stopping = host.stop(A).catch((error: unknown) => error)
    release.resolve()
    expect(await respawning).toMatchObject({ ok: false })
    const failure = await stopping
    expect(failure).toBeInstanceOf(Error)
    expect(
      nestedErrors(failure).some((error) => String(error).includes('respawn cleanup failed')),
    ).toBe(true)
    await expect(host.stop(A)).rejects.toBe(failure)
    await expect(enter(A)).rejects.toBe(failure)
    expect(await call(B, 'agent.harnesses')).toMatchObject({ agents: expect.any(Array) })
  } finally {
    release.resolve()
  }
})

it('joins retention-expiry Pi close and reports failed turn finalization after row removal', async () => {
  const { host, enter, call, roots, userData, bridge, expectFailedDrain } = await rig()
  const executable = join(userData, 'pi-retention-fixture')
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const owner = process.cwd().endsWith('vault-a') ? 'A' : 'B';
const marker = (name) => path.join(process.cwd(), name);
fs.writeFileSync(marker('pi-fixture-pid'), String(process.pid));
process.on('SIGTERM', () => {
  if (owner === 'B') process.exit(0);
  fs.writeFileSync(marker('pi-fixture-sigterm'), 'received');
  const wait = setInterval(() => {
    if (fs.existsSync(marker('pi-fixture-release'))) {
      clearInterval(wait);
      process.exit(0);
    }
  }, 10);
});
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const command = JSON.parse(line);
  if (command.type === 'prompt') {
    const emit = (record) => process.stdout.write(JSON.stringify(record) + '\\n');
    emit({ type: 'agent_start' });
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: owner + '-reply' } });
    emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } });
    emit({ type: 'agent_settled' });
  } else if (command.type === 'get_session_stats') {
    process.stdout.write(JSON.stringify({ type: 'response', id: command.id, success: true, data: {} }) + '\\n');
  }
});
`,
  )
  await chmod(executable, 0o755)
  const pi = {
    ...PRESETS.find((preset) => preset.id === 'pi')!,
    command: { bin: executable, args: [] },
  }
  let stopping: Promise<unknown> | undefined
  let pidA: number | undefined
  let pidB: number | undefined
  let releaseRename: ReturnType<typeof deferred> | undefined
  const releasePath = join(roots[A], 'pi-fixture-release')
  const reply = async (remote: typeof A | typeof B, session: string) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = (await call(remote, 'agent.reply', { session })) as { output: string | null }
      if (result.output !== null) return result.output
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`Pi reply did not settle for ${remote}`)
  }
  const post = (remote: string, path: string, session: string) =>
    fetch(
      `http://127.0.0.1:${bridge.port()}${path}?t=${encodeURIComponent(bridge.tokenForVault(remote))}&job=${session}&pid=${process.pid}`,
      { method: 'POST' },
    )
  const realSetTimeout = globalThis.setTimeout
  let retentionTimer: ReturnType<typeof setTimeout> | undefined
  let expireRetention: (() => void) | undefined
  const retentionClock = vi
    .spyOn(globalThis, 'setTimeout')
    .mockImplementation((callback, delay, ...args) => {
      const timer = realSetTimeout(callback, delay, ...args)
      if (delay === 30_000 && typeof callback === 'function') {
        retentionTimer = timer
        expireRetention = () => callback(...args)
      }
      return timer
    })
  try {
    await enter(A)
    await enter(B)
    for (const remote of [A, B] as const) await call(remote, 'agent.harnessSave', { harness: pi })
    const launch = async (remote: typeof A | typeof B, keep: boolean) =>
      (await call(remote, 'agent.launch', {
        provider: 'pi',
        name: `${remote} retained fixture`,
        prompt: 'answer',
        tools: 'none',
        keep,
      })) as { ok: boolean; sessionId: string }
    const [piA, piB] = await Promise.all([launch(A, false), launch(B, true)])
    expect(piA.ok).toBe(true)
    expect(piB.ok).toBe(true)
    expect(await reply(A, piA.sessionId)).toBe('A-reply')
    expect(await reply(B, piB.sessionId)).toBe('B-reply')
    pidA = Number(await waitForFile(join(roots[A], 'pi-fixture-pid')))
    pidB = Number(await waitForFile(join(roots[B], 'pi-fixture-pid')))
    const waitForInitialTurn = async (remote: typeof A | typeof B, sessionId: string) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const records = await openTurnLog(roots[remote]).list()
        if (records.some((record) => record.sessionId === sessionId)) return records
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error(`Initial Pi turn was not durable for ${remote}`)
    }
    const [priorARecords, priorBRecords] = await Promise.all([
      waitForInitialTurn(A, piA.sessionId),
      waitForInitialTurn(B, piB.sessionId),
    ])
    expect(expireRetention).toBeDefined()
    expect(retentionTimer).toBeDefined()

    const durableFailure = new Error('A turn record rename failed')
    expectFailedDrain()
    const enteredRename = deferred()
    releaseRename = deferred()
    adapters.historyRename = {
      source: join(roots[A], TURNS_FILE),
      entered: enteredRename.resolve,
      wait: releaseRename.promise,
      error: durableFailure,
    }
    expect((await post(A, '/turn/start', piA.sessionId)).status).toBe(204)
    const endingA = post(A, '/turn/end', piA.sessionId)
    await enteredRename.promise

    expect((await post(B, '/turn/start', piB.sessionId)).status).toBe(204)
    const endingB = post(B, '/turn/end', piB.sessionId)
    expect((await endingB).status).toBe(200)
    const afterBRecords = await openTurnLog(roots[B]).list()
    expect(afterBRecords).toHaveLength(priorBRecords.length + 1)
    expect(afterBRecords).toContainEqual(expect.objectContaining({ sessionId: piB.sessionId }))
    expect(await openTurnLog(roots[A]).list()).toEqual(priorARecords)

    expireRetention!()
    let stopSettled = false
    stopping = host.stop(A).then(
      () => {
        stopSettled = true
        throw new Error('vault stop unexpectedly succeeded')
      },
      (error: unknown) => {
        stopSettled = true
        return error
      },
    )
    await waitForFile(join(roots[A], 'pi-fixture-sigterm'))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(await reply(B, piB.sessionId)).toBe('B-reply')
    expect(() => process.kill(pidB!, 0)).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(stopSettled).toBe(false)
    await expect(call(A, 'agent.reply', { session: piA.sessionId })).rejects.toThrow(
      /no such method/,
    )
    expect(await reply(B, piB.sessionId)).toBe('B-reply')

    await writeFile(releasePath, 'release')
    releaseRename.resolve()
    expect((await endingA).status).toBe(204)
    const failure = await stopping
    await waitForGone(pidA)
    expect(failure).toBeInstanceOf(Error)
    expect(nestedErrors(failure).some((error) => error === durableFailure)).toBe(true)
    await expect(host.stop(A)).rejects.toBe(failure)
    await expect(enter(A)).rejects.toBe(failure)
    await expect(call(A, 'agent.sessions')).rejects.toThrow(/no such method/)
    expect(await openTurnLog(roots[A]).list()).toEqual(priorARecords)
    expect(await openTurnLog(roots[B]).list()).toEqual(afterBRecords)
    expect(await reply(B, piB.sessionId)).toBe('B-reply')
  } finally {
    if (retentionTimer !== undefined) clearTimeout(retentionTimer)
    retentionClock.mockRestore()
    releaseRename?.resolve()
    await writeFile(releasePath, 'release').catch(() => {})
    await stopping?.catch(() => {})
    if (pidA !== undefined) await waitForGone(pidA).catch(() => {})
    await host.stopAll().catch(() => {})
    if (pidB !== undefined) await waitForGone(pidB).catch(() => {})
  }
})

it('joins an actual Pi child close on vault stop while the other vault stays live', async () => {
  const { host, enter, call, roots, userData } = await rig()
  const executable = join(userData, 'pi-stop-fixture')
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const owner = process.cwd().endsWith('vault-a') ? 'A' : 'B';
const marker = (name) => path.join(process.cwd(), name);
fs.writeFileSync(marker('pi-fixture-pid'), String(process.pid));
fs.writeFileSync(marker('pi-fixture-args'), JSON.stringify(process.argv.slice(2)));
process.on('SIGTERM', () => {
  if (owner === 'B') process.exit(0);
  fs.writeFileSync(marker('pi-fixture-sigterm'), 'received');
  const wait = setInterval(() => {
    if (fs.existsSync(marker('pi-fixture-release'))) {
      clearInterval(wait);
      process.exit(0);
    }
  }, 10);
});
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const command = JSON.parse(line);
  if (command.type === 'prompt') {
    const emit = (record) => process.stdout.write(JSON.stringify(record) + '\\n');
    emit({ type: 'agent_start' });
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: owner + '-reply' } });
    emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } });
    emit({ type: 'agent_settled' });
  } else if (command.type === 'get_session_stats') {
    process.stdout.write(JSON.stringify({ type: 'response', id: command.id, success: true, data: {} }) + '\\n');
  }
});
`,
  )
  await chmod(executable, 0o755)
  const pi = {
    ...PRESETS.find((preset) => preset.id === 'pi')!,
    command: { bin: executable, args: [] },
  }
  let stopping: Promise<void> | undefined
  let pidA: number | undefined
  let pidB: number | undefined
  try {
    await enter(A)
    await enter(B)
    for (const remote of [A, B] as const) await call(remote, 'agent.harnessSave', { harness: pi })
    const launch = async (remote: typeof A | typeof B) =>
      (await call(remote, 'agent.launch', {
        provider: 'pi',
        name: `${remote} physical child`,
        prompt: 'answer',
        tools: 'none',
        keep: true,
      })) as { ok: boolean; sessionId: string }
    const [piA, piB] = await Promise.all([launch(A), launch(B)])
    expect(piA.ok).toBe(true)
    expect(piB.ok).toBe(true)
    const reply = async (remote: typeof A | typeof B, session: string) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const result = (await call(remote, 'agent.reply', { session })) as { output: string | null }
        if (result.output !== null) return result.output
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error(`Pi reply did not settle for ${remote}`)
    }
    expect(await reply(A, piA.sessionId)).toBe('A-reply')
    expect(await reply(B, piB.sessionId)).toBe('B-reply')
    pidA = Number(await waitForFile(join(roots[A], 'pi-fixture-pid')))
    pidB = Number(await waitForFile(join(roots[B], 'pi-fixture-pid')))
    expect(JSON.parse(await readFile(join(roots[A], 'pi-fixture-args'), 'utf8'))).not.toContain(
      '--dangerously-skip-permissions',
    )

    stopping = host.stop(A)
    await waitForFile(join(roots[A], 'pi-fixture-sigterm'))
    let stopSettled = false
    void stopping.then(() => {
      stopSettled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(stopSettled).toBe(false)
    await expect(call(A, 'agent.reply', { session: piA.sessionId })).rejects.toThrow(
      /no such method/,
    )
    expect(await reply(B, piB.sessionId)).toBe('B-reply')
    await expect(
      call(B, 'agent.message', { session: piB.sessionId, text: 'still live' }),
    ).resolves.toEqual({
      ok: true,
    })

    await writeFile(join(roots[A], 'pi-fixture-release'), 'release')
    await stopping
    await waitForGone(pidA)
    await enter(A)
    const sessionsA = (await call(A, 'agent.sessions')) as { id: string; provider: string }[]
    expect(sessionsA).not.toContainEqual(
      expect.objectContaining({ id: piA.sessionId, provider: 'pi' }),
    )
    await expect(call(A, 'agent.reply', { session: piA.sessionId })).rejects.toThrow(/Pi run/)
    expect(await reply(B, piB.sessionId)).toBe('B-reply')
    expect(() => process.kill(pidB!, 0)).not.toThrow()
  } finally {
    await writeFile(join(roots[A], 'pi-fixture-release'), 'release').catch(() => {})
    await stopping?.catch(() => {})
    if (pidA !== undefined) await waitForGone(pidA).catch(() => {})
    await host.stopAll()
    if (pidB !== undefined) await waitForGone(pidB)
  }
})
