import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeliveredLog } from '../src/main/reminders/delivered-log'
import { createReminderRuntime } from '../src/main/reminders/runtime'
import type { Delivered, VaultTasks } from '../src/main/reminders/sweep'
import type { RemindersEvent } from '../src/main/reminders/types'

afterEach(() => {
  vi.useRealTimers()
})

function makeDelivered(): DeliveredLog {
  const store = new Map<string, Delivered>()
  return {
    read: (remote) => store.get(remote) ?? {},
    markDelivered: (remote, path, fireAt) => {
      store.set(remote, { ...(store.get(remote) ?? {}), [path]: fireAt })
    },
  }
}

// due 2026-07-29, reminder '1d' → fire 2026-07-28T09:00; NOW is after it.
const NOW = '2026-07-28T10:00'
const firingVault = (): VaultTasks => ({
  remote: 'o/r',
  tasks: [
    {
      path: 'task.t.md',
      title: 'a task',
      status: 'todo',
      tags: [],
      description: '',
      due: '2026-07-29',
      reminder: '1d',
    },
  ],
})

// Flush the awaits inside a tick (corpus.all + follow-up) without leaning on timers.
const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('createReminderRuntime', () => {
  it('fires once on start and stamps the watermark', async () => {
    const events: RemindersEvent[] = []
    const delivered = makeDelivered()
    const rt = createReminderRuntime({
      now: () => NOW,
      corpus: { all: async () => [firingVault()] },
      notifier: { fire: (e) => events.push(e) },
      delivered,
      tickMs: 60_000,
    })
    rt.start()
    await flush()
    expect(events).toHaveLength(1)
    expect(events[0]!.fires[0]!.path).toBe('task.t.md')
    expect(delivered.read('o/r')).toEqual({ 'task.t.md': '2026-07-28T09:00' })
    rt.close()
  })

  it('does not re-fire on the next tick — the watermark holds', async () => {
    vi.useFakeTimers()
    const events: RemindersEvent[] = []
    const rt = createReminderRuntime({
      now: () => NOW,
      corpus: { all: async () => [firingVault()] },
      notifier: { fire: (e) => events.push(e) },
      delivered: makeDelivered(),
      tickMs: 60_000,
    })
    rt.start()
    await flush()
    expect(events).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(60_000) // interval fires a second tick
    expect(events).toHaveLength(1)
    rt.close()
  })

  it('does not fire if closed before an in-flight sweep resolves', async () => {
    let resolveAll!: (v: VaultTasks[]) => void
    const gate = new Promise<VaultTasks[]>((r) => {
      resolveAll = r
    })
    const events: RemindersEvent[] = []
    const rt = createReminderRuntime({
      now: () => NOW,
      corpus: { all: () => gate },
      notifier: { fire: (e) => events.push(e) },
      delivered: makeDelivered(),
      tickMs: 60_000,
    })
    rt.start() // tick begins, awaits the gate
    rt.close() // close before it resolves
    resolveAll([firingVault()])
    await flush()
    expect(events).toHaveLength(0)
  })
})
