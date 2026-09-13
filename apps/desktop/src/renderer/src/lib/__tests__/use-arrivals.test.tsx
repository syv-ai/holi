import { StrictMode } from 'react'
import { act, render } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { useArrivalOnChange, useArrivals } from '@/lib/use-arrivals'

function List({ ids }: { ids: string[] }) {
  const { arrivalProps } = useArrivals(ids)
  return (
    <ul>
      {ids.map((id) => {
        const { className, style } = arrivalProps(id)
        return <li key={id} data-testid={id} className={className} style={style} />
      })}
    </ul>
  )
}

const row = (view: ReturnType<typeof render>, id: string) => view.getByTestId(id)

afterEach(() => vi.unstubAllGlobals())

test('nothing arrives on the first render', () => {
  const view = render(<List ids={['a', 'b']} />)
  expect(row(view, 'a').className).toBe('')
  expect(row(view, 'b').className).toBe('')
})

test('only the rows that appeared arrive, and they stagger in order', () => {
  const view = render(<List ids={['a']} />)
  view.rerender(<List ids={['a', 'b', 'c']} />)

  expect(row(view, 'a').className).toBe('')
  expect(row(view, 'b')).toHaveClass('motion-in-fade')
  expect(row(view, 'c')).toHaveClass('motion-in-fade')
  expect(row(view, 'b').style.animationDelay).toBe('0ms')
  expect(row(view, 'c').style.animationDelay).toBe('calc(var(--motion-stagger) * 1)')
})

/**
 * The whole reason this is computed rather than declared: a list that re-renders
 * for an unrelated reason must not REPLAY its arrival — the shape of the bug D92
 * hit, where every heading animated shut on file open.
 *
 * Replaying needs the class to be removed and re-added; a class that simply
 * stays put does nothing. So the assertion is that the class attribute is not
 * touched at all across an unrelated re-render, which is stronger than checking
 * its value and is what the browser actually keys a restart on.
 */
test('a re-render with the same rows does not replay the arrival', async () => {
  const view = render(<List ids={['a']} />)
  view.rerender(<List ids={['a', 'b']} />)
  const b = row(view, 'b')
  expect(b).toHaveClass('motion-in-fade')

  const mutations: string[] = []
  const observer = new MutationObserver((records) => {
    for (const r of records) mutations.push(r.attributeName ?? '?')
  })
  observer.observe(b, { attributes: true, attributeFilter: ['class'] })

  view.rerender(<List ids={['a', 'b']} />)
  view.rerender(<List ids={['a', 'b']} />)
  await act(async () => {
    await Promise.resolve()
  })
  observer.disconnect()

  expect(mutations).toEqual([])
  expect(row(view, 'b')).toHaveClass('motion-in-fade')
})

test('reordering is not arriving', () => {
  const view = render(<List ids={['a', 'b']} />)
  view.rerender(<List ids={['b', 'a']} />)
  expect(row(view, 'a').className).toBe('')
  expect(row(view, 'b').className).toBe('')
})

test('under reduced motion rows still arrive, but all at once', () => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((media: string) => ({
      matches: media.includes('prefers-reduced-motion'),
      media,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  )
  const view = render(<List ids={['a']} />)
  view.rerender(<List ids={['a', 'b', 'c']} />)
  // The class stays — index.css shortens the arrival itself to 1ms — but the
  // ramp flattens, so nothing is queued behind anything.
  expect(row(view, 'c')).toHaveClass('motion-in-fade')
  expect(row(view, 'c').style.animationDelay).toBe('0ms')
})

/**
 * The app mounts under React.StrictMode (main.tsx), which double-invokes render
 * in development. A previous-list ref written DURING render makes the second
 * pass compare the new list against itself, find nothing new, and win — so
 * nothing animates in the dev app while every test above still passes. This is
 * the test that catches that.
 */
test('arrivals survive StrictMode double rendering', () => {
  const view = render(
    <StrictMode>
      <List ids={['a']} />
    </StrictMode>,
  )
  view.rerender(
    <StrictMode>
      <List ids={['a', 'b']} />
    </StrictMode>,
  )
  expect(row(view, 'b')).toHaveClass('motion-in-fade')
  expect(row(view, 'a').className).toBe('')
})

/**
 * The reason the arrival map is held rather than recomputed every render.
 *
 * An arrival takes 300ms plus its stagger. Deriving the map fresh each render
 * looks equivalent and is not: any unrelated re-render inside that window finds
 * nothing new, drops the class off a row that is still animating, and cuts it
 * short. In the file tree an unrelated re-render is routine — the watcher, a
 * selection, a task update — so this is the difference between a stagger that
 * plays and one that flickers.
 */
test('an unrelated re-render does not cut a running arrival short', () => {
  const view = render(<List ids={['a']} />)
  view.rerender(<List ids={['a', 'b']} />)
  expect(row(view, 'b')).toHaveClass('motion-in-fade')

  // Same ids, new array — which is what React hands a component on most renders.
  view.rerender(<List ids={['a', 'b']} />)
  expect(row(view, 'b')).toHaveClass('motion-in-fade')

  view.rerender(<List ids={['a', 'b']} />)
  expect(row(view, 'b')).toHaveClass('motion-in-fade')
})

test('a caller can choose a different arrive variant', () => {
  function FadeList({ ids }: { ids: string[] }) {
    const { arrivalProps } = useArrivals(ids, 'motion-in-top')
    return (
      <ul>
        {ids.map((id) => (
          <li key={id} data-testid={id} {...arrivalProps(id)} />
        ))}
      </ul>
    )
  }
  const view = render(<FadeList ids={['a']} />)
  view.rerender(<FadeList ids={['a', 'b']} />)
  expect(row(view, 'b')).toHaveClass('motion-in-top')
})

// ── useArrivalOnChange ────────────────────────────────────────────────

function Pane({ doc }: { doc: string }) {
  const ref = useArrivalOnChange<HTMLDivElement>(doc)
  return <div ref={ref} data-testid="body" className="relative" />
}

const body = (view: ReturnType<typeof render>) => view.getByTestId('body')

test('the first document does not animate — nothing has been navigated from', () => {
  const view = render(<Pane doc="a.md" />)
  expect(body(view)).not.toHaveClass('motion-in-fade')
})

test('changing document plays the fade', () => {
  const view = render(<Pane doc="a.md" />)
  view.rerender(<Pane doc="b.md" />)
  expect(body(view)).toHaveClass('motion-in-fade')
})

/**
 * The reason this is a hook and not a class chosen during render: React does not
 * touch an attribute whose value has not changed, so writing the same class for
 * a second navigation would replay nothing. a → b → c must fade three times, not
 * once, and the class has to be genuinely removed and re-added to do it.
 */
test('navigating again replays rather than doing nothing', async () => {
  const view = render(<Pane doc="a.md" />)
  view.rerender(<Pane doc="b.md" />)

  const seen: (string | null)[] = []
  const observer = new MutationObserver((records) => {
    for (const r of records) seen.push(r.oldValue)
  })
  observer.observe(body(view), {
    attributes: true,
    attributeFilter: ['class'],
    attributeOldValue: true,
  })

  view.rerender(<Pane doc="c.md" />)
  await act(async () => {
    await Promise.resolve()
  })
  observer.disconnect()

  expect(body(view)).toHaveClass('motion-in-fade')
  // Removed and re-added, which is what the browser keys a restart on.
  expect(seen.some((v) => v?.includes('motion-in-fade'))).toBe(true)
})

test('the class is cleaned up when the fade ends', () => {
  const view = render(<Pane doc="a.md" />)
  view.rerender(<Pane doc="b.md" />)
  const node = body(view)
  expect(node).toHaveClass('motion-in-fade')

  act(() => {
    const e = new Event('animationend', { bubbles: true })
    Object.assign(e, { animationName: 'motion-in-fade' })
    node.dispatchEvent(e)
  })
  expect(node).not.toHaveClass('motion-in-fade')
  // The element keeps everything it was rendered with.
  expect(node).toHaveClass('relative')
})

test('re-rendering with the same document does not re-fade', () => {
  const view = render(<Pane doc="a.md" />)
  view.rerender(<Pane doc="b.md" />)
  const node = body(view)
  act(() => {
    const e = new Event('animationend', { bubbles: true })
    Object.assign(e, { animationName: 'motion-in-fade' })
    node.dispatchEvent(e)
  })

  view.rerender(<Pane doc="b.md" />)
  expect(body(view)).not.toHaveClass('motion-in-fade')
})
