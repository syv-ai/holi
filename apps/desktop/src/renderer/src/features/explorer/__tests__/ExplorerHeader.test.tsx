/**
 * The explorer's toolbar: "+" makes a note, "⋯" holds the rest (a folder, a
 * task, what claims make, the filters, Collapse all). Where a new item lands
 * is the tree's (`FileTree`, `newItemPlace`).
 */
import { render, screen } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { AppWindow } from 'lucide-react'
import type { ClaimCreate } from '@/plugin-api/types'
import { ExplorerHeader } from '../ExplorerHeader'

/** A claim's kind, as the app claim adds New App. */
const APP: ClaimCreate = {
  id: 'app',
  label: 'New App',
  icon: AppWindow,
  placeholder: 'app name',
  run: async () => null,
}

function setup(over: Partial<Parameters<typeof ExplorerHeader>[0]> = {}) {
  const props = {
    creates: [APP],
    onNew: vi.fn(),
    onCollapseAll: vi.fn(),
    hiddenShown: false,
    onToggleHidden: vi.fn(),
    tasksShown: false,
    onToggleTasks: vi.fn(),
    ...over,
  }
  render(<ExplorerHeader {...props} />)
  return props
}

// `hidden`: while the last menu plays its exit, the page behind it is hidden
// from the accessibility tree.
const more = () =>
  userEvent.click(screen.getByRole('button', { name: 'File options', hidden: true }))

test('"+" makes a note', async () => {
  const p = setup()
  await userEvent.click(screen.getByRole('button', { name: 'New note' }))
  expect(p.onNew).toHaveBeenLastCalledWith('file')
})

test('"⋯" makes a folder, a task and what claims make, each asking for its kind', async () => {
  const p = setup()
  for (const [label, kind] of [
    ['New folder', 'folder'],
    ['New task', 'task'],
    ['New App', APP],
  ] as const) {
    await more()
    await userEvent.click(screen.getByRole('menuitem', { name: label }))
    expect(p.onNew).toHaveBeenLastCalledWith(kind)
  }
  expect(p.onNew).toHaveBeenCalledTimes(3)
})

test('Collapse all is in the menu', async () => {
  const p = setup()
  await more()
  await userEvent.click(screen.getByRole('menuitem', { name: 'Collapse all' }))
  expect(p.onCollapseAll).toHaveBeenCalledOnce()
})

test('the filters are checkable rows that say their state', async () => {
  const p = setup({ hiddenShown: true, tasksShown: false })
  await more()
  expect(screen.getByRole('menuitemcheckbox', { name: 'Show hidden files' })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await userEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Show task files' }))
  expect(p.onToggleTasks).toHaveBeenCalledOnce()
  await more()
  await userEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Show hidden files' }))
  expect(p.onToggleHidden).toHaveBeenCalledOnce()
})
