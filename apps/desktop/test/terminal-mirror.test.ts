import { describe, expect, it } from 'vitest'
import { TerminalMirror } from '../src/main/agent/terminal-mirror'

describe('TerminalMirror', () => {
  it('serializes the output it was fed', async () => {
    const mirror = new TerminalMirror(80, 24)
    mirror.write('hello from claude\r\n')
    const state = await mirror.serialize()
    expect(state).toContain('hello from claude')
    mirror.dispose()
  })

  it('replays styling, not just text (the point of serializing over raw text)', async () => {
    const mirror = new TerminalMirror(80, 24)
    mirror.write('\x1b[31mred\x1b[0m plain\r\n')
    const state = await mirror.serialize()
    expect(state).toContain('red')
    expect(state).toMatch(/\x1b\[[0-9;]*m/) // SGR sequences survive
    mirror.dispose()
  })

  it('keeps scrollback beyond the viewport', async () => {
    const mirror = new TerminalMirror(80, 5)
    for (let i = 0; i < 40; i++) mirror.write(`line ${i}\r\n`)
    const state = await mirror.serialize()
    expect(state).toContain('line 0') // scrolled far off-screen
    expect(state).toContain('line 39')
    mirror.dispose()
  })

  it('resizes without losing content', async () => {
    const mirror = new TerminalMirror(80, 24)
    mirror.write('before resize\r\n')
    mirror.resize(120, 40)
    mirror.write('after resize\r\n')
    const state = await mirror.serialize()
    expect(state).toContain('before resize')
    expect(state).toContain('after resize')
    mirror.dispose()
  })

  it('serialize() flushes the async parse queue that serializeNow() can miss', async () => {
    const mirror = new TerminalMirror(80, 24)
    mirror.write('a'.repeat(5_000))
    // no await: serializeNow reads whatever the parser has managed so far
    expect(() => mirror.serializeNow()).not.toThrow()
    const flushed = await mirror.serialize()
    expect(flushed).toContain('aaaa')
    mirror.dispose()
  })

  it('is inert after dispose', async () => {
    const mirror = new TerminalMirror(80, 24)
    mirror.write('x\r\n')
    mirror.dispose()
    expect(() => mirror.write('y\r\n')).not.toThrow()
    expect(mirror.serializeNow()).toBe('')
  })
})
