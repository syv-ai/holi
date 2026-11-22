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
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: vi.fn(
      (x: number, y: number) =>
        [...document.querySelectorAll('button,a,summary')].find((element) => {
          const bounds = element.getBoundingClientRect()
          return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom
        }) ?? null,
    ),
  })
  for (const [index, element] of [...document.querySelectorAll('button,a,summary')].entries())
    rect(element, 10 + index * 80)
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
  vi.unstubAllGlobals()
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
    const foreignFrame = document.createElement('iframe')
    document.body.append(foreignFrame)
    host({ type: 'holi-hints:init', nonce, enabled: true }, null)
    host(
      { type: 'holi-hints:init', nonce, enabled: true },
      foreignFrame.contentWindow,
      'https://host.example',
    )
    expect(sent('holi-hints:snapshot')).toHaveLength(0)
    // The first legitimate parent init establishes the origin; only subsequent
    // messages can be checked against that pinned origin.
    init()
    const snapshot = sent('holi-hints:snapshot').at(-1)!
    host({ type: 'holi-hints:init', nonce, enabled: true }, window, 'https://attacker.example')
    expect(sent('holi-hints:snapshot')).toHaveLength(1)
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

  it('refreshes geometry before starting and cancels a moved active target', () => {
    setup()
    const button = document.querySelector('button')!
    const click = vi.fn()
    button.addEventListener('click', click)
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    init()
    const stale = sent('holi-hints:snapshot').at(-1)!
    rect(button, 120)
    const f = new KeyboardEvent('keydown', { key: 'f', cancelable: true })
    window.dispatchEvent(f)
    const fresh = sent('holi-hints:snapshot').at(-1)!
    const start = sent('holi-hints:start').at(-1)!
    expect(fresh.revision).toBeGreaterThan(stale.revision)
    expect(fresh.targets[0]).toMatchObject({ x: 120 })
    expect(start.revision).toBe(fresh.revision)

    host({ type: 'holi-hints:session', nonce, revision: fresh.revision, active: true })
    rect(button, 180)
    frames.shift()?.(0)
    expect(sent('holi-hints:invalidated').at(-1)?.revision).toBeGreaterThan(fresh.revision)
    host({
      type: 'holi-hints:activate',
      nonce,
      revision: fresh.revision,
      id: fresh.targets[0]!.id,
    })
    expect(click).not.toHaveBeenCalled()
  })

  it('does not steal f from editors in open, closed, or nested shadow roots', () => {
    setup()
    init()
    const hostElement = document.createElement('x-editor')
    hostElement.tabIndex = -1
    document.body.append(hostElement)
    const root = hostElement.attachShadow({ mode: 'open' })
    const input = document.createElement('input')
    root.append(input)
    input.focus()
    const inputF = new KeyboardEvent('keydown', {
      key: 'f',
      bubbles: true,
      composed: true,
      cancelable: true,
    })
    input.dispatchEvent(inputF)
    expect(inputF.defaultPrevented).toBe(false)
    expect(sent('holi-hints:start')).toHaveLength(0)

    const editable = document.createElement('div')
    editable.tabIndex = -1
    editable.setAttribute('contenteditable', 'true')
    root.append(editable)
    editable.focus()
    const editF = new KeyboardEvent('keydown', {
      key: 'f',
      bubbles: true,
      composed: true,
      cancelable: true,
    })
    editable.dispatchEvent(editF)
    expect(editF.defaultPrevented).toBe(false)
    expect(sent('holi-hints:start')).toHaveLength(0)

    input.blur()
    editable.blur()
    const closedHost = document.createElement('div')
    document.body.append(closedHost)
    const closedRoot = closedHost.attachShadow({ mode: 'closed' })
    const closedInput = document.createElement('input')
    closedRoot.append(closedInput)
    closedInput.focus()
    const closedF = new KeyboardEvent('keydown', {
      key: 'f',
      bubbles: true,
      composed: true,
      cancelable: true,
    })
    closedInput.dispatchEvent(closedF)
    expect(closedF.defaultPrevented).toBe(false)
    expect(sent('holi-hints:start')).toHaveLength(0)

    const outerHost = document.createElement('div')
    const outerRoot = outerHost.attachShadow({ mode: 'open' })
    const innerHost = document.createElement('div')
    const innerRoot = innerHost.attachShadow({ mode: 'closed' })
    const nestedInput = document.createElement('input')
    innerRoot.append(nestedInput)
    outerRoot.append(innerHost)
    document.body.append(outerHost)
    nestedInput.focus()
    const nestedF = new KeyboardEvent('keydown', {
      key: 'f',
      bubbles: true,
      composed: true,
      cancelable: true,
    })
    nestedInput.dispatchEvent(nestedF)
    expect(nestedF.defaultPrevented).toBe(false)
    expect(sent('holi-hints:start')).toHaveLength(0)
  })

  it('starts hints from focused native buttons and links after repeated activations', () => {
    setup()
    init()
    const button = document.querySelector('button')!
    const link = document.querySelector('a')!
    const clicks = vi.fn(() => link.focus())
    link.addEventListener('click', clicks)

    button.focus()
    const buttonF = new KeyboardEvent('keydown', { key: 'f', cancelable: true })
    window.dispatchEvent(buttonF)
    expect(buttonF.defaultPrevented).toBe(true)
    expect(sent('holi-hints:start')).toHaveLength(1)

    let snapshot = sent('holi-hints:snapshot').at(-1)!
    activate(snapshot.revision, snapshot.targets.find((item) => item.kind === 'link')!.id)
    expect(clicks).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(link)

    const linkF = new KeyboardEvent('keydown', { key: 'f', cancelable: true })
    window.dispatchEvent(linkF)
    expect(linkF.defaultPrevented).toBe(true)
    expect(sent('holi-hints:start')).toHaveLength(2)

    snapshot = sent('holi-hints:snapshot').at(-1)!
    activate(snapshot.revision, snapshot.targets.find((item) => item.kind === 'link')!.id)
    expect(clicks).toHaveBeenCalledTimes(2)
  })

  it('rearms a fresh snapshot after each mutation-free activation', () => {
    setup()
    const button = document.querySelector('button')!
    const click = vi.fn()
    button.addEventListener('click', click)
    init()
    let snapshot = sent('holi-hints:snapshot').at(-1)!
    activate(snapshot.revision, snapshot.targets[0]!.id)
    expect(click).toHaveBeenCalledTimes(1)
    snapshot = sent('holi-hints:snapshot').at(-1)!
    expect(snapshot.revision).toBeGreaterThan(1)
    activate(snapshot.revision, snapshot.targets[0]!.id)
    expect(click).toHaveBeenCalledTimes(2)
  })

  it('cancels on background pointer input without suppressing the click', () => {
    setup()
    init()
    const snapshot = sent('holi-hints:snapshot').at(-1)!
    host({ type: 'holi-hints:session', nonce, revision: snapshot.revision, active: true })
    const pointer = new Event('pointerdown', { bubbles: true, cancelable: true })
    document.body.dispatchEvent(pointer)
    expect(pointer.defaultPrevented).toBe(false)
    expect(sent('holi-hints:clear').at(-1)).toMatchObject({ revision: snapshot.revision })
    const click = vi.fn()
    document.querySelector('button')!.addEventListener('click', click)
    host({
      type: 'holi-hints:activate',
      nonce,
      revision: snapshot.revision,
      id: snapshot.targets[0]!.id,
    })
    expect(click).not.toHaveBeenCalled()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', cancelable: true }))
    expect(sent('holi-hints:start').at(-1)?.revision).toBeGreaterThan(snapshot.revision)
  })

  it('clears on unsupported keys but lets modified shortcuts pass through', () => {
    setup()
    init()
    let snapshot = sent('holi-hints:snapshot').at(-1)!
    host({ type: 'holi-hints:session', nonce, revision: snapshot.revision, active: true })
    const unsupported = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })
    window.dispatchEvent(unsupported)
    expect(unsupported.defaultPrevented).toBe(true)
    expect(sent('holi-hints:clear').at(-1)).toMatchObject({ revision: snapshot.revision })
    snapshot = sent('holi-hints:snapshot').at(-1)!
    host({ type: 'holi-hints:session', nonce, revision: snapshot.revision, active: true })
    const modified = new KeyboardEvent('keydown', {
      key: 's',
      ctrlKey: true,
      cancelable: true,
    })
    window.dispatchEvent(modified)
    expect(modified.defaultPrevented).toBe(false)
    expect(sent('holi-hints:clear').at(-1)).toMatchObject({ revision: snapshot.revision })
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
    // The link is behind the button in this deterministic hit-test fixture;
    // give it its own non-overlapping rectangle so it is genuinely targetable.
    rect(link, 90)
    const click = vi.fn()
    link.addEventListener('click', click)
    init()
    const target = sent('holi-hints:snapshot')
      .at(-1)!
      .targets.find((item) => item.kind === 'link')!
    activate(sent('holi-hints:snapshot').at(-1)!.revision, target.id)
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
