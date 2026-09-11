import { render, screen } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { Dialog } from '@/primitives'
import { CreateTask } from '../CreateTask'

// The body editor pulls the whole CodeMirror chain at import time; quick mode
// renders none of it, and this unit test asserts only the footer contract.
vi.mock('@/features/tasks/TaskBodyEditor', () => ({
  TaskDescriptionEditor: () => null,
}))

// The block's own contract: the create/patch atoms are covered by state tests.
test('confirm is disabled until a title is entered', async () => {
  render(
    <Dialog open onClose={() => {}}>
      <CreateTask mode="quick" onClose={() => {}} />
    </Dialog>,
  )
  const confirm = screen.getByRole('button', { name: /create/i })
  expect(confirm).toBeDisabled()

  await userEvent.type(screen.getByLabelText('Title'), 'Call the vendor')
  expect(confirm).toBeEnabled()
})
