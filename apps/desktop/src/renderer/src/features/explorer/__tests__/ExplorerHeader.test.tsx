/**
 * The explorer's toolbar is the nav menu's morphing menu, anchored at the
 * tree's top-right: "+" unfolds into what can be made, and the rest are
 * shortcuts. Where a new item lands is the tree's (`FileTree`, `newItemPlace`).
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

test('"+" unfolds into task, file, folder and what claims make, each asking for its kind', async () => {
  const p = setup()
  for (const [label, kind] of [
    ['New Task', 'task'],
    ['New File', 'file'],
    ['New Folder', 'folder'],
    ['New App', APP],
  ] as const) {
    await userEvent.click(screen.getByRole('button', { name: 'New' }))
    await userEvent.click(screen.getByRole('button', { name: label }))
    expect(p.onNew).toHaveBeenLastCalledWith(kind)
  }
  expect(p.onNew).toHaveBeenCalledTimes(4)
})

test('Collapse All is a shortcut', async () => {
  const p = setup()
  await userEvent.click(screen.getByRole('button', { name: 'Collapse All' }))
  expect(p.onCollapseAll).toHaveBeenCalledOnce()
})

test('the hidden-files toggle reflects state via aria-pressed and label', async () => {
  const p = setup({ hiddenShown: true })
  const toggle = screen.getByRole('button', { name: 'Hide hidden files' })
  expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await userEvent.click(toggle)
  expect(p.onToggleHidden).toHaveBeenCalledOnce()
})

test('the task-files toggle reflects state via aria-pressed and label', async () => {
  const p = setup({ tasksShown: false })
  const toggle = screen.getByRole('button', { name: 'Show task files' })
  expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await userEvent.click(toggle)
  expect(p.onToggleTasks).toHaveBeenCalledOnce()
})
