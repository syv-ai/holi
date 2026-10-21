/**
 * A task's own frontmatter controls, which core draws for its claimed files
 * in place of a field kind's: done is completion, and a recurrence says its
 * rule in words.
 */
import { render, screen } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { expect, test, vi } from 'vitest'
import { readYamlMapping, type FieldSpec } from '@holi/shared'
import { nowAtom } from '@/plugin-api'
import { TASK_FIELDS } from '../shared/task-file'
import { TASK_CONTROLS } from '../renderer/fields'

const field = (key: string): FieldSpec => TASK_FIELDS.find((f) => f.key === key)!

/** The control for `key` over the block `yaml`, at 2026-09-12. */
function control(key: keyof typeof TASK_CONTROLS, yaml: string) {
  const write = vi.fn()
  const store = createStore()
  store.set(nowAtom, '2026-09-12T10:00')
  const Control = TASK_CONTROLS[key]
  render(
    <Provider store={store}>
      <Control field={field(key)} values={readYamlMapping(yaml) ?? {}} write={write} />
    </Provider>,
  )
  return write
}

test('done on a recurring task writes its next occurrence, not the word', async () => {
  // `done` on a repeat is the next occurrence: a bare write would end the
  // series wherever somebody happened to set it.
  const write = control(
    'status',
    'status: todo\ndue: 2026-09-01\nrecurrence:\n  frequency: weekly\n  interval: 1\n',
  )
  const user = userEvent.setup()
  await user.click(screen.getByRole('combobox', { name: /status/i }))
  await user.click(screen.getByRole('option', { name: 'done' }))
  expect(write).toHaveBeenLastCalledWith({ status: 'todo', due: '2026-09-15' })
})

test('done on a task with no rule is just done', async () => {
  const write = control('status', 'status: doing\n')
  const user = userEvent.setup()
  await user.click(screen.getByRole('combobox', { name: /status/i }))
  await user.click(screen.getByRole('option', { name: 'done' }))
  expect(write).toHaveBeenLastCalledWith({ status: 'done' })
})

test('the recurrence row says the rule in words', () => {
  control(
    'recurrence',
    'status: todo\nrecurrence:\n  frequency: weekly\n  interval: 2\n  weekdays: [wed, mon]\n',
  )
  expect(screen.getByText('every 2 weeks on Mon, Wed')).toBeInTheDocument()
})
