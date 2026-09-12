import { StrictMode } from 'react'
import { render } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { useArrivals } from '@/lib/use-arrivals'

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
  expect(row(view, 'b')).toHaveClass('motion-in-top')
  expect(row(view, 'c')).toHaveClass('motion-in-top')
  expect(row(view, 'b').style.animationDelay).toBe('0ms')
  expect(row(view, 'c').style.animationDelay).toBe('calc(var(--motion-stagger) * 1)')
})

/**
 * The whole reason this is computed rather than declared. A list that
 * re-renders for an unrelated reason must not replay its arrival — that is the
 * shape of the bug D92 hit, where every heading animated shut on file open.
 */
test('a re-render with the same rows animates nothing again', () => {
  const view = render(<List ids={['a']} />)
  view.rerender(<List ids={['a', 'b']} />)
  expect(row(view, 'b')).toHaveClass('motion-in-top')

  view.rerender(<List ids={['a', 'b']} />)
  expect(row(view, 'b').className).toBe('')
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
  expect(row(view, 'c')).toHaveClass('motion-in-top')
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
  expect(row(view, 'b')).toHaveClass('motion-in-top')
  expect(row(view, 'a').className).toBe('')
})
