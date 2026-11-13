import { describe, expect, it, vi } from 'vitest'
import {
  pluginEvents,
  type PluginEvent,
  type PluginEventsDeps,
} from '../src/main/plugin-host/events'

describe('plugin events', () => {
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

  it('keeps another activation moving when one remote event gate is slow', async () => {
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
    const a = pluginEvents(deps, 'sample', async (remote) => {
      if (remote === 'A') await gateA
      return true
    })
    const b = pluginEvents(deps, 'sample', async () => true)
    a.emit('A', 'output', 'A')
    b.emit('B', 'output', 'B')
    await vi.waitFor(() => expect(sent).toEqual([{ remote: 'B', name: 'output', payload: 'B' }]))
    releaseA()
    await vi.waitFor(() => expect(sent).toHaveLength(2))
  })
})
