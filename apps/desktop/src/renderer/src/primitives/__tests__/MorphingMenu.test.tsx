import { fireEvent, render, screen } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'
import { MorphingMenu, dockCapacity, type MorphingMenuItem } from '../MorphingMenu'

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

test('the dock takes as many shortcuts as fit, More always last', () => {
  // 32px a shortcut, 4px inset each end, one slot for More.
  expect(dockCapacity(0)).toBe(0)
  expect(dockCapacity(40)).toBe(0)
  expect(dockCapacity(104)).toBe(2)
  expect(dockCapacity(320)).toBe(8)

  giveRoom(104)
  render(<MorphingMenu label="Go to" items={items()} />)
  expect(dock()).toEqual(['Home', 'Search', 'More'])
})

test('a vertical dock fits along its height', () => {
  giveRoom(200)
  render(<MorphingMenu label="Go to" orientation="vertical" items={items()} />)
  expect(dock()).toEqual(['Home', 'Search', 'Apps', 'Board', 'More'])
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

test('Escape steps back a level, then collapses, restoring keyboard focus', async () => {
  const user = userEvent.setup()
  render(<MorphingMenu label="Go to" items={items()} />)
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
  render(<MorphingMenu label="Go to" items={items(onSelect)} />)
  await userEvent.click(screen.getByRole('button', { name: 'More' }))
  await userEvent.click(screen.getByRole('button', { name: 'Search' }))
  expect(onSelect).toHaveBeenCalledOnce()
  expect(screen.getByRole('navigation')).toHaveAttribute('data-view', 'collapsed')
})

test('a press outside dismisses without choosing', async () => {
  const onSelect = vi.fn()
  render(
    <>
      <MorphingMenu label="Go to" items={items(onSelect)} />
      <p>elsewhere</p>
    </>,
  )
  await userEvent.click(screen.getByRole('button', { name: 'More' }))
  fireEvent.pointerDown(screen.getByText('elsewhere'))
  expect(screen.getByRole('navigation')).toHaveAttribute('data-view', 'collapsed')
  expect(onSelect).not.toHaveBeenCalled()
})

test('the active item, and the group holding it, read as current', async () => {
  render(<MorphingMenu label="Go to" activeId="budget" items={items()} />)
  await userEvent.click(screen.getByRole('button', { name: 'More' }))
  expect(screen.getByRole('button', { name: 'Apps' })).toHaveAttribute('aria-current', 'true')
})
