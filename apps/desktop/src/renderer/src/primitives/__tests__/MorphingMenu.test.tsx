import { fireEvent, render, screen } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'
import { MorphingMenu, dockCapacity, dockGrid, type MorphingMenuItem } from '../MorphingMenu'

const dot = <span />
function items(onSelect = vi.fn()): MorphingMenuItem[] {
  return [
    { id: 'home', label: 'Home', icon: dot, onSelect },
    { id: 'search', label: 'Search', icon: dot, onSelect },
    {
      id: 'apps',
      label: 'Apps',
      icon: dot,
      children: [{ id: 'budget', label: 'Budget', icon: dot, onSelect }],
    },
    { id: 'board', label: 'Board', icon: dot, badge: 3, onSelect },
  ]
}

/** jsdom lays nothing out; give the menu's own box a size along its axis. */
function giveRoom(px: number) {
  const size = (el: Element) => (el.matches('nav[data-orientation]') ? px : 0)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return size(this)
  })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return size(this)
  })
}

afterEach(() => vi.restoreAllMocks())

/** The dock's shortcuts, by their accessible names, while collapsed. */
const dock = () =>
  screen
    .getAllByRole('button')
    .filter((b) => b.closest('[aria-hidden="true"]') === null)
    .map((b) => b.getAttribute('aria-label') ?? b.textContent)

test('the dock fills the width and wraps what does not fit', () => {
  // 32px a shortcut, 4px inset each end: 264px holds eight.
  expect(dockGrid(8, 264)).toEqual({ columns: 8, rows: 1 })
  expect(dockGrid(8, 320)).toEqual({ columns: 8, rows: 1 })
  expect(dockGrid(8, 200)).toEqual({ columns: 6, rows: 2 })
  expect(dockGrid(8, 104)).toEqual({ columns: 3, rows: 3 })
  expect(dockGrid(8, 20)).toEqual({ columns: 1, rows: 8 })
  // Unmeasured reads as one row.
  expect(dockGrid(8, 0)).toEqual({ columns: 8, rows: 1 })
})

test('every item has a shortcut in the wrapped dock, and no More', () => {
  giveRoom(104)
  render(<MorphingMenu label="Go to" items={items()} />)
  expect(dock()).toEqual(['Home', 'Search', 'Apps', 'Board'])
})

test('a vertical dock takes what fits along its height, More only for the rest', () => {
  expect(dockCapacity(0, 4)).toBe(0)
  // Three slots: all three items fit, or two and More.
  expect(dockCapacity(104, 3)).toBe(3)
  expect(dockCapacity(104, 4)).toBe(2)
  giveRoom(200)
  render(<MorphingMenu label="Go to" orientation="vertical" items={items()} />)
  expect(dock()).toEqual(['Home', 'Search', 'Apps', 'Board'])
})

test("More's list holds only what the dock had no room for", async () => {
  giveRoom(104)
  render(<MorphingMenu label="Go to" orientation="vertical" items={items()} />)
  expect(dock()).toEqual(['Home', 'Search', 'More'])
  await userEvent.click(screen.getByRole('button', { name: 'More' }))
  const rows = [
    ...document.querySelectorAll('[data-morph-panel][aria-hidden="false"] [data-morph-row]'),
  ]
  expect(rows.map((r) => r.textContent)).toEqual(['Apps', 'Board3'])
})

test('a badge shows on the shortcut; zero shows nothing', () => {
  giveRoom(320)
  const list = items()
  list[0]!.badge = 0
  render(<MorphingMenu label="Go to" items={list} />)
  expect(screen.getByRole('button', { name: 'Board' })).toHaveTextContent('3')
  expect(screen.getByRole('button', { name: 'Home' })).toHaveTextContent('')
})

test('a shortcut acts straight from the dock', async () => {
  giveRoom(320)
  const onSelect = vi.fn()
  render(<MorphingMenu label="Go to" items={items(onSelect)} />)
  await userEvent.click(screen.getByRole('button', { name: 'Home' }))
  expect(onSelect).toHaveBeenCalledOnce()
})

test('a group shortcut opens its children directly', async () => {
  giveRoom(320)
  render(<MorphingMenu label="Go to" items={items()} />)
  await userEvent.click(screen.getByRole('button', { name: 'Apps' }))
  expect(screen.getByRole('navigation')).toHaveAttribute('data-view', 'group')
  // Accessible (not inert, not aria-hidden) is what "open" means; the rows are
  // still arriving.
  expect(screen.getByRole('button', { name: 'Budget' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument()
})

test('Back from a group opened by its shortcut closes the menu', async () => {
  giveRoom(320)
  render(<MorphingMenu label="Go to" items={items()} />)
  await userEvent.click(screen.getByRole('button', { name: 'Apps' }))
  await userEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(screen.getByRole('navigation')).toHaveAttribute('data-view', 'collapsed')
})

test('Back from a group opened in the list returns to the list', async () => {
  render(<MorphingMenu label="Go to" orientation="vertical" items={items()} />)
  await userEvent.click(screen.getByRole('button', { name: 'More' }))
  await userEvent.click(screen.getByRole('button', { name: 'Apps' }))
  await userEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(screen.getByRole('navigation')).toHaveAttribute('data-view', 'main')
})

test('the dock has no surface at rest; the open menu does', async () => {
  render(<MorphingMenu label="Go to" orientation="vertical" items={items()} />)
  const shell = screen.getByRole('navigation').firstElementChild as HTMLElement
  expect(shell).not.toHaveAttribute('data-pinned')
  await userEvent.click(screen.getByRole('button', { name: 'More' }))
  expect(shell).toHaveAttribute('data-pinned')
})

test('Escape steps back a level, then collapses, restoring keyboard focus', async () => {
  const user = userEvent.setup()
  render(<MorphingMenu label="Go to" orientation="vertical" items={items()} />)
  screen.getByRole('button', { name: 'More' }).focus()
  await user.keyboard('{Enter}')
  expect(screen.getByRole('navigation')).toHaveAttribute('data-view', 'main')
  await user.click(screen.getByRole('button', { name: 'Apps' }))
  expect(screen.getByRole('navigation')).toHaveAttribute('data-view', 'group')
  await user.keyboard('{Escape}')
  expect(screen.getByRole('navigation')).toHaveAttribute('data-view', 'main')
  await user.keyboard('{Escape}')
  expect(screen.getByRole('navigation')).toHaveAttribute('data-view', 'collapsed')
  expect(screen.getByRole('button', { name: 'More' })).toHaveFocus()
})

test('picking a row closes the menu and runs it', async () => {
  const onSelect = vi.fn()
  render(<MorphingMenu label="Go to" orientation="vertical" items={items(onSelect)} />)
  await userEvent.click(screen.getByRole('button', { name: 'More' }))
  await userEvent.click(screen.getByRole('button', { name: 'Search' }))
  expect(onSelect).toHaveBeenCalledOnce()
  expect(screen.getByRole('navigation')).toHaveAttribute('data-view', 'collapsed')
})

test('a press outside dismisses without choosing', async () => {
  const onSelect = vi.fn()
  render(
    <>
      <MorphingMenu label="Go to" orientation="vertical" items={items(onSelect)} />
      <p>elsewhere</p>
    </>,
  )
  await userEvent.click(screen.getByRole('button', { name: 'More' }))
  fireEvent.pointerDown(screen.getByText('elsewhere'))
  expect(screen.getByRole('navigation')).toHaveAttribute('data-view', 'collapsed')
  expect(onSelect).not.toHaveBeenCalled()
})

test('the active item, and the group holding it, read as current', async () => {
  render(<MorphingMenu label="Go to" orientation="vertical" activeId="budget" items={items()} />)
  await userEvent.click(screen.getByRole('button', { name: 'More' }))
  expect(screen.getByRole('button', { name: 'Apps' })).toHaveAttribute('aria-current', 'true')
})

test('a toggle reports its state on its shortcut and its row', async () => {
  giveRoom(72)
  render(
    <MorphingMenu
      label="Tools"
      orientation="vertical"
      items={[
        { id: 'on', label: 'On', icon: dot, pressed: true },
        { id: 'off', label: 'Off', icon: dot, pressed: false },
        { id: 'plain', label: 'Plain', icon: dot },
      ]}
    />,
  )
  // One slot for On, one for More: Off and Plain are rows.
  expect(screen.getByRole('button', { name: 'On' })).toHaveAttribute('aria-pressed', 'true')
  await userEvent.click(screen.getByRole('button', { name: 'More' }))
  const row = (id: string) => document.querySelector(`[data-morph-row][data-menu-item="${id}"]`)
  expect(row('off')).toHaveAttribute('aria-pressed', 'false')
  expect(row('plain')).not.toHaveAttribute('aria-pressed')
})

test('anchored top-right, the open menu pins by its top-right corner', async () => {
  giveRoom(320)
  render(<MorphingMenu label="Tools" anchor="top-right" items={items()} />)
  await userEvent.click(screen.getByRole('button', { name: 'Apps' }))
  const shell = document.querySelector<HTMLElement>('[data-pinned]')!
  expect(shell.style.position).toBe('fixed')
  expect(shell.style.top).not.toBe('')
  expect(shell.style.right).not.toBe('')
  expect(shell.style.bottom).toBe('')
  expect(shell.style.left).toBe('')
})
