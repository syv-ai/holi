import { afterEach, describe, expect, it } from 'vitest'
import { createCodexTuiTerminals } from './fixtures/codex-tui-terminal'

function fakeHandle(drained = true) {
  let output = Buffer.alloc(0)
  let finish!: () => void
  const exit = new Promise<void>((resolve) => {
    finish = resolve
  })
  const writes: string[] = []
  return {
    writes,
    handle: {
      get output() {
        return Buffer.from(output)
      },
      failure: undefined,
      nativeExit: undefined,
      async write(bytes: string) {
        writes.push(bytes)
      },
      waitForExit: () => exit,
      async close() {
        finish()
        return { drained }
      },
      emit(bytes: Uint8Array) {
        output = Buffer.concat([output, Buffer.from(bytes)])
      },
    },
  }
}
const adapters: ReturnType<typeof createCodexTuiTerminals>[] = []
afterEach(async () => {
  await Promise.allSettled(
    adapters.splice(0).flatMap((adapter) => adapter.list().map(({ id }) => adapter.close(id))),
  )
})
const args = { remote: 'a/b', cwd: '/vault', command: null, notInstalled: '' }

describe('Codex TUI terminal adapter', () => {
  it('keeps live output, answers split native queries and forwards only explicit human input', async () => {
    const fake = fakeHandle()
    const inputs: string[] = [],
      received: string[] = []
    const terminals = createCodexTuiTerminals({ launch: async () => fake.handle })
    adapters.push(terminals)
    const opened = terminals.open({
      ...args,
      onOutput: (text) => received.push(text),
      onInput: (text) => inputs.push(text),
    })
    if (!opened.ok) throw new Error(opened.message)
    fake.handle.emit(Buffer.from('\x1b[6'))
    await expect.poll(() => received.join('')).toBe('\x1b[6')
    fake.handle.emit(Buffer.from('n'))
    await expect.poll(() => fake.writes).toContain('\x1b[1;1R')
    expect(inputs).toEqual([])
    fake.handle.emit(Buffer.from([0xe2]))
    await new Promise((resolve) => setTimeout(resolve, 30))
    fake.handle.emit(Buffer.from([0x82, 0xac]))
    await expect.poll(() => received.join('')).toBe('\x1b[6n€')
    expect(terminals.list().map(({ id }) => id)).toContain(opened.id)
    await terminals.write(opened.id, '\x1b')
    expect(inputs).toEqual(['\x1b'])
    expect(fake.writes).toContain('\x1b')
    await terminals.close(opened.id)
    expect(terminals.snapshot(opened.id)).toMatchObject({
      output: '\x1b[6n€',
      inputs: ['\x1b'],
      receipt: { drained: true },
    })
    expect(terminals.list()).toEqual([])
  })

  it('joins close during launch and refuses queued and late human input', async () => {
    const fake = fakeHandle()
    let resolve!: (handle: typeof fake.handle) => void
    const inputs: string[] = []
    const terminals = createCodexTuiTerminals({
      launch: () =>
        new Promise((done) => {
          resolve = done
        }),
    })
    adapters.push(terminals)
    const opened = terminals.open({ ...args, onInput: (text) => inputs.push(text) })
    if (!opened.ok) throw new Error(opened.message)
    const queued = terminals.write(opened.id, '\x1b')
    const closing = terminals.close(opened.id)
    resolve(fake.handle)
    await closing
    await queued
    await terminals.write(opened.id, '\x1b')
    expect(inputs).toEqual([])
    expect(fake.writes).toEqual([])
    expect(terminals.list()).toEqual([])
  })

  it('retains failed-launch ownership and a rejecting cleanup operation', async () => {
    let cleanup: Promise<void> | undefined
    const terminals = createCodexTuiTerminals({
      launch: async () => {
        throw new Error('launch failed')
      },
    })
    adapters.push(terminals)
    const opened = terminals.open({
      ...args,
      onStartupCleanup: (work) => {
        cleanup = work
        void work.catch(() => {})
      },
    })
    if (!opened.ok) throw new Error(opened.message)
    await expect.poll(() => cleanup !== undefined).toBe(true)
    await expect(cleanup).rejects.toThrow()
    await expect(terminals.close(opened.id)).rejects.toThrow()
    expect(terminals.list().map(({ id }) => id)).toContain(opened.id)
  })

  it('does not retire ownership without confirmed physical drainage', async () => {
    const fake = fakeHandle(false)
    let retired = false
    const terminals = createCodexTuiTerminals({ launch: async () => fake.handle })
    adapters.push(terminals)
    const opened = terminals.open({
      ...args,
      onRetired: () => {
        retired = true
      },
    })
    if (!opened.ok) throw new Error(opened.message)
    await expect(terminals.close(opened.id)).rejects.toThrow()
    expect(retired).toBe(false)
    expect(terminals.list().map(({ id }) => id)).toContain(opened.id)
  })
})
