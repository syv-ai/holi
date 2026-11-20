import { A, B, adapters, deferred, nestedErrors, rig } from './activation-fixture'

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { workLogPath } from '../main/inbox/work-log'

describe('activation-owned inbox writes', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  })

  it.each(['notify', 'log', 'dismiss', 'seen'] as const)(
    'joins admitted %s writes before teardown and replacement',
    async (operation) => {
      const { host, enter, call, capabilities, machineCall, roots, sent } = await rig(
        undefined,
        undefined,
        true,
      )
      await enter(A)
      if (operation === 'dismiss' || operation === 'seen') {
        expect((await machineCall(A, 'agent', 'notify', 'Seed', 'Existing')).status).toBe(200)
      }
      const view = (await call(A, 'agent.inbox')) as { entries: { id: string }[] }
      const first = deferred()
      const releaseFirst = deferred()
      adapters.writeGates.push({
        fragment:
          operation === 'log'
            ? `${roots[A]}/.holi/state/log/`
            : `${roots[A]}/.holi/state/inbox.local.json.tmp`,
        entered: first.resolve,
        wait: releaseFirst.promise,
      })
      const second = deferred()
      const releaseSecond = deferred()
      adapters.writeGateReleases.push(releaseFirst.resolve, releaseSecond.resolve)
      if (operation === 'notify') {
        adapters.writeGates.push({
          fragment: `${roots[A]}/.holi/state/log/`,
          entered: second.resolve,
          wait: releaseSecond.promise,
        })
      }
      const invocation =
        operation === 'notify'
          ? machineCall(A, 'agent', 'notify', 'Shared notice', 'Same content')
          : operation === 'log'
            ? machineCall(A, 'agent', 'log', 'Held log mutation')
            : capabilities.dispatch({
                door: 'ui',
                remote: A,
                name: operation === 'dismiss' ? 'agent.inboxDismiss' : 'agent.inboxSeen',
                params: operation === 'dismiss' ? { id: view.entries[0]!.id } : {},
              })
      await Promise.race([
        first.promise,
        invocation.then((result) => {
          throw new Error(
            `inbox ${operation} completed before native write admission: ${JSON.stringify(result)}`,
          )
        }),
      ])
      await enter(B)
      let invocationSettled = false
      void invocation.then(
        () => {
          invocationSettled = true
        },
        () => {
          invocationSettled = true
        },
      )
      const inboxEventsAtStop = sent.filter(
        (event) => event.remote === A && event.name === 'inbox',
      ).length
      let stopSettled = false
      const stopping = host.stop(A).then(
        () => {
          stopSettled = true
        },
        (error) => {
          stopSettled = true
          throw error
        },
      )
      await new Promise((resolve) => setImmediate(resolve))
      expect(stopSettled).toBe(false)
      const bNotify = machineCall(B, 'agent', 'notify', 'Shared notice', 'Same content')
      await expect(bNotify).resolves.toMatchObject({ status: 200 })
      const replacement = enter(A)
      let replacementSettled = false
      void replacement.then(
        () => {
          replacementSettled = true
        },
        () => {
          replacementSettled = true
        },
      )
      await new Promise((resolve) => setImmediate(resolve))
      expect(replacementSettled).toBe(false)
      if (operation === 'notify') {
        releaseFirst.resolve()
        await second.promise
        expect(invocationSettled).toBe(false)
        expect(stopSettled).toBe(false)
        expect(replacementSettled).toBe(false)
        releaseSecond.resolve()
      } else {
        releaseFirst.resolve()
      }
      const nativeResult = await invocation
      if (operation === 'notify' || operation === 'log')
        expect(nativeResult).toMatchObject({ status: 200 })
      else expect(nativeResult).toMatchObject({ value: expect.anything() })
      const logPath = join(roots[A], workLogPath(new Date()))
      if (operation === 'notify') {
        const inboxFile = JSON.parse(
          await readFile(join(roots[A], '.holi/state/inbox.local.json'), 'utf8'),
        ) as { entries: { id: string; title: string; line: string }[]; seen: string | null }
        expect(inboxFile.entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ title: 'Shared notice', line: 'Same content' }),
          ]),
        )
        expect(await readFile(logPath, 'utf8')).toContain('Shared notice: Same content')
      } else if (operation === 'log') {
        expect(await readFile(logPath, 'utf8')).toContain('Held log mutation')
      } else if (operation === 'dismiss' || operation === 'seen') {
        const inboxFile = JSON.parse(
          await readFile(join(roots[A], '.holi/state/inbox.local.json'), 'utf8'),
        ) as { entries: { id: string }[]; seen: string | null }
        if (operation === 'dismiss')
          expect(inboxFile.entries.map((entry) => entry.id)).not.toContain(view.entries[0]!.id)
        else expect(inboxFile.seen).not.toBeNull()
      }
      await stopping
      await replacement
      expect(invocationSettled).toBe(true)
      expect(stopSettled).toBe(true)
      expect(replacementSettled).toBe(true)
      expect(sent.filter((event) => event.remote === A && event.name === 'inbox')).toHaveLength(
        inboxEventsAtStop,
      )
      expect(await call(B, 'agent.inbox')).toMatchObject({
        entries: [expect.objectContaining({ title: 'Shared notice', line: 'Same content' })],
      })
      expect(await call(A, 'agent.inbox')).toMatchObject({ entries: expect.any(Array) })
      if (operation === 'notify') {
        const durable = JSON.parse(
          await readFile(join(roots[A], '.holi/state/inbox.local.json'), 'utf8'),
        ) as { entries: { title: string }[] }
        expect(durable.entries.filter((entry) => entry.title === 'Shared notice')).toHaveLength(1)
      }
    },
  )

  it.each(['notify', 'log', 'dismiss', 'seen'] as const)(
    'retains delayed native %s failure on the original activation',
    async (operation) => {
      const { host, enter, call, capabilities, machineCall, roots, setActive, expectFailedDrain } =
        await rig(undefined, undefined, true)
      await enter(A)
      await enter(B)
      setActive(A)
      if (operation === 'dismiss' || operation === 'seen')
        expect((await machineCall(A, 'agent', 'notify', 'Seed', 'Existing')).status).toBe(200)
      const view = (await call(A, 'agent.inbox')) as { entries: { id: string }[] }
      const entered = deferred()
      const release = deferred()
      const nativeFailure = new Error(`delayed ${operation} write failed`)
      const isLog = operation === 'log'
      adapters.writeGates.push({
        fragment: isLog
          ? `${roots[A]}/.holi/state/log/`
          : `${roots[A]}/.holi/state/inbox.local.json.tmp`,
        entered: entered.resolve,
        wait: release.promise,
        error: nativeFailure,
      })
      adapters.writeGateReleases.push(release.resolve)
      const invocation =
        operation === 'notify'
          ? machineCall(A, 'agent', 'notify', 'Failure', 'Expected')
          : operation === 'log'
            ? machineCall(A, 'agent', 'log', 'Failure expected')
            : capabilities.dispatch({
                door: 'ui',
                remote: A,
                name: operation === 'dismiss' ? 'agent.inboxDismiss' : 'agent.inboxSeen',
                params: operation === 'dismiss' ? { id: view.entries[0]!.id } : {},
              })
      const observedInvocation = invocation.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      await entered.promise
      expectFailedDrain()
      const stopping = host.stop(A).then(
        () => ({ error: new Error('vault stop unexpectedly succeeded') }),
        (error: unknown) => ({ error }),
      )
      await new Promise((resolve) => setImmediate(resolve))
      setActive(B)
      await expect(
        machineCall(B, 'agent', 'notify', 'B remains live', 'yes'),
      ).resolves.toMatchObject({ status: 200 })
      let replacementSettled = false
      const replacement = enter(A).then(
        () => {
          replacementSettled = true
          return undefined
        },
        (error: unknown) => {
          replacementSettled = true
          return error
        },
      )
      await new Promise((resolve) => setImmediate(resolve))
      expect(replacementSettled).toBe(false)
      release.resolve()
      const [result, failureResult, replacementFailure] = await Promise.all([
        observedInvocation,
        stopping,
        replacement,
      ])
      if (operation === 'notify' || operation === 'log') {
        expect(result).toHaveProperty('value.status', 422)
        expect((result as { value: { body: string } }).value.body).toContain(nativeFailure.message)
      } else {
        expect(result).toHaveProperty('error')
        expect((result as { error: unknown }).error).toBeInstanceOf(Error)
      }
      const failure = failureResult.error
      expect(replacementFailure).toBe(failure)
      expect(failure).toBeInstanceOf(AggregateError)
      expect((failure as Error).message).toBe('plugins in fixture/a failed to stop')
      expect(nestedErrors(failure)).toContain(nativeFailure)
      const repeatedStop = host.stop(A).then(
        () => ({ error: new Error('repeated stop unexpectedly succeeded') }),
        (error: unknown) => ({ error }),
      )
      const repeatedEnter = enter(A).then(
        () => ({ error: new Error('replacement unexpectedly succeeded') }),
        (error: unknown) => ({ error }),
      )
      const [sameStop, sameEnter] = await Promise.all([repeatedStop, repeatedEnter])
      expect(sameStop.error).toBe(failure)
      expect(sameEnter.error).toBe(failure)
      expect(await call(B, 'agent.inbox')).toMatchObject({
        entries: [expect.objectContaining({ title: 'B remains live', line: 'yes' })],
      })
    },
  )

  it('does not poison teardown when notify persistence succeeds but its best-effort work log fails', async () => {
    const { host, enter, call, machineCall, roots } = await rig(undefined, undefined, true)
    await enter(A)
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const entered = deferred()
    const release = deferred()
    const logFailure = new Error('best-effort work log failed')
    adapters.writeGates.push({
      fragment: `${roots[A]}/.holi/state/log/`,
      entered: entered.resolve,
      wait: release.promise,
      error: logFailure,
    })
    adapters.writeGateReleases.push(release.resolve)
    const notification = machineCall(A, 'agent', 'notify', 'Durable', 'Inbox entry')
    await entered.promise
    let stopSettled = false
    const stopping = host.stop(A).then(() => {
      stopSettled = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(stopSettled).toBe(false)
    release.resolve()
    const [notifyResult] = await Promise.all([notification, stopping])
    expect(notifyResult).toMatchObject({ status: 200 })
    expect(logError.mock.calls).toContainEqual([
      expect.stringContaining(workLogPath(new Date())),
      logFailure,
    ])
    expect(stopSettled).toBe(true)
    const inbox = JSON.parse(
      await readFile(join(roots[A], '.holi/state/inbox.local.json'), 'utf8'),
    ) as { entries: { title: string; line: string }[] }
    expect(inbox.entries).toContainEqual(
      expect.objectContaining({ title: 'Durable', line: 'Inbox entry' }),
    )
    await enter(A)
    expect(await call(A, 'agent.inbox')).toMatchObject({
      entries: [expect.objectContaining({ title: 'Durable', line: 'Inbox entry' })],
    })
  })

  it('does not poison later teardown for invalid or not-open requests', async () => {
    const { host, enter, call, capabilities, machineCall, setActive } = await rig(
      undefined,
      undefined,
      true,
    )
    await enter(A)
    await expect(
      capabilities.dispatch({
        door: 'cli',
        remote: A,
        name: 'agent.notify',
        params: { title: '', line: 'invalid' },
      }),
    ).rejects.toThrow(/title/)
    setActive(B)
    await expect(
      capabilities.dispatch({ door: 'ui', remote: A, name: 'agent.inboxSeen', params: {} }),
    ).rejects.toThrow('vault-not-open')
    setActive(A)
    const accepted = await machineCall(A, 'agent', 'notify', 'Valid', 'Open now')
    expect(accepted.status).toBe(200)
    await host.stop(A)
    await enter(A)
    expect(await call(A, 'agent.inbox')).toMatchObject({
      entries: [expect.objectContaining({ title: 'Valid', line: 'Open now' })],
    })
  })
})
