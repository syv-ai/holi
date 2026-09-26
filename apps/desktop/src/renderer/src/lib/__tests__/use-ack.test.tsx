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

/** jsdom has no `AnimationEvent`, so a plain bubbling Event. */
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
 * Why this is a hook: remove and re-add in one tick coalesce, so a reflow must
 * be forced between them. Both halves are asserted: the class toggles, and a
 * layout property is read in the gap.
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

/** `animationend` bubbles; a descendant's must not end the parent's ack. */
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
