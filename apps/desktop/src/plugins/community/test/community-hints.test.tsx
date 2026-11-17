// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  registerHostHintAdapter,
  type HostHintAdapter,
  activateHostHint,
  discoverHostHintTargets,
  hostHintsUnchanged,
} from '@/plugin-api'
import { communityFramePaneFocused, createCommunityHintAdapter } from '../renderer/community-hints'
import { isFrameHintsMessage, type FrameHintsMessage } from '../shared/frame-hints'

const origin = 'http://127.0.0.1:4312'
let nonce = ''
let messages: FrameHintsMessage[]
let frame: HTMLIFrameElement
let request: Mock<(source: HTMLElement, adapter: HostHintAdapter) => void>
let adapter: ReturnType<typeof createCommunityHintAdapter>
let unregisterAdapter: (() => void) | undefined

function setup() {
  document.body.innerHTML = '<main data-pane data-pane-focused><iframe></iframe></main>'
  frame = document.querySelector('iframe')!
  frame.focus()
  Object.defineProperty(frame, 'src', { configurable: true, value: `${origin}/` })
  Object.defineProperty(frame, 'clientWidth', { configurable: true, value: 200 })
  Object.defineProperty(frame, 'clientHeight', { configurable: true, value: 150 })
  Object.defineProperty(frame, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: 100,
      y: 80,
      left: 100,
      top: 80,
      right: 500,
      bottom: 380,
      width: 400,
      height: 300,
    }),
  })
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: vi.fn(() => frame),
  })
  messages = []
  vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation((message) => {
    const sentMessage = message as FrameHintsMessage
    messages.push(sentMessage)
    if (sentMessage.type === 'holi-hints:init') nonce = sentMessage.nonce
  })
  request = vi.fn<(source: HTMLElement, adapter: HostHintAdapter) => void>()
  adapter = createCommunityHintAdapter(frame, request)
  adapter.capture?.()
}
function guest(
  data: unknown,
  source: MessageEventSource | null = frame.contentWindow,
  eventOrigin = origin,
) {
  window.dispatchEvent(new MessageEvent('message', { data, source, origin: eventOrigin }))
}
function snapshot(
  revision = 1,
  targets = [
    {
      id: 'save',
      kind: 'button',
      label: 'Save',
      x: 20,
      y: 10,
      width: 40,
      height: 20,
    },
  ],
) {
  guest({ type: 'holi-hints:snapshot', nonce, revision, targets })
}
function sent(): FrameHintsMessage[] {
  return messages
}

afterEach(() => {
  unregisterAdapter?.()
  unregisterAdapter = undefined
  adapter?.invalidate?.()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('community host hint adapter', () => {
  it('validates source, fixed origin, fresh nonce, schema, and monotonic snapshots', () => {
    setup()
    const foreignFrame = document.createElement('iframe')
    document.body.append(foreignFrame)
    guest(
      { type: 'holi-hints:snapshot', nonce, revision: 1, targets: [] },
      foreignFrame.contentWindow,
    )
    guest(
      { type: 'holi-hints:snapshot', nonce, revision: 1, targets: [] },
      frame.contentWindow,
      'https://attacker.example',
    )
    guest({ type: 'holi-hints:snapshot', nonce: 'old', revision: 1, targets: [] })
    guest({
      type: 'holi-hints:snapshot',
      nonce,
      revision: 1,
      targets: [
        { id: 'dup', kind: 'button', label: 'A', x: 0, y: 0, width: 5, height: 5 },
        { id: 'dup', kind: 'button', label: 'B', x: 0, y: 0, width: 5, height: 5 },
      ],
    })
    expect(adapter.discover()).toHaveLength(0)
    snapshot(2)
    snapshot(1, [])
    expect(adapter.discover()).toHaveLength(1)
    expect(sent()[0]).toEqual({
      type: 'holi-hints:init',
      nonce: expect.any(String),
      enabled: true,
    })
  })

  it('keeps the eager snapshot through capture and validates bounded, scaled, clipped, unobscured geometry', () => {
    setup()
    snapshot()
    adapter.capture?.()
    const targets = adapter.discover()
    expect(targets).toHaveLength(1)
    expect(targets[0]).toMatchObject({ element: frame, label: 'Save', x: 180, y: 120 })
    expect(adapter.unchanged([])).toBe(true)
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(document.body)
    expect(adapter.discover()).toHaveLength(0)
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(frame)
    snapshot(2, [
      { id: 'edge', kind: 'button', label: 'Edge', x: 390, y: 10, width: 40, height: 20 },
    ])
    expect(adapter.discover()).toHaveLength(0)
  })

  it('ignores parked retained panes and follows the focused pane after A-B-A', () => {
    setup()
    const first = frame.closest<HTMLElement>('[data-pane]')!
    const parked = document.createElement('main')
    parked.setAttribute('data-pane', '')
    parked.setAttribute('data-pane-focused', 'true')
    parked.hidden = true
    parked.innerHTML = '<iframe></iframe>'
    document.body.append(parked)
    expect(communityFramePaneFocused(frame)).toBe(true)
    parked.hidden = false
    first.removeAttribute('data-pane-focused')
    expect(communityFramePaneFocused(frame)).toBe(false)
    first.setAttribute('data-pane-focused', 'true')
    expect(communityFramePaneFocused(frame)).toBe(true)
    snapshot()
    expect(adapter.discover()).toHaveLength(1)
  })

  it('does not let an opted-out guest adapter veto host-only targets', () => {
    setup()
    const root = frame.closest<HTMLElement>('[data-pane]')!
    const guestAdapter: HostHintAdapter = {
      discover: () => [],
      unchanged: () => false,
      activate: () => false,
      guestOnly: true,
    }
    unregisterAdapter = registerHostHintAdapter(frame, guestAdapter)
    expect(hostHintsUnchanged([], guestAdapter, root)).toBe(true)
  })

  it('runs through core discovery, session routing, and activation for a verified snapshot', () => {
    setup()
    const root = frame.closest<HTMLElement>('[data-pane]')!
    let coreTargets: ReturnType<typeof discoverHostHintTargets> = []
    request.mockImplementation((source, sourceAdapter) => {
      expect(source).toBe(frame)
      coreTargets = discoverHostHintTargets(root, sourceAdapter)
    })
    unregisterAdapter = registerHostHintAdapter(frame, adapter)
    snapshot()
    guest({ type: 'holi-hints:start', nonce, revision: 1 })
    expect(coreTargets).toHaveLength(1)
    expect(hostHintsUnchanged(coreTargets, adapter, root)).toBe(true)
    expect(sent().some((message) => message.type === 'holi-hints:session' && message.active)).toBe(
      true,
    )
    const cancel = vi.fn()
    const route = vi.fn((event: KeyboardEvent) => {
      if (event.key !== 'a') return false
      return activateHostHint(coreTargets[0]!)
    })
    const unsubscribe = adapter.subscribe!(cancel, route)
    guest({ type: 'holi-hints:key', nonce, key: 'a' })
    expect(route).toHaveBeenCalledWith(expect.objectContaining({ key: 'a' }))
    expect(sent().at(-1)).toMatchObject({ type: 'holi-hints:activate', id: 'save', revision: 1 })
    expect(cancel).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('cancels only the matching guest hint session on clear', () => {
    setup()
    snapshot(6)
    const cancel = vi.fn()
    const unsubscribe = adapter.subscribe!(cancel)
    guest({ type: 'holi-hints:start', nonce, revision: 6 })
    guest({ type: 'holi-hints:clear', nonce, revision: 5 })
    expect(cancel).not.toHaveBeenCalled()
    guest({ type: 'holi-hints:clear', nonce, revision: 6 })
    expect(cancel).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('activates a currently discovered target by exact token and revision', () => {
    setup()
    snapshot(4)
    guest({ type: 'holi-hints:start', nonce, revision: 4 })
    const discovered = adapter.discover()[0]!
    const target = {
      ...discovered,
      key: 'a',
      root: frame.closest<HTMLElement>('[data-pane]')!,
      overlay: null,
      adapter,
      scopeAdapter: adapter,
      surface: null,
    }
    expect(adapter.activate(target)).toBe(true)
    expect(sent().at(-1)).toEqual({
      type: 'holi-hints:activate',
      nonce: expect.any(String),
      revision: 4,
      id: 'save',
    })
  })

  it('rejects stale start, forged activation, duplicate targets, and removed frames', () => {
    setup()
    snapshot(2)
    guest({ type: 'holi-hints:start', nonce, revision: 1 })
    expect(request).not.toHaveBeenCalled()
    guest({
      type: 'holi-hints:snapshot',
      nonce,
      revision: 3,
      targets: [
        { id: 'x', kind: 'button', label: 'X', x: 0, y: 0, width: 10, height: 10 },
        { id: 'x', kind: 'button', label: 'X', x: 0, y: 0, width: 10, height: 10 },
      ],
    })
    expect(adapter.discover()).toHaveLength(1)
    frame.remove()
    expect(adapter.discover()).toHaveLength(0)
    adapter.invalidate?.()
    document.body.innerHTML = '<iframe></iframe>'
    frame = document.querySelector('iframe')!
    expect(adapter.discover()).toHaveLength(0)
  })

  it('never revives after disposal or an iframe document load', () => {
    setup()
    snapshot()
    frame.dispatchEvent(new Event('load'))
    expect(adapter.discover()).toHaveLength(0)
    adapter.capture?.()
    expect(adapter.discover()).toHaveLength(0)
  })

  it('accepts exact single alphabet keys only', () => {
    const validNonce = 'host-random-nonce'
    expect(isFrameHintsMessage({ type: 'holi-hints:key', nonce: validNonce, key: 'a' })).toBe(true)
    expect(isFrameHintsMessage({ type: 'holi-hints:key', nonce: validNonce, key: 'asdf' })).toBe(
      false,
    )
    expect(isFrameHintsMessage({ type: 'holi-hints:key', nonce: validNonce, key: 'Escape' })).toBe(
      true,
    )
    expect(isFrameHintsMessage({ type: 'holi-hints:key', nonce: validNonce, key: 'Enter' })).toBe(
      false,
    )
  })
})
