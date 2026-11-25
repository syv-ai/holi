import { A, B, rig, adapters, deferred } from './activation-fixture'

import { describe, expect, it } from 'vitest'

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
    for (const [remote, definition, fact] of [
      [A, a, 'fact A'],
      [B, b, 'fact B'],
    ] as const) {
      const report = await machineCall(remote, 'holis', 'report', definition.id, `report ${fact}`)
      expect(report.status).toBe(200)
      const remembered = await machineCall(remote, 'holis', 'remember', definition.id, fact)
      expect(remembered.status).toBe(200)
    }
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
