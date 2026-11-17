// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isFrameHintsMessage, type FrameHintsMessage } from '../shared/frame-hints'

const script = readFileSync(resolve(__dirname, '../shared/hint-bridge.js'), 'utf8')
const nonce = 'host-random-nonce'
let post: { mock: { calls: unknown[][] }; mockRestore(): void; mockClear(): void }

function setup() {
  document.body.innerHTML =
    '<button>Save</button><a href="/next">Next</a><summary>Details</summary>'
  post = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
  window.eval(script)
}
function host(
  data: Record<string, unknown>,
  source: MessageEventSource | null = window,
  origin = 'https://host.example',
) {
  window.dispatchEvent(new MessageEvent('message', { data, source, origin }))
}
function init() {
  host({ type: 'holi-hints:init', nonce, enabled: true })
}
function activate(revision: number, id: string) {
  host({ type: 'holi-hints:session', nonce, revision, active: true })
  host({ type: 'holi-hints:activate', nonce, revision, id })
}
function sent<K extends FrameHintsMessage['type']>(
  type: K,
): Extract<FrameHintsMessage, { type: K }>[] {
  return post.mock.calls
    .map(([payload]) => payload as FrameHintsMessage)
    .filter((item): item is Extract<FrameHintsMessage, { type: K }> => item.type === type)
}
function rect(element: Element, x = 10) {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    x,
    y: 20,
    top: 20,
    right: x + 60,
    bottom: 44,
    left: x,
    width: 60,
    height: 24,
    toJSON: () => ({}),
  })
}
afterEach(() => {
  ;(
    window as Window & { __holiHintBridgeV1__?: { dispose(): void } }
  ).__holiHintBridgeV1__?.dispose()
  post?.mockRestore()
  document.body.innerHTML = ''
})

describe('community frame hint protocol', () => {
  it('validates bounded, unique snapshots and rejects malformed or unknown messages', () => {
    const target = {
      id: 'target-1',
      kind: 'button',
      label: 'Save',
      x: 0,
      y: 0,
      width: 20,
      height: 20,
    }
    expect(
      isFrameHintsMessage({ type: 'holi-hints:snapshot', nonce, revision: 1, targets: [target] }),
    ).toBe(true)
    expect(
      isFrameHintsMessage({
        type: 'holi-hints:snapshot',
        nonce,
        revision: 1,
        targets: [target, target],
      }),
    ).toBe(false)
    expect(
      isFrameHintsMessage({
        type: 'holi-hints:snapshot',
        nonce,
        revision: 1,
        targets: Array(101).fill(target),
      }),
    ).toBe(false)
    expect(isFrameHintsMessage({ type: 'holi-hints:key', nonce, key: 'x' })).toBe(true)
    expect(isFrameHintsMessage({ type: 'holi-hints:key', nonce, key: 'Enter' })).toBe(false)
    expect(
      isFrameHintsMessage({ type: 'holi-hints:init', nonce, enabled: true, script: 'evil()' }),
    ).toBe(false)
    expect(
      isFrameHintsMessage({ type: 'holi-hints:activate', nonce, revision: -1, id: 'target-1' }),
    ).toBe(false)
  })

  it('pins parent origin and nonce, snapshots supported targets, and ignores forged sessions', () => {
    setup()
    host({ type: 'holi-hints:init', nonce, enabled: true }, null)
    host({ type: 'holi-hints:init', nonce, enabled: true }, window, 'https://attacker.example')
    expect(sent('holi-hints:snapshot')).toHaveLength(0)
    init()
    const snapshot = sent('holi-hints:snapshot').at(-1)!
    expect(snapshot.targets.map(({ kind, label }) => [kind, label])).toEqual([
      ['button', 'Save'],
      ['link', 'Next'],
      ['summary', 'Details'],
    ])
    host({ type: 'holi-hints:session', nonce: 'stale', revision: snapshot.revision, active: true })
    host(
      { type: 'holi-hints:session', nonce, revision: snapshot.revision, active: true },
      window,
      'https://attacker.example',
    )
    const key = new KeyboardEvent('keydown', { key: 'x', cancelable: true })
    window.dispatchEvent(key)
    expect(key.defaultPrevented).toBe(false)
    host({ type: 'holi-hints:session', nonce, revision: snapshot.revision, active: true })
    const allowed = new KeyboardEvent('keydown', { key: 'x', cancelable: true })
    window.dispatchEvent(allowed)
    expect(allowed.defaultPrevented).toBe(true)
    expect(sent('holi-hints:key').at(-1)?.key).toBe('x')
  })

  it('requests hints only on enabled f and forwards no keys outside an acknowledged session', () => {
    setup()
    const ordinary = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })
    window.dispatchEvent(ordinary)
    expect(ordinary.defaultPrevented).toBe(false)
    init()
    const f = new KeyboardEvent('keydown', { key: 'f', cancelable: true })
    window.dispatchEvent(f)
    expect(f.defaultPrevented).toBe(true)
    expect(sent('holi-hints:start')).toHaveLength(1)
    for (const key of ['Enter', 'ArrowDown', 'A']) {
      const event = new KeyboardEvent('keydown', { key, cancelable: true })
      window.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
    }
    expect(sent('holi-hints:key')).toHaveLength(0)
  })

  it('invalidates on mutations and refuses stale, moved, removed, or disabled targets', async () => {
    setup()
    const button = document.querySelector('button')!
    rect(button)
    init()
    const snapshot = sent('holi-hints:snapshot').at(-1)!
    const id = snapshot.targets[0]!.id
    const click = vi.fn()
    button.addEventListener('click', click)
    activate(snapshot.revision - 1, id)
    expect(click).not.toHaveBeenCalled()
    activate(snapshot.revision, id)
    expect(click).toHaveBeenCalledTimes(1)

    init()
    const current = sent('holi-hints:snapshot').at(-1)!
    rect(button, 11)
    activate(current.revision, current.targets[0]!.id)
    expect(click).toHaveBeenCalledTimes(1)
    expect(sent('holi-hints:invalidated').length).toBeGreaterThan(0)

    init()
    const latest = sent('holi-hints:snapshot').at(-1)!
    button.remove()
    activate(latest.revision, latest.targets[0]!.id)
    expect(click).toHaveBeenCalledTimes(1)
    await Promise.resolve()
  })

  it('does not activate while disabled, editing, composing, hidden, or covered', () => {
    setup()
    const button = document.querySelector('button')!
    rect(button)
    const click = vi.fn()
    button.addEventListener('click', click)
    init()
    let snapshot = sent('holi-hints:snapshot').at(-1)!
    activate(snapshot.revision, snapshot.targets[0]!.id)
    expect(click).toHaveBeenCalledTimes(1)

    init()
    snapshot = sent('holi-hints:snapshot').at(-1)!
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    activate(snapshot.revision, snapshot.targets[0]!.id)
    expect(click).toHaveBeenCalledTimes(1)

    input.blur()
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
    const hiddenF = new KeyboardEvent('keydown', { key: 'f', cancelable: true })
    window.dispatchEvent(hiddenF)
    expect(hiddenF.defaultPrevented).toBe(false)
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    const start = new CompositionEvent('compositionstart', { bubbles: true })
    document.dispatchEvent(start)
    const before = sent('holi-hints:start').length
    const f = new KeyboardEvent('keydown', { key: 'f', cancelable: true })
    window.dispatchEvent(f)
    expect(f.defaultPrevented).toBe(false)
    expect(sent('holi-hints:start')).toHaveLength(before)
    document.body.append(
      Object.assign(document.createElement('div'), { innerHTML: '<div role="dialog"></div>' }),
    )
    const hidden = new KeyboardEvent('keydown', { key: 'f', cancelable: true })
    window.dispatchEvent(hidden)
    expect(hidden.defaultPrevented).toBe(false)

    host({ type: 'holi-hints:disable', nonce })
    const inactive = new KeyboardEvent('keydown', { key: 'f', cancelable: true })
    window.dispatchEvent(inactive)
    expect(inactive.defaultPrevented).toBe(false)
  })

  it('preserves link default action through click and loading twice leaves one listener', () => {
    setup()
    const link = document.querySelector('a')!
    rect(link)
    const click = vi.fn()
    link.addEventListener('click', click)
    init()
    const target = sent('holi-hints:snapshot')
      .at(-1)!
      .targets.find((item) => item.kind === 'link')!
    host({
      type: 'holi-hints:activate',
      nonce,
      revision: sent('holi-hints:snapshot').at(-1)!.revision,
      id: target.id,
    })
    expect(click).toHaveBeenCalledTimes(1)
    expect(click.mock.instances).toHaveLength(1)

    post.mockClear()
    window.eval(script)
    init()
    const f = new KeyboardEvent('keydown', { key: 'f', cancelable: true })
    window.dispatchEvent(f)
    expect(sent('holi-hints:start')).toHaveLength(1)
  })
})
