import { render, screen } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { FrontmatterFields } from '../FrontmatterFields'

/** The complete-a-task path, which is the one write that does not go through
 *  the document. Hoisted so the mock and the assertions share it. */
const { completed } = vi.hoisted(() => ({ completed: vi.fn() }))

vi.mock('@/state/tasks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/state/tasks')>()),
  completeTaskAtom: { toString: () => 'completeTaskAtom' },
}))

vi.mock('jotai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jotai')>()
  return {
    ...actual,
    useAtomValue: () => '2026-09-12T10:00',
    useSetAtom: () => completed,
  }
})

const TASK = 'projects/task.fix-the-tap.md'

function fields(yaml: string, path = TASK) {
  const onWrite = vi.fn()
  render(<FrontmatterFields path={path} yaml={yaml} onWrite={onWrite} />)
  return onWrite
}

test('draws every schema row, whether the file has the key or not', () => {
  // A field you can fill in without knowing its name.
  fields('status: todo\n')
  for (const key of ['status', 'due', 'priority', 'reminder', 'tags', 'recurrence']) {
    expect(screen.getByText(key)).toBeInTheDocument()
  }
})

test('does not draw `order`, which means nothing to a human', () => {
  fields('status: todo\norder: 1.5\n')
  expect(screen.queryByText('order')).not.toBeInTheDocument()
})

test('a note gets the note schema, not the task one', () => {
  fields('created: 2026-09-12\n', 'notes/meeting.md')
  expect(screen.getByText('created')).toBeInTheDocument()
  expect(screen.queryByText('status')).not.toBeInTheDocument()
})

test('the folder is a row, derived and read-only', () => {
  // The one fact about a task that is not in its file. Editing it would be a
  // move, which has to rewrite inbound links, so it is not editable here.
  fields('status: todo\n')
  expect(screen.getByText('folder')).toBeInTheDocument()
  expect(screen.getByText('projects')).toBeInTheDocument()
})

test('a key the schema never heard of renders as text and survives a write', async () => {
  // The migration path for a leftover `title:`, and the promise `Task.extra`
  // already makes: an unknown key is not an error and is never dropped.
  const onWrite = fields('status: todo\ntitle: Stale\n')
  expect(screen.getByText('title')).toBeInTheDocument()

  const user = userEvent.setup()
  await user.click(screen.getByRole('combobox', { name: 'priority' }))
  await user.click(screen.getByRole('option', { name: 'high' }))
  expect(onWrite).toHaveBeenCalled()
  expect(onWrite.mock.calls[0]![0]).toContain('title: Stale')
})

test('setting an enum writes the value into the YAML', async () => {
  const onWrite = fields('status: todo\n')
  const user = userEvent.setup()

  await user.click(screen.getByRole('combobox', { name: /status/i }))
  await user.click(screen.getByRole('option', { name: 'doing' }))

  expect(onWrite).toHaveBeenCalledWith(expect.stringContaining('status: doing'))
})

test('clearing a field deletes the key rather than writing a null', async () => {
  const onWrite = fields('status: todo\npriority: high\n')
  const user = userEvent.setup()

  await user.click(screen.getByRole('combobox', { name: /priority/i }))
  await user.click(screen.getByRole('option', { name: '—' }))

  const written = onWrite.mock.calls[0]![0] as string
  expect(written).not.toContain('priority')
  expect(written).toContain('status: todo')
})

test('a tag is a chip, and removing one writes the rest', async () => {
  const onWrite = fields('status: todo\ntags: [home, errand]\n')
  expect(screen.getByText('home')).toBeInTheDocument()

  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'remove home' }))

  const written = onWrite.mock.calls[0]![0] as string
  expect(written).toContain('errand')
  expect(written).not.toContain('home')
})

test('the last tag removed clears the key instead of writing an empty list', async () => {
  const onWrite = fields('status: todo\ntags: [home]\n')
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'remove home' }))

  expect(onWrite.mock.calls[0]![0]).not.toContain('tags')
})

test('done on a recurring task rolls forward instead of writing the word', async () => {
  // The one edit that cannot be a text write: `done` on a repeat is the next
  // occurrence, not a status, and a bare write would end the series wherever
  // somebody happened to set it.
  completed.mockClear()
  const onWrite = fields('status: todo\nrecurrence:\n  frequency: weekly\n  interval: 1\n')
  const user = userEvent.setup()

  await user.click(screen.getByRole('combobox', { name: /status/i }))
  await user.click(screen.getByRole('option', { name: 'done' }))

  expect(completed).toHaveBeenCalledWith(TASK)
  expect(onWrite).not.toHaveBeenCalled()
})

test('the recurrence row says the rule in words', () => {
  fields('status: todo\nrecurrence:\n  frequency: weekly\n  interval: 2\n  weekdays: [wed, mon]\n')
  expect(screen.getByText('every 2 weeks on Mon, Wed')).toBeInTheDocument()
})

test('frontmatter that is not a mapping draws nothing, so the YAML can show', () => {
  const { container } = render(
    <FrontmatterFields path={TASK} yaml={'- not\n- a map\n'} onWrite={() => {}} />,
  )
  expect(container).toBeEmptyDOMElement()
})

test('the agent surface draws nothing either — its frontmatter is not ours', () => {
  const { container } = render(
    <FrontmatterFields path="AGENTS.md" yaml={'name: x\n'} onWrite={() => {}} />,
  )
  expect(container).toBeEmptyDOMElement()
})
