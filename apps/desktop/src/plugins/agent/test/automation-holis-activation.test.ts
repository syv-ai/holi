import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { A, B, rig, adapters, deferred } from './activation-fixture'

import { describe, expect, it, vi } from 'vitest'

describe('automation and Holi activation contexts', () => {
  it('keeps real capability dispatch scoped to the selected vault and denies CLI approval', async () => {
    const { enter, call, capabilities, roots, setActive } = await rig(undefined, undefined, true)

    await enter(A)
    await enter(B)

    expect(roots[A]).not.toBe(roots[B])
    expect(await call(B, 'agent.inbox')).toMatchObject({ entries: [] })

    setActive(A)
    expect(await call(A, 'agent.inbox')).toMatchObject({ entries: [] })

    await expect(
      capabilities.dispatch({
        door: 'cli',
        remote: A,
        name: 'holis.approve',
        params: { holi: 'proposal', fingerprint: 'untrusted' },
      }),
    ).rejects.toThrow()
  })

  it('retains independently approved Holi contexts across activation lifecycle', async () => {
    const { enter, call, machineCall, roots, stopRemote } = await rig(undefined, undefined, true, {
      retainedContexts: true,
    })
    const create = (remote: typeof A | typeof B) =>
      call(remote, 'holis.create', { name: 'Scout', allow: ['Read(note.md)'] })
    const holis = new Map<typeof A | typeof B, { id: string; fingerprint: string }>()

    await enter(A)
    await enter(B)
    for (const remote of [A, B] as const) {
      const result = await create(remote)
      expect(result).toMatchObject({ status: 'new' })
      holis.set(remote, result as { id: string; fingerprint: string })
    }
    const a = holis.get(A)!
    const b = holis.get(B)!
    expect(a.id).toBe(b.id)
    expect(a.fingerprint).toBe(b.fingerprint)

    await expect(call(A, 'holis.send', { holi: a.id, path: 'note.md' })).rejects.toThrow()
    await call(A, 'holis.approve', { holi: a.id, fingerprint: a.fingerprint })
    await expect(call(B, 'holis.send', { holi: b.id, path: 'note.md' })).rejects.toThrow()
    await call(B, 'holis.approve', { holi: b.id, fingerprint: b.fingerprint })

    const adapters = await import('./activation-fixture').then(({ adapters }) => adapters)
    adapters.run.mockImplementation(async (_bin, args) =>
      args.includes('--bg') ? 'backgrounded · abc12345 · Scout' : '[]',
    )
    const [sentA, sentB] = await Promise.all([
      call(A, 'holis.send', { holi: a.id, path: 'note.md' }),
      call(B, 'holis.send', { holi: b.id, path: 'note.md' }),
    ])
    expect(sentA).toEqual({ sessionId: 'abc12345' })
    expect(sentB).toEqual({ sessionId: 'abc12345' })

    await writeVaultNote(roots[A], 'A')
    await writeVaultNote(roots[B], 'B')
    await Promise.all(
      (
        [
          [A, a, 'fact A'],
          [B, b, 'fact B'],
        ] as const
      ).map(async ([remote, definition, fact]) => {
        const report = await machineCall(remote, 'holis', 'report', definition.id, `report ${fact}`)
        expect(report.status).toBe(200)
        const remembered = await machineCall(remote, 'holis', 'remember', definition.id, fact)
        expect(remembered.status).toBe(200)
      }),
    )
    expect((await machineCall(A, 'holis', 'recall', a.id)).body).toContain('fact A')
    expect((await machineCall(B, 'holis', 'recall', b.id)).body).toContain('fact B')
    expect((await machineCall(A, 'holis', 'recall', a.id)).body).not.toContain('fact B')
    expect(await call(A, 'holis.list')).toMatchObject([
      {
        id: a.id,
        status: 'approved',
        runs: [{ jobId: 'abc12345', report: { text: 'report fact A' } }],
      },
    ])
    expect(await call(B, 'holis.list')).toMatchObject([{ id: b.id, status: 'approved' }])
    await stopRemote(A)
    expect(await call(B, 'agent.inbox')).toMatchObject({ entries: [] })
    expect((await machineCall(B, 'holis', 'report', b.id, 'B remains live')).status).toBe(200)
    expect(await call(B, 'holis.list')).toMatchObject([{ id: b.id, status: 'approved' }])
    await enter(A)
    expect(await call(A, 'holis.list')).toMatchObject([{ id: a.id, status: 'approved' }])
    const restoredMemory = (await machineCall(A, 'holis', 'recall', a.id)).body
    expect(restoredMemory).toContain('fact A')
    expect(restoredMemory).not.toContain('fact B')
    expect((await machineCall(B, 'holis', 'recall', b.id)).body).toContain('fact B')
  })
})

async function writeVaultNote(root: string, owner: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(`${root}/note.md`, `owned by ${owner}`)
}

describe('retained asynchronous launches', () => {
  it('revokes one schedule launch without stopping the other vault same-id run', async () => {
    const { enter, call, roots } = await rig(undefined, undefined, true, { retainedContexts: true })
    await enter(A)
    await enter(B)
    const saved = await Promise.all(
      ([A, B] as const).map(async (remote) => {
        const schedule = (await call(remote, 'schedules.save', {
          draft: { name: 'Inbox', crons: ['0 * * * *'], prompt: 'Read notes.', allow: ['Read'] },
        })) as { path: string; fingerprint: string }
        await call(remote, 'schedules.enable', {
          schedule: schedule.path,
          fingerprint: schedule.fingerprint,
        })
        return schedule
      }),
    )
    expect(saved[0]!.path).toBe(saved[1]!.path)
    const entered = deferred()
    const release = deferred()
    adapters.cleanupReleases.push(release.resolve)
    adapters.run.mockImplementation(async (_bin, args, options) => {
      if (args.includes('--bg')) {
        if (options.cwd === roots[A]) {
          entered.resolve()
          await release.promise
        }
        return 'backgrounded · abc12345 · Inbox'
      }
      return '[]'
    })
    const running = call(A, 'schedules.run', { schedule: saved[0]!.path })
    try {
      await entered.promise
      expect(await call(B, 'schedules.run', { schedule: saved[1]!.path })).toMatchObject({
        outcome: 'started',
        jobId: 'abc12345',
      })
      await call(A, 'schedules.disable', { schedule: saved[0]!.path })
    } finally {
      release.resolve()
    }
    expect(await running).toMatchObject({ outcome: 'skipped' })
    expect(await call(A, 'schedules.list')).toMatchObject([{ status: 'off', runs: [] }])
    expect(await call(B, 'schedules.list')).toMatchObject([
      { status: 'on', runs: [{ jobId: 'abc12345' }] },
    ])
    expect(
      adapters.run.mock.calls
        .filter(([, args]) => args[0] === 'stop')
        .map(([, , options]) => options.cwd),
    ).toEqual([roots[A]])
  })

  it('joins a stopped Holi launch while another same-id vault remains callable', async () => {
    const { enter, call, roots, stopRemote } = await rig(undefined, undefined, true, {
      retainedContexts: true,
    })
    await enter(A)
    await enter(B)
    await Promise.all(
      ([A, B] as const).map(async (remote) => {
        const holi = (await call(remote, 'holis.create', { name: 'Scout' })) as {
          id: string
          fingerprint: string
        }
        await call(remote, 'holis.approve', { holi: holi.id, fingerprint: holi.fingerprint })
      }),
    )
    const entered = deferred()
    const release = deferred()
    adapters.cleanupReleases.push(release.resolve)
    adapters.run.mockImplementation(async (_bin, args, options) => {
      if (args.includes('--bg')) {
        if (options.cwd === roots[A]) {
          entered.resolve()
          await release.promise
        }
        return 'backgrounded · abc12345 · Scout'
      }
      return '[]'
    })
    const launching = call(A, 'holis.send', { holi: 'scout', path: 'note.md' }).catch(
      (error: unknown) => error,
    )
    await entered.promise
    let stopped = false
    const stopping = stopRemote(A).then(() => {
      stopped = true
    })
    try {
      expect(await call(B, 'holis.send', { holi: 'scout', path: 'note.md' })).toMatchObject({
        sessionId: 'abc12345',
      })
      expect(stopped).toBe(false)
    } finally {
      release.resolve()
    }
    expect(await launching).toBeInstanceOf(Error)
    await stopping
    expect(await call(B, 'holis.list')).toMatchObject([
      { status: 'approved', runs: [{ jobId: 'abc12345' }] },
    ])
    expect(await call(B, 'agent.inbox')).toMatchObject({ entries: [] })
    await enter(A)
    expect(await call(A, 'holis.list')).toMatchObject([{ status: 'approved', runs: [] }])
  })
})

it('waits for disposer authority on a dependent-only disable and leaves populated sibling inboxes intact', async () => {
  const { enter, call, machineCall, roots, reconcileSettings } = await rig(
    undefined,
    undefined,
    true,
    { retainedContexts: true },
  )
  await enter(A)
  await enter(B)
  await call(A, 'holis.create', { name: 'Scout' })
  for (const remote of [A, B] as const) {
    const saved = (await call(remote, 'schedules.save', {
      draft: { name: 'Inbox', crons: ['0 * * * *'], prompt: 'Read notes.' },
    })) as { path: string; fingerprint: string }
    await call(remote, 'schedules.enable', { schedule: saved.path, fingerprint: saved.fingerprint })
    expect((await machineCall(remote, 'agent', 'notify', 'Shared notice', remote)).status).toBe(200)
  }
  const enteredWrite = deferred()
  const releaseWrite = deferred()
  const enteredLaunch = deferred()
  const releaseLaunch = deferred()
  adapters.cleanupReleases.push(releaseWrite.resolve, releaseLaunch.resolve)
  adapters.writeGates.push({
    fragment: join(roots[A], '.holi/holis/scout/.holi-tmp-'),
    entered: enteredWrite.resolve,
    wait: releaseWrite.promise,
  })
  const memory = machineCall(A, 'holis', 'remember', 'scout', 'drained A fact')
  await Promise.race([
    enteredWrite.promise,
    memory.then((result) => {
      throw new Error(`Memory completed before native gate: ${result.status}`)
    }),
  ])
  adapters.run.mockImplementation(async (_bin, args, options) => {
    if (args.includes('--bg')) {
      if (options.cwd === roots[A]) {
        enteredLaunch.resolve()
        await releaseLaunch.promise
      }
      return 'backgrounded · abc12345 · Inbox'
    }
    return '[]'
  })
  const launch = call(A, 'schedules.run', { schedule: 'inbox' }).catch((error: unknown) => error)
  await enteredLaunch.promise
  expect(await call(B, 'schedules.run', { schedule: 'inbox' })).toMatchObject({
    outcome: 'started',
  })
  await writeFile(
    join(roots[A], '.holi/settings/plugins.yaml'),
    'plugins:\n  automations: false\n  holis: false\n',
  )
  let disabled = false
  const disabling = reconcileSettings(A).then(() => {
    disabled = true
  })
  try {
    await vi.waitFor(async () => {
      await expect(call(A, 'holis.list')).rejects.toThrow()
    })
    releaseLaunch.resolve()
    await new Promise((resolve) => setImmediate(resolve))
    expect(disabled).toBe(false)
    expect(await call(B, 'schedules.list')).toMatchObject([
      { status: 'on', runs: [{ jobId: 'abc12345' }] },
    ])
  } finally {
    releaseLaunch.resolve()
    releaseWrite.resolve()
  }
  expect((await memory).status).toBe(200)
  await launch
  await disabling
  const inboxA = (await call(A, 'agent.inbox')) as { entries: { body: string }[] }
  const inboxB = (await call(B, 'agent.inbox')) as { entries: { body: string }[] }
  expect(JSON.stringify(inboxA)).toContain(A)
  expect(JSON.stringify(inboxA)).not.toContain(B)
  expect(JSON.stringify(inboxB)).toContain(B)
  expect(JSON.stringify(inboxB)).not.toContain(A)
  expect(await call(A, 'agent.sessions')).toEqual([])
  expect(
    adapters.run.mock.calls
      .filter(([, args]) => args[0] === 'stop')
      .map(([, , options]) => options.cwd),
  ).toEqual([roots[A]])
})

it.each(['approve', 'send'] as const)(
  'does not publish %s after its activation is revoked during native write preparation',
  async (operation) => {
    const { enter, call, roots, userData, reconcileSettings } = await rig(
      undefined,
      undefined,
      true,
      { retainedContexts: true },
    )
    await enter(A)
    const holi = (await call(A, 'holis.create', { name: 'Scout' })) as {
      id: string
      fingerprint: string
    }
    const entered = deferred()
    const release = deferred()
    adapters.cleanupReleases.push(release.resolve)
    if (operation === 'send')
      await call(A, 'holis.approve', { holi: holi.id, fingerprint: holi.fingerprint })
    adapters.writeGates.push({
      fragment: join(userData, 'holis.json.tmp'),
      entered: entered.resolve,
      wait: release.promise,
    })
    const approval = (
      operation === 'approve'
        ? call(A, 'holis.approve', { holi: holi.id, fingerprint: holi.fingerprint })
        : call(A, 'holis.send', { holi: holi.id, path: 'note.md' })
    ).catch((error: unknown) => error)
    await entered.promise
    await writeFile(
      join(roots[A], '.holi/settings/plugins.yaml'),
      'plugins:\n  automations: false\n  holis: false\n',
    )
    const disabling = reconcileSettings(A)
    try {
      await vi.waitFor(async () => {
        await expect(call(A, 'holis.list')).rejects.toThrow()
      })
    } finally {
      release.resolve()
    }
    expect(await approval).toBeInstanceOf(Error)
    await disabling
    await writeFile(
      join(roots[A], '.holi/settings/plugins.yaml'),
      'plugins:\n  automations: true\n  holis: true\n',
    )
    await reconcileSettings(A)
    expect(await call(A, 'holis.list')).toMatchObject([
      { status: operation === 'approve' ? 'new' : 'approved', runs: [] },
    ])
  },
)

it('uses the original host presentation lease and immutable notification navigation', async () => {
  const { enter, call, machineCall, setActive, notifications, navigations, userData } = await rig(
    undefined,
    undefined,
    true,
    { retainedContexts: true },
  )
  await enter(A)
  await enter(B)
  const holi = (await call(A, 'holis.create', { name: 'Scout' })) as {
    id: string
    fingerprint: string
  }
  await call(A, 'holis.approve', { holi: holi.id, fingerprint: holi.fingerprint })
  await call(A, 'holis.send', { holi: holi.id, path: 'note.md' })
  setActive(A)
  const entered = deferred()
  const release = deferred()
  adapters.cleanupReleases.push(release.resolve)
  adapters.writeGates.push({
    fragment: join(userData, 'holis.json.tmp'),
    entered: entered.resolve,
    wait: release.promise,
  })
  const before = notifications.length
  const report = machineCall(A, 'holis', 'report', holi.id, 'needs attention', '--needs-you')
  await entered.promise
  setActive(B)
  setActive(A)
  release.resolve()
  expect((await report).status).toBe(200)
  expect(notifications).toHaveLength(before)
  expect(
    (await machineCall(A, 'holis', 'report', holi.id, 'fresh attention', '--needs-you')).status,
  ).toBe(200)
  expect(notifications).toHaveLength(before + 1)
  setActive(B)
  ;(notifications.at(-1) as { onClick(): void }).onClick()
  expect(navigations).toEqual([
    { plugin: 'holis', remote: A, name: 'holi-open', payload: { holi: holi.id } },
  ])
})

it('recovers one vault after a failed launch without affecting its same-id sibling', async () => {
  const { enter, call, roots, stopRemote } = await rig(undefined, undefined, true, {
    retainedContexts: true,
  })
  await enter(A)
  await enter(B)
  const schedules = await Promise.all(
    ([A, B] as const).map(async (remote) => {
      const saved = (await call(remote, 'schedules.save', {
        draft: { name: 'Inbox', crons: ['0 * * * *'], prompt: 'Read notes.' },
      })) as { path: string; fingerprint: string }
      await call(remote, 'schedules.enable', {
        schedule: saved.path,
        fingerprint: saved.fingerprint,
      })
      return saved
    }),
  )
  expect(schedules[0]!.path).toBe(schedules[1]!.path)
  adapters.run.mockImplementation(async (_bin, args, options) => {
    if (options.cwd === roots[A] && args.includes('--bg'))
      throw new Error('synthetic launch failure')
    return args.includes('--bg') ? 'backgrounded · abc12345 · Inbox' : '[]'
  })
  await expect(call(A, 'schedules.run', { schedule: schedules[0]!.path })).rejects.toThrow(
    'synthetic launch failure',
  )
  expect(await call(B, 'schedules.run', { schedule: schedules[1]!.path })).toMatchObject({
    outcome: 'started',
    jobId: 'abc12345',
  })
  expect(await call(B, 'schedules.list')).toMatchObject([
    { status: 'on', runs: [{ jobId: 'abc12345' }] },
  ])

  adapters.run.mockImplementation(async (_bin, args) =>
    args.includes('--bg') ? 'backgrounded · def67890 · Inbox' : '[]',
  )
  await stopRemote(A)
  await enter(A)
  expect(await call(A, 'schedules.run', { schedule: schedules[0]!.path })).toMatchObject({
    outcome: 'started',
    jobId: 'def67890',
  })
  expect(await call(B, 'schedules.list')).toMatchObject([
    { status: 'on', runs: [{ jobId: 'abc12345' }] },
  ])
})

it('drains actual scheduler turn polling without finishing a sibling same-id run', async () => {
  const { enter, call, machineCall, stopRemote, roots, bridge, userData } = await rig(
    undefined,
    undefined,
    true,
    { retainedContexts: true },
  )
  await enter(A)
  await enter(B)
  const states = new Map<string, string>([
    [roots[A], 'busy'],
    [roots[B], 'busy'],
  ])
  adapters.run.mockImplementation(async (_bin, args, options) => {
    if (args.includes('--bg')) return 'backgrounded · abc12345 · Inbox'
    if (args[0] === 'agents')
      return JSON.stringify([
        {
          kind: 'background',
          id: 'abc12345',
          name: 'Inbox',
          cwd: options.cwd,
          pid: process.pid,
          status: states.get(options.cwd ?? ''),
        },
      ])
    return '[]'
  })
  for (const remote of [A, B] as const) {
    const saved = (await call(remote, 'schedules.save', {
      draft: { name: 'Inbox', crons: ['0 * * * *'], prompt: 'Read notes.' },
    })) as { path: string; fingerprint: string }
    await call(remote, 'schedules.enable', { schedule: saved.path, fingerprint: saved.fingerprint })
    await call(remote, 'schedules.run', { schedule: saved.path })
    await call(remote, 'agent.sessions')
  }
  const post = (remote: typeof A | typeof B, path: string) =>
    fetch(
      `http://127.0.0.1:${bridge.port()}${path}?t=${encodeURIComponent(bridge.tokenForVault(remote))}&job=abc12345&pid=${process.pid}`,
      { method: 'POST' },
    )
  expect((await post(A, '/turn/start')).status).toBe(204)
  expect((await post(A, '/turn/end')).ok).toBe(true)
  await stopRemote(A)
  expect(await call(B, 'schedules.list')).toMatchObject([{ runs: [{ jobId: 'abc12345' }] }])
  expect(await call(B, 'agent.sessions')).toMatchObject([{ id: 'abc12345' }])
  expect(
    (await machineCall(B, 'agent', 'notify', 'B remains active', 'after A poll teardown')).status,
  ).toBe(200)
  const state = JSON.parse(await readFile(join(userData, 'schedules.json'), 'utf8'))
  expect(state[B]['.holi/schedules/inbox.local.md'].runs[0].finishedAt).toBeUndefined()
  expect((await post(B, '/turn/start')).status).toBe(204)
  states.set(roots[B], 'idle')
  await call(B, 'agent.sessions')
  expect((await post(B, '/turn/end')).ok).toBe(true)
  await vi.waitFor(async () => {
    const schedules = (await call(B, 'schedules.list')) as { runs: { finishedAt?: string }[] }[]
    expect(schedules[0]!.runs[0]!.finishedAt).toEqual(expect.any(String))
  })
})

it('keeps the sibling scheduler timer running through stop, restart and disable', async () => {
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  })
  vi.setSystemTime(new Date('2026-01-15T10:00:00'))
  const { enter, call, roots, stopRemote, reconcileSettings } = await rig(
    undefined,
    undefined,
    true,
    {
      retainedContexts: true,
    },
  )
  const launches = new Map<string, number>()
  adapters.run.mockImplementation(async (_bin, args, options) => {
    if (!args.includes('--bg')) return '[]'
    const root = options.cwd ?? ''
    const count = (launches.get(root) ?? 0) + 1
    launches.set(root, count)
    return `backgrounded · ${count === 1 ? 'abc12345' : 'def12345'} · Timer`
  })
  await enter(A)
  await enter(B)
  const enable = async (remote: typeof A | typeof B, name: string, cron: string) => {
    const saved = (await call(remote, 'schedules.save', {
      draft: { name, crons: [cron], prompt: 'Inspect the owned note.' },
    })) as { path: string; fingerprint: string }
    await call(remote, 'schedules.enable', { schedule: saved.path, fingerprint: saved.fingerprint })
  }
  await Promise.all(([A, B] as const).map((remote) => enable(remote, 'Same timer', '1 10 15 1 *')))
  await stopRemote(A)
  vi.setSystemTime(new Date('2026-01-15T10:02:00'))
  await vi.advanceTimersByTimeAsync(6_000)
  await vi.waitFor(async () => {
    expect(await call(B, 'schedules.list')).toMatchObject([
      { runs: [{ trigger: 'schedule', outcome: 'started', jobId: 'abc12345' }] },
    ])
  })
  await enter(A)
  await vi.advanceTimersByTimeAsync(6_000)
  await vi.waitFor(async () => {
    expect(await call(A, 'schedules.list')).toMatchObject([
      { runs: [{ trigger: 'schedule', outcome: 'started', jobId: 'abc12345' }] },
    ])
  })
  await writeFile(
    join(roots[A], '.holi/settings/plugins.yaml'),
    'plugins:\n  automations: false\n  holis: true\n',
  )
  await reconcileSettings(A)
  await expect(call(A, 'schedules.list')).rejects.toThrow()
  await enable(B, 'Next timer', '3 10 15 1 *')
  vi.setSystemTime(new Date('2026-01-15T10:04:00'))
  await vi.advanceTimersByTimeAsync(30_000)
  await vi.waitFor(async () => {
    expect(await call(B, 'schedules.list')).toContainEqual(
      expect.objectContaining({
        name: 'Next timer',
        runs: [expect.objectContaining({ trigger: 'schedule', outcome: 'started' })],
      }),
    )
  })
})
