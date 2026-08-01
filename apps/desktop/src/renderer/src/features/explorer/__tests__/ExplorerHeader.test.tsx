import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { ExplorerHeader } from '../ExplorerHeader'

function setup(over: Partial<Parameters<typeof ExplorerHeader>[0]> = {}) {
  const props = {
    onNewFile: vi.fn(),
    onNewFolder: vi.fn(),
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

test('each action button invokes its handler', async () => {
  const p = setup()
  await userEvent.click(screen.getByRole('button', { name: 'New File' }))
  await userEvent.click(screen.getByRole('button', { name: 'New Folder' }))
  await userEvent.click(screen.getByRole('button', { name: 'Collapse All' }))
  expect(p.onNewFile).toHaveBeenCalledOnce()
  expect(p.onNewFolder).toHaveBeenCalledOnce()
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
