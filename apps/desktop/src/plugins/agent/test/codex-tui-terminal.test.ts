import { describe, expect, it } from 'vitest'
import { createCodexTuiTerminals } from './fixtures/codex-tui-terminal'

function fakeHandle() {
  let output = Buffer.alloc(0)
  let finish!: (value: { code: number; signal: null }) => void
  let closed = false
  const exit = new Promise<{ code: number; signal: null }>((resolve) => (finish = resolve))
  const writes: string[] = []
  const handle = {
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
      if (!closed) {
        closed = true
        finish({ code: 0, signal: null })
      }
      return { drained: true }
    },
    emit(bytes: Uint8Array) {
      output = Buffer.concat([output, Buffer.from(bytes)])
    },
  }
  return { handle, writes }
}

describe('Codex TUI terminal adapter', () => {
  it('streams new output as decoded chunks and forwards user input', async () => {
    const fake = fakeHandle()
    const inputs: string[] = []
    const terminals = createCodexTuiTerminals({ launch: async () => fake.handle })
    const received: string[] = []
    const openedResult = terminals.open({
      remote: 'a/b',
      cwd: '/vault',
      command: null,
      notInstalled: '',
      onOutput: (text) => received.push(text),
      onInput: (text) => inputs.push(text),
    })
    if (!openedResult.ok) throw new Error(openedResult.message)
    await Promise.resolve()
    fake.handle.emit(Buffer.from('\x1b[6'))
    fake.handle.emit(Buffer.from('n'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fake.writes).toContain('\x1b[1;1R')
    expect(inputs).toEqual([])
    fake.handle.emit(Buffer.from([0xe2]))
    await new Promise((resolve) => setTimeout(resolve, 20))
    fake.handle.emit(Buffer.from([0x82, 0xac]))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(received.join('')).toBe('€')
    terminals.write(openedResult.id, 'y')
    expect(inputs).toEqual(['y'])
    expect(fake.writes).toContain('y')
    await terminals.close(openedResult.id)
    expect(terminals.snapshot(openedResult.id).output).toBe('€')
    expect(terminals.snapshot(openedResult.id).inputs).toEqual(['y'])
  })

  it('joins close during launch and retains ownership when drainage is unconfirmed', async () => {
    const fake = fakeHandle()
    let resolve!: (handle: typeof fake.handle) => void
    const terminals = createCodexTuiTerminals({
      launch: () =>
        new Promise((done) => {
          resolve = done
        }),
    })
    const opened = terminals.open({ remote: 'a/b', cwd: '/vault', command: null, notInstalled: '' })
    if (!opened.ok) throw new Error(opened.message)
    const closing = terminals.close(opened.id)
    resolve(fake.handle)
    await closing
    expect(terminals.list()).toEqual([])
    expect(fake.handle).toBeDefined()
  })
})
