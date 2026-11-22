import { describe, expect, it } from 'vitest'
import { isApplicationSender } from '../src/main/application-sender'

function sender(url: string, parent: object | null = null) {
  const frame = { url, parent }
  const contents = { isDestroyed: () => false, mainFrame: frame }
  return { event: { sender: contents, senderFrame: frame }, contents, frame }
}

describe('application IPC sender authorization', () => {
  const entry = 'http://127.0.0.1:4317/'

  it('requires current webContents and its attached top-level entry document', () => {
    const valid = sender(`${entry}?reload=1#tab`)
    expect(isApplicationSender(valid.event, valid.contents, entry)).toBe(true)
    expect(isApplicationSender(valid.event, null, entry)).toBe(false)
    expect(isApplicationSender(valid.event, { ...valid.contents }, entry)).toBe(false)
    expect(isApplicationSender({ ...valid.event, senderFrame: null }, valid.contents, entry)).toBe(
      false,
    )
    expect(
      isApplicationSender({ ...valid.event, senderFrame: {} as never }, valid.contents, entry),
    ).toBe(false)
  })

  it('pins the configured document including dev port and path, not origin', () => {
    for (const url of [
      'http://127.0.0.1:4318/',
      'http://127.0.0.1:4317/@fs/tmp/attacker.html',
      'http://127.0.0.1:4317/other',
      'https://127.0.0.1:4317/',
      'not a URL',
    ]) {
      const candidate = sender(url)
      expect(isApplicationSender(candidate.event, candidate.contents, entry)).toBe(false)
    }
  })

  it('refuses subframes, stale frames and destroyed windows', () => {
    const child = sender(entry, {})
    expect(isApplicationSender(child.event, child.contents, entry)).toBe(false)
    const current = sender(entry)
    expect(
      isApplicationSender({ ...current.event, senderFrame: {} as never }, current.contents, entry),
    ).toBe(false)
    expect(
      isApplicationSender(current.event, { ...current.contents, isDestroyed: () => true }, entry),
    ).toBe(false)
  })

  it('fails closed when destroyed frames throw or have detached', () => {
    const current = sender(entry)
    const throwingParent = Object.defineProperty({ url: entry }, 'parent', {
      get() {
        throw new Error('frame destroyed')
      },
    })
    expect(
      isApplicationSender(
        { ...current.event, senderFrame: throwingParent as never },
        {
          ...current.contents,
          get mainFrame() {
            return throwingParent as never
          },
        },
        entry,
      ),
    ).toBe(false)

    const detached = { url: entry, parent: null, detached: true }
    expect(
      isApplicationSender(
        { ...current.event, senderFrame: detached as never },
        { ...current.contents, mainFrame: detached as never },
        entry,
      ),
    ).toBe(false)
  })

  it('pins the packaged file path while preserving query and fragment', () => {
    const candidate = sender('file:///app/renderer/index.html?x=1#tab')
    expect(
      isApplicationSender(candidate.event, candidate.contents, 'file:///app/renderer/index.html'),
    ).toBe(true)
    const other = sender('file:///app/renderer/attacker.html')
    expect(
      isApplicationSender(other.event, other.contents, 'file:///app/renderer/index.html'),
    ).toBe(false)
  })
})
