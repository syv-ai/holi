import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostHintTarget } from '@/plugin-api'
import { createMailHintAdapter } from '../renderer/mail-hints'
import { installHintLayout } from '@/test/host-hint-layout'

let frame: HTMLIFrameElement
let pane: HTMLElement
let document_: Document
let generation: number
let scope: string
let adapter: ReturnType<typeof createMailHintAdapter>

function setup() {
  const layout = installHintLayout()
  pane = document.createElement('main')
  pane.dataset.pane = ''
  const ordinary = document.createElement('button')
  ordinary.textContent = 'Host action'
  layout.place(ordinary, 10, 10, 80, 24)
  pane.append(ordinary)
  frame = document.createElement('iframe')
  pane.append(frame)
  document.body.append(pane)
  document_ = frame.contentDocument!
  document_.open()
  document_.write(
    '<!doctype html><html><body><a href="https://example.test/">Read\n  <span>more</span></a><summary>Not a disclosure</summary><div role="button">Not a command</div></body></html>',
  )
  document_.close()
  Object.defineProperty(frame, 'clientWidth', { configurable: true, value: 300 })
  Object.defineProperty(frame, 'clientHeight', { configurable: true, value: 200 })
  vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 50, 300, 200))
  const link = document_.querySelector('a')!
  vi.spyOn(link, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 10, 80, 20))
  Object.defineProperty(document_, 'elementFromPoint', { configurable: true, value: () => link })
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: (x: number) => (x < 100 ? pane.querySelector('button') : frame),
  })
  generation = 1
  scope = 'vault-a:account-a:thread-a:message-a'
  adapter = createMailHintAdapter({ frame, generation: () => generation, scope: () => scope })
  adapter.capture?.()
}

function scopedTargets(): HostHintTarget[] {
  return adapter.discover().map((target, index) => ({
    ...target,
    key: String(index),
    root: pane,
    overlay: null,
    adapter,
    scopeAdapter: adapter,
    surface: null,
  }))
}

beforeEach(setup)
afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('mail document Vim hints', () => {
  it('shares the host coordinator session and activates only safe native anchors', () => {
    const targets = scopedTargets()
    expect(targets.map(({ label }) => label)).toEqual(['Read more'])
    const linkHint = targets.find(({ label }) => label === 'Read more')!
    const click = vi.spyOn(linkHint.element as HTMLElement, 'click')
    expect(adapter.unchanged(targets)).toBe(true)
    expect(
      adapter.activate({
        ...linkHint,
        key: 'a',
        root: pane,
        overlay: null,
        adapter,
        scopeAdapter: adapter,
        surface: null,
      }),
    ).toBe(true)
    expect(click).toHaveBeenCalledOnce()
  })

  it('rejects rewritten documents and stale A-B-A ownership generations', () => {
    const original = scopedTargets()
    document_.open()
    document_.write(
      '<!doctype html><html><body><a href="https://example.test/new">Rewritten</a></body></html>',
    )
    document_.close()
    expect(adapter.unchanged(original)).toBe(false)
  })

  it('rejects stale ownership, A-B-A visits, and removed frame targets', () => {
    const original = scopedTargets()
    scope = 'vault-b:account-b:thread-a:message-a'
    expect(adapter.unchanged(original)).toBe(false)
    generation += 1
    scope = 'vault-a:account-a:thread-a:message-a'
    expect(adapter.unchanged(original)).toBe(false)

    adapter.capture?.()
    const current = scopedTargets()
    document_.querySelector('a')!.remove()
    expect(adapter.unchanged(current)).toBe(false)
    expect(
      adapter.activate({
        ...current[0]!,
        key: 'a',
        root: pane,
        overlay: null,
        adapter,
        scopeAdapter: adapter,
        surface: null,
      }),
    ).toBe(false)
  })

  it('routes active hint keys only from ordinary frame content', () => {
    const route = vi.fn(() => true)
    const invalidate = vi.fn()
    const dispose = adapter.subscribe!(invalidate, route)
    document_.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    expect(route).toHaveBeenCalledOnce()

    const input = document_.createElement('input')
    document_.body.append(input)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }))
    const editable = document_.createElement('div')
    editable.setAttribute('contenteditable', 'plaintext-only')
    const editableText = document_.createElement('span')
    editable.append(editableText)
    document_.body.append(editable)
    editableText.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }))
    document_.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'd', bubbles: true, isComposing: true }),
    )
    expect(route).toHaveBeenCalledOnce()
    dispose()
  })

  it('excludes zero-opacity and disabled descendants using host eligibility rules', () => {
    const link = document_.querySelector('a')!
    const hidden = document_.createElement('div')
    hidden.style.opacity = '0'
    hidden.append(link.cloneNode(true))
    document_.body.append(hidden)
    const disabled = document_.createElement('fieldset')
    disabled.disabled = true
    disabled.append(link.cloneNode(true))
    document_.body.append(disabled)
    const ariaDisabled = document_.createElement('div')
    ariaDisabled.setAttribute('aria-disabled', 'true')
    ariaDisabled.append(link.cloneNode(true))
    document_.body.append(ariaDisabled)
    expect(adapter.discover()).toHaveLength(1)
  })

  it('hides targets when the owned host frame is transparent or clipped from view', () => {
    frame.style.opacity = '0'
    expect(adapter.discover()).toHaveLength(0)
    frame.style.opacity = ''
    frame.style.display = 'none'
    expect(adapter.discover()).toHaveLength(0)
  })

  it('uses a visible edge when a target center is covered', () => {
    const link = document_.querySelector('a')!
    vi.spyOn(link, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 10, 80, 20))
    const calls: [number, number][] = []
    Object.defineProperty(document_, 'elementFromPoint', {
      configurable: true,
      value: (x: number, y: number) => {
        calls.push([x, y])
        return x < 20 ? link : document_.createElement('div')
      },
    })
    expect(adapter.discover()).toHaveLength(1)
    expect(calls.length).toBeGreaterThan(1)
  })

  it('rejects frame removal and geometry hidden by host overlays', () => {
    const targets = scopedTargets()
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => document.createElement('div'),
    })
    expect(adapter.unchanged(targets)).toBe(false)
    frame.remove()
    expect(adapter.unchanged(targets)).toBe(false)
  })
})
