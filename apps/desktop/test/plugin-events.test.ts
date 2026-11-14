import { describe, expect, it, vi } from 'vitest'
import {
  pluginEvents,
  type PluginEvent,
  type PluginEventsDeps,
} from '../src/main/plugin-host/events'

describe('plugin events', () => {
  it('checks an outbound guard on the immediate delivery path', () => {
    const send = vi.fn()
    const bus = pluginEvents({ send, listen: () => () => {}, liveRemote: () => 'A' }, 'sample')
    bus.emit('A', 'output', 'stale', () => false)
    expect(send).not.toHaveBeenCalled()
  })
  it('drops renderer input when the displayed vault changes during its async gate', async () => {
    let displayed: string | null = 'A'
    let receive: ((message: unknown) => void) | undefined
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const handled = vi.fn()
    const deps: PluginEventsDeps = {
      send: () => {},
      listen: (_channel, handler) => {
        receive = handler
        return () => {}
      },
      liveRemote: () => displayed,
    }
    const bus = pluginEvents(deps, 'sample', async (remote) => {
      if (remote === 'A') await gate
      return true
    })
    bus.on('input', handled)
    receive!({ remote: 'A', name: 'input', payload: 'typed before switch' } satisfies PluginEvent)
    displayed = 'B'
    release()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(handled).not.toHaveBeenCalled()
  })

  it('drops inbound work queued before an activation closes during its async gate', async () => {
    let live = true
    let receive: ((message: unknown) => void) | undefined
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const handled = vi.fn()
    const bus = pluginEvents(
      {
        send: () => {},
        listen: (_channel, handler) => {
          receive = handler
          return () => {}
        },
        liveRemote: () => 'A',
      },
      'sample',
      async () => {
        await gate
        return true
      },
      () => (live ? 1 : -1),
    )
    bus.on('input', handled)
    receive!({ remote: 'A', name: 'input', payload: 'stale' })
    await new Promise<void>((resolve) => setImmediate(resolve))
    live = false
    release()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(handled).not.toHaveBeenCalled()
  })

  it('drops inbound display work across A to B to A during the async gate', async () => {
    let displayed: string | null = 'A'
    let presentationEpoch = 0
    let receive: ((message: unknown) => void) | undefined
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const handled = vi.fn()
    const bus = pluginEvents(
      {
        send: () => {},
        listen: (_channel, handler) => {
          receive = handler
          return () => {}
        },
        liveRemote: () => displayed,
      },
      'browser',
      async () => {
        await gate
        return true
      },
    )
    bus.on('place', handled, () => {
      const admittedDisplay = presentationEpoch
      return () => presentationEpoch === admittedDisplay
    })
    receive!({ remote: 'A', name: 'place', payload: { id: 'same' } })
    await new Promise<void>((resolve) => setImmediate(resolve))
    displayed = 'B'
    presentationEpoch += 1
    displayed = 'A'
    presentationEpoch += 1
    release()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(handled).not.toHaveBeenCalled()
  })

  it('drops a guarded browser shortcut queued before an A to B to A switch', async () => {
    let displayed: string | null = 'A'
    let presentationEpoch = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const sent: PluginEvent[] = []
    const bus = pluginEvents(
      {
        send: (_channel, event) => sent.push(event),
        listen: () => () => {},
        liveRemote: () => displayed,
      },
      'browser',
      async () => {
        await gate
        return true
      },
    )
    const admittedDisplay = presentationEpoch
    bus.emit('A', 'key', { id: 'new-tab' }, () => presentationEpoch === admittedDisplay)
    await new Promise<void>((resolve) => setImmediate(resolve))
    displayed = 'B'
    presentationEpoch += 1
    displayed = 'A'
    presentationEpoch += 1
    release()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(sent).toEqual([])
  })

  it('drops outbound delivery when its activation closes during the async gate', async () => {
    let live = true
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const sent: PluginEvent[] = []
    const bus = pluginEvents(
      {
        send: (_channel, event) => sent.push(event),
        listen: () => () => {},
        liveRemote: () => 'A',
      },
      'sample',
      async () => {
        await gate
        return true
      },
      () => (live ? 1 : -1),
    )
    bus.emit('A', 'output', 'stale')
    await new Promise<void>((resolve) => setImmediate(resolve))
    live = false
    release()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(sent).toEqual([])
  })

  it('keeps another remote moving when one event gate is slow', async () => {
    const sent: PluginEvent[] = []
    let releaseA: () => void = () => {}
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve
    })
    const deps: PluginEventsDeps = {
      send: (_channel, event) => sent.push(event),
      listen: () => () => {},
      liveRemote: () => 'A',
    }
    const bus = pluginEvents(deps, 'sample', async (remote) => {
      if (remote === 'A') await gateA
      return true
    })
    bus.emit('A', 'output', 'A')
    bus.emit('B', 'output', 'B')
    await vi.waitFor(() => expect(sent).toEqual([{ remote: 'B', name: 'output', payload: 'B' }]))
    releaseA()
    await vi.waitFor(() => expect(sent).toHaveLength(2))
  })
})
