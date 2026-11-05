import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { suppressTerminalColorQueries } from '../../../renderer/src/lib/terminal-theme'
import { TerminalAppearanceProtocol } from '../main/host/terminal-appearance'

const appearance = {
  foreground: '#d0d0d0',
  background: '#14283c00',
  red: '#c80000',
  brightWhite: '#ffffff',
}

describe('TerminalAppearanceProtocol', () => {
  it('answers a native color batch once, in order, without renderer input replies', async () => {
    const protocol = new TerminalAppearanceProtocol()
    protocol.update(appearance)
    const renderer = new Terminal({ allowProposedApi: true })
    const replies: string[] = []
    const setters: string[] = []
    // The lower-priority handler represents xterm's normal color handling.
    renderer.parser.registerOscHandler(11, (data) => {
      if (data === '?') replies.push('duplicate color reply')
      else setters.push(data)
      return true
    })
    renderer.onData((data) => replies.push(data))
    const stop = suppressTerminalColorQueries(renderer)
    const main: string[] = []
    for (const chunk of ['\x1b]11;', '?\x07\x1b]4;1;?;15;?\x07\x1b[', 'c']) {
      main.push(...protocol.feed(chunk))
      await new Promise<void>((resolve) => renderer.write(chunk, resolve))
    }
    expect(main).toEqual([
      '\x1b]11;rgb:14/28/3c\x07',
      '\x1b]4;1;rgb:c8/00/00\x07',
      '\x1b]4;15;rgb:ff/ff/ff\x07',
      '\x1b[?1;2c',
    ])
    expect(replies).toEqual([])
    await new Promise<void>((resolve) => renderer.write('\x1b]11;#123456\x07', resolve))
    expect(setters).toEqual(['#123456'])
    stop()
    await new Promise<void>((resolve) => renderer.write('\x1b]11;?\x07', resolve))
    expect(replies).toEqual(['duplicate color reply'])
    renderer.dispose()
  })

  it('ignores escape-looking payloads inside fragmented and oversized control strings', () => {
    const protocol = new TerminalAppearanceProtocol()
    protocol.update(appearance)
    protocol.feed('\x1bPignored\x1b[?2031h')
    expect(protocol.feed('\x1b\\')).toEqual([])
    expect(protocol.update({ ...appearance, background: '#ffffff' })).toBe(false)
    protocol.feed('\x1bP' + 'x'.repeat(9_000))
    expect(protocol.feed('\x1b[?2031h\x1b\\')).toEqual([])
    expect(protocol.update(appearance)).toBe(false)
  })

  it('replies to OSC 10, 11 and indexed palette queries with current appearance colors', () => {
    const protocol = new TerminalAppearanceProtocol()
    protocol.update(appearance)

    expect(protocol.feed('\x1b]10;?\x07\x1b]11;?\x1b\\\x1b]4;1;?\x07')).toEqual([
      '\x1b]10;rgb:d0/d0/d0\x07',
      '\x1b]11;rgb:14/28/3c\x1b\\',
      '\x1b]4;1;rgb:c8/00/00\x07',
    ])
  })

  it('retains fragmented protocol input and only notifies an enabled subscriber on changes', () => {
    const protocol = new TerminalAppearanceProtocol()
    expect(protocol.update(appearance)).toBe(false)
    expect(protocol.feed('\x1b[?203')).toEqual([])
    expect(protocol.feed('1h')).toEqual([])
    expect(protocol.update({ ...appearance, background: '#ffffff00' })).toBe(true)
    expect(protocol.notification()).toBe('\x1b[?997;2n')
    expect(protocol.feed('\x1b[?2031l')).toEqual([])
    expect(protocol.update({ ...appearance, background: '#00000000' })).toBe(false)
    expect(protocol.notification()).toBe('\x1b[?997;1n')
  })

  it('rejects invalid payloads and safely answers extended xterm palette queries', () => {
    const protocol = new TerminalAppearanceProtocol()
    expect(protocol.update({ foreground: 'url(unsafe)', background: '#000000' })).toBe(false)
    protocol.update(appearance)
    expect(protocol.feed('\x1b]4;16;?\x07\x1b]4;999;?\x07')).toEqual(['\x1b]4;16;rgb:00/00/00\x07'])
  })
})
