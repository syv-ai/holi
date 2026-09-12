import { act, render } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { useAck, type AckVariant } from '@/lib/use-ack'

/** A host that exposes `ack` to the test and nothing else. */
function Host({ onReady }: { onReady: (ack: (v: AckVariant) => void) => void }) {
  const { ref, ack } = useAck<HTMLDivElement>()
  onReady(ack)
  return (
    <div ref={ref} data-testid="target">
      <span data-testid="child" />
    </div>
  )
}

function mount() {
  let ack!: (v: AckVariant) => void
  const view = render(<Host onReady={(fn) => (ack = fn)} />)
  const node = view.getByTestId('target')
  return { view, node, child: view.getByTestId('child'), ack: (v: AckVariant) => act(() => ack(v)) }
}

/**
 * jsdom runs no animations, so the end of one only ever happens on purpose —
 * and jsdom has no `AnimationEvent` constructor either, so this is a plain
 * bubbling Event carrying the one field the hook reads.
 */
function endAnimation(from: HTMLElement, animationName = 'motion-ack-bloom') {
  act(() => {
    const e = new Event('animationend', { bubbles: true, composed: true })
    Object.assign(e, { animationName })
    from.dispatchEvent(e)
  })
}

function reducedMotion(on: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((media: string) => ({
      matches: on && media.includes('prefers-reduced-motion'),
      media,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  )
}

afterEach(() => vi.unstubAllGlobals())

test('an ack puts its class on, and the animation ending takes it off', () => {
  const { node, ack } = mount()
  expect(node.className).toBe('')

  ack('bloom')
  expect(node).toHaveClass('motion-ack-bloom')

  endAnimation(node)
  expect(node.className).toBe('')
})

test('each variant wears its own class, and only one at a time', () => {
  const { node, ack } = mount()
  ack('flash')
  expect(node).toHaveClass('motion-ack-flash')

  ack('nudge')
  expect(node).toHaveClass('motion-ack-nudge')
  expect(node).not.toHaveClass('motion-ack-flash')
})

/**
 * The reason this is a hook and not a class toggle.
 *
 * Removing and re-adding a class in one tick does not restart a CSS animation:
 * the browser coalesces the two mutations and nothing plays. The fix is to force
 * a reflow between them, and both halves are asserted here because neither is
 * visible in jsdom on its own — the DOM has to go present → absent → present,
 * AND a layout property has to be read in the gap.
 */
test('acking twice in a row replays rather than doing nothing', async () => {
  const { node, ack } = mount()
  const reflows = vi.fn()
  Object.defineProperty(node, 'offsetWidth', { get: () => (reflows(), 0), configurable: true })

  const seen: (string | null)[] = []
  const observer = new MutationObserver((records) => {
    for (const r of records) seen.push(r.oldValue)
  })
  observer.observe(node, { attributes: true, attributeFilter: ['class'], attributeOldValue: true })

  ack('bloom')
  ack('bloom')
  await act(async () => {
    await Promise.resolve()
  })
  observer.disconnect()

  expect(node).toHaveClass('motion-ack-bloom')
  // present → absent → present across the second call.
  expect(seen).toContain('motion-ack-bloom')
  expect(reflows).toHaveBeenCalled()
})

/**
 * `animationend` bubbles. Without a target check, any animating descendant would
 * end the parent's ack early — and inside this app a K frequently lands on a row
 * that contains chips, icons and spinners.
 */
test("a child's animation ending does not clear the parent's ack", () => {
  const { node, child, ack } = mount()
  ack('bloom')

  endAnimation(child)
  expect(node).toHaveClass('motion-ack-bloom')

  endAnimation(node)
  expect(node.className).toBe('')
})

test('reduced motion drops the variants that travel and keeps the ones that paint', () => {
  reducedMotion(true)
  const { node, ack } = mount()

  ack('tick')
  expect(node.className).toBe('')
  ack('nudge')
  expect(node.className).toBe('')

  ack('bloom')
  expect(node).toHaveClass('motion-ack-bloom')
  ack('flash')
  expect(node).toHaveClass('motion-ack-flash')
})

test('unmounting mid-animation does not throw', () => {
  const { view, ack } = mount()
  ack('bloom')
  expect(() => view.unmount()).not.toThrow()
})

test('acking before the node exists is a no-op rather than a crash', () => {
  let ack!: (v: AckVariant) => void
  function Early({ onReady }: { onReady: (fn: (v: AckVariant) => void) => void }) {
    const { ack: fn } = useAck<HTMLDivElement>()
    onReady(fn)
    return null
  }
  render(<Early onReady={(fn) => (ack = fn)} />)
  expect(() => ack('bloom')).not.toThrow()
})
