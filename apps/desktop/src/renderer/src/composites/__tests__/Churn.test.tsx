/**
 * The `+40 −3` beside a commit.
 *
 * Small, but it has one rule worth guarding and one colour rule worth stating,
 * and both are the kind a later tidy-up removes for looking arbitrary.
 */
import { expect, test } from 'vitest'
import { render } from '@/test/render'
import { Churn } from '../Churn'

test('shows both counts', () => {
  const { container } = render(<Churn added={40} removed={3} />)
  expect(container.textContent).toBe('+40 −3')
})

test('omits the side that is zero rather than printing +0', () => {
  expect(render(<Churn added={12} removed={0} />).container.textContent).toBe('+12')
  expect(render(<Churn added={0} removed={7} />).container.textContent).toBe('−7')
})

test('renders nothing at all when a commit has no diff of its own', () => {
  // A merge. `--numstat` reports no lines for one, so this would otherwise read
  // as `+0 −0` — a commit that did nothing, rather than one whose changes came
  // from somewhere else.
  const { container } = render(<Churn added={0} removed={0} />)
  expect(container.textContent).toBe('')
})

test('uses the diff FOREGROUND tokens, not the tint ones', () => {
  // `--diff-added` is a mid-ramp 500 chosen to read as a wash behind words;
  // green-500 as text on white paper is about 2.2:1. The foreground pair takes
  // a light arm for exactly the reason the syntax ramp does.
  const { container } = render(<Churn added={1} removed={1} />)
  const classes = [...container.querySelectorAll('span')].map((s) => s.className).join(' ')

  expect(classes).toContain('text-diff-added-foreground')
  expect(classes).toContain('text-diff-removed-foreground')
  // `\b` would match before the hyphen and so match the -foreground class too.
  expect(classes).not.toMatch(/text-diff-added(?![-\w])/)
})
