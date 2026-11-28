import { A, B, adapters, deferred, rig } from './activation-fixture'
import { expect, it, vi } from 'vitest'
import type { OpenResult, StartResult } from '../main/host/sessions'

it.each(['switch', 'return', 'stop'] as const)(
  'fences a real terminal open delayed by its sign-in marker across %s',
  async (transition) => {
    const { host, enter, call, setActive, roots } = await rig(undefined, undefined, true)
    await enter(A)
    await enter(B)
    setActive(A)
    const entered = deferred()
    const release = deferred()
    adapters.writeGateReleases.push(release.resolve)
    adapters.writeGates.push({
      fragment: '.holi-spawned',
      entered: entered.resolve,
      wait: release.promise,
    })
    const opening = call(A, 'agent.open')
    await entered.promise
    setActive(B)
    const onB = (await call(B, 'agent.open')) as OpenResult
    expect(onB.ok).toBe(true)
    if (transition === 'return') setActive(A)
    const stopping = transition === 'stop' ? host.stop(A) : undefined
    release.resolve()
    expect(await opening).toMatchObject({ ok: false })
    await stopping
    expect(adapters.pty.map((args) => args.cwd)).toEqual([roots[B]])
    expect(await call(B, 'agent.terminals')).toHaveLength(1)
    if (transition === 'stop') await enter(A)
    setActive(A)
    expect(await call(A, 'agent.open')).toMatchObject({ ok: true })
    expect(adapters.pty.at(-1)?.cwd).toBe(roots[A])
  },
)

it('cleans only the delayed foreground creator when two vaults receive the same native session id', async () => {
  const { enter, call, setActive, roots } = await rig(undefined, undefined, true)
  await enter(A)
  await enter(B)
  const entered = deferred()
  const release = deferred()
  adapters.cleanupReleases.push(release.resolve)
  let held = false
  let launches = 0
  adapters.run.mockImplementation(async (_bin, args, options) => {
    if (args.includes('--bg')) {
      if (options.cwd === roots[A] && !held) {
        held = true
        entered.resolve()
        await release.promise
      }
      launches++
      const id = launches <= 2 ? 'abc12345' : launches.toString(16).padStart(8, '0')
      return `backgrounded · ${id} · Bound run`
    }
    return '[]'
  })
  setActive(A)
  const opening = call(A, 'agent.start', { prompt: 'A foreground' })
  await entered.promise
  setActive(B)
  const b = (await call(B, 'agent.start', { prompt: 'B foreground' })) as StartResult
  expect(b).toMatchObject({ ok: true, sessionId: 'abc12345' })
  const before = await call(B, 'agent.terminals')
  setActive(A)
  release.resolve()
  expect(await opening).toMatchObject({ ok: false })
  expect(await call(B, 'agent.terminals')).toEqual(before)
  expect(adapters.pty.map((args) => args.cwd)).toEqual([roots[B]])
  const stops = adapters.run.mock.calls.filter(([, args]) => args[0] === 'stop')
  expect(stops.length).toBeGreaterThan(0)
  expect(stops.every(([, , options]) => options.cwd === roots[A])).toBe(true)
  expect(await call(A, 'agent.start', { prompt: 'Fresh A foreground' })).toMatchObject({ ok: true })
  setActive(B)
  expect(await call(A, 'agent.launch', { name: 'A bound', prompt: 'A background' })).toMatchObject({
    ok: true,
  })
  expect(adapters.run.mock.calls.filter(([, args]) => args.includes('--bg')).at(-1)?.[2].cwd).toBe(
    roots[A],
  )
})

it('fences queued keystrokes, geometry and output without losing replay or fresh displayed interaction', async () => {
  const { enter, call, setActive, sendAgent, sent } = await rig(undefined, undefined, true)
  await enter(A)
  await enter(B)
  setActive(A)
  const opened = (await call(A, 'agent.open')) as OpenResult
  if (!opened.ok) throw new Error(opened.message)
  const id = opened.terminalId
  expect(await call(A, 'agent.attach', { id })).toEqual(expect.any(String))
  const native = adapters.terminals.at(-1)!
  sendAgent(A, 'pty-write', { id, data: 'stale key' })
  sendAgent(A, 'pty-resize', { id, cols: 130, rows: 55 })
  native.emit('stale queued output')
  setActive(B)
  setActive(A)
  const replay = await call(A, 'agent.attach', { id })
  expect(replay).toContain('stale queued output')
  sendAgent(A, 'pty-write', { id, data: 'fresh key' })
  await vi.waitFor(() => expect(native.writes).toEqual(['fresh key']))
  expect(native.sizes).toEqual([])
  native.emit('fresh output')
  await vi.waitFor(() => expect(sent.filter((event) => event.name === 'pty-data')).toHaveLength(1))
})
