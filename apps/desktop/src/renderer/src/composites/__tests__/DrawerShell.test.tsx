/**
 * The drawer every sidebar shares: it pushes in and out by its width, stays
 * mounted until it has slid out, keeps the nav's content while hidden, and
 * resizes within one range, remembered per drawer.
 */
import { act, render, screen } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { expect, test, vi } from 'vitest'
import { DRAWER_WIDTH } from '@/lib/drawer'
import { DrawerShell, DrawerTitle, drawerWidthsAtom } from '../DrawerShell'

function drawer(
  props: Partial<React.ComponentProps<typeof DrawerShell>> = {},
  store = createStore(),
) {
  const ui = (p: Partial<React.ComponentProps<typeof DrawerShell>>) => (
    <Provider store={store}>
      <DrawerShell
        id="history"
        side="right"
        open
        label="History"
        header={<DrawerTitle title="History" subtitle="notes/plan.md" />}
        {...props}
        {...p}
      >
        <p>body</p>
      </DrawerShell>
    </Provider>
  )
  const view = render(ui({}))
  return {
    store,
    rerender: (p: Partial<React.ComponentProps<typeof DrawerShell>>) => view.rerender(ui(p)),
  }
}

const section = () => document.querySelector<HTMLElement>('[data-slot="drawer"]')

/** jsdom has no TransitionEvent, so `propertyName` has to be put on by hand. */
function slideEnds(el: HTMLElement) {
  const ev = new Event('transitionend', { bubbles: true })
  Object.defineProperty(ev, 'propertyName', { value: 'width' })
  act(() => void el.dispatchEvent(ev))
}

test('opens at the shared default width, with its header and body', () => {
  drawer({ aside: '45 revisions' })
  expect(section()).toHaveAttribute('data-state', 'open')
  expect(section()!.style.getPropertyValue('--drawer-w')).toBe(`${DRAWER_WIDTH.default}px`)
  expect(screen.getByText('History')).toBeInTheDocument()
  expect(screen.getByText('notes/plan.md')).toBeInTheDocument()
  expect(screen.getByText('45 revisions')).toBeInTheDocument()
  expect(screen.getByText('body')).toBeInTheDocument()
})

test('is not there at all while closed', () => {
  drawer({ open: false })
  expect(section()).toBeNull()
})

test('closing keeps it mounted until the slide has ended', () => {
  const { rerender } = drawer()
  rerender({ open: false })
  expect(section()).toHaveAttribute('data-state', 'closed')
  expect(screen.getByText('body')).toBeInTheDocument()

  slideEnds(section()!)
  expect(section()).toBeNull()
})

test('reopening mid-slide keeps the same drawer, turned back', () => {
  const { rerender } = drawer()
  rerender({ open: false })
  const el = section()
  rerender({ open: true })
  expect(section()).toBe(el)
  expect(section()).toHaveAttribute('data-state', 'open')
})

test('keepMounted holds the content while hidden, inert', () => {
  const { rerender } = drawer({ id: 'nav', side: 'left', keepMounted: true })
  rerender({ open: false })
  slideEnds(section()!)
  expect(screen.getByText('body')).toBeInTheDocument()
  expect(section()).toHaveAttribute('inert')
})

test('arrow keys resize toward the content, clamped, and remember it per drawer', async () => {
  const { store } = drawer({ id: 'nav', side: 'left' })
  const handle = screen.getByRole('separator', { name: 'Resize History' })
  const user = userEvent.setup()

  handle.focus()
  await user.keyboard('{ArrowRight}')
  expect(store.get(drawerWidthsAtom).nav).toBe(DRAWER_WIDTH.default + 16)

  store.set(drawerWidthsAtom, { nav: DRAWER_WIDTH.max })
  await user.keyboard('{ArrowRight}')
  expect(store.get(drawerWidthsAtom).nav).toBe(DRAWER_WIDTH.max)
})

test('a right-hand drawer widens leftward', async () => {
  const { store } = drawer()
  screen.getByRole('separator').focus()
  await userEvent.setup().keyboard('{ArrowLeft}')
  expect(store.get(drawerWidthsAtom).history).toBe(DRAWER_WIDTH.default + 16)
})

test('a close control calls onClose', async () => {
  const onClose = vi.fn()
  drawer({ onClose })
  await userEvent.setup().click(screen.getByRole('button', { name: 'Close History' }))
  expect(onClose).toHaveBeenCalledOnce()
})
