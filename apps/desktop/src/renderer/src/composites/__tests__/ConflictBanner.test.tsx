/**
 * The banner's whole job is offering a way out, so what is tested is which side
 * each button keeps — not that it renders.
 */
import { expect, test, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/render'
import { ConflictBanner } from '../ConflictBanner'

function banner() {
  const keepMine = vi.fn(() => Promise.resolve())
  const takeDisk = vi.fn()
  const onDismiss = vi.fn()
  render(
    <ConflictBanner
      path="22-08-2026.md"
      resolve={{ keepMine, takeDisk }}
      onDismiss={onDismiss}
    />,
  )
  return { keepMine, takeDisk, onDismiss }
}

test('names the file that changed', () => {
  banner()
  expect(screen.getByRole('alert').textContent).toContain('22-08-2026.md')
})

test('"Keep mine" writes the buffer and nothing else', async () => {
  const { keepMine, takeDisk, onDismiss } = banner()

  await userEvent.click(screen.getByText('Keep mine'))

  expect(keepMine).toHaveBeenCalledTimes(1)
  expect(takeDisk).not.toHaveBeenCalled()
  expect(onDismiss).toHaveBeenCalledTimes(1)
})

test('"Use the file on disk" drops the buffer and nothing else', async () => {
  const { keepMine, takeDisk, onDismiss } = banner()

  await userEvent.click(screen.getByText('Use the file on disk'))

  expect(takeDisk).toHaveBeenCalledTimes(1)
  expect(keepMine).not.toHaveBeenCalled()
  expect(onDismiss).toHaveBeenCalledTimes(1)
})

// Dismiss is not a third way to resolve: it must leave both versions untouched,
// or "let me look at the file first" silently picks a side.
test('Dismiss resolves neither side', async () => {
  const { keepMine, takeDisk, onDismiss } = banner()

  await userEvent.click(screen.getByText('Dismiss'))

  expect(keepMine).not.toHaveBeenCalled()
  expect(takeDisk).not.toHaveBeenCalled()
  expect(onDismiss).toHaveBeenCalledTimes(1)
})

// The complaint that produced this component: hardcoded ambers meant a vault
// theme could not reach it (D64). Assert the tokens, not the hex.
test('paints from theme tokens rather than a fixed palette', () => {
  banner()
  const cls = screen.getByRole('alert').className

  expect(cls).toContain('bg-destructive/15')
  expect(cls).toContain('border-destructive/50')
  expect(cls).not.toMatch(/amber|-\[#/)
})
