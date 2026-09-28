import { render, screen, waitFor } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { Provider, createStore } from 'jotai'
import { nowAtom } from '@/state/clock'
import { FrontmatterFields } from '../FrontmatterFields'

const TASK = 'projects/task.fix-the-tap.md'

function fields(yaml: string, path = TASK) {
  const onWrite = vi.fn()
  const store = createStore()
  store.set(nowAtom, '2026-09-12T10:00')
  render(
    <Provider store={store}>
      <FrontmatterFields path={path} yaml={yaml} onWrite={onWrite} />
    </Provider>,
  )
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
  fields('tags: [ops]\n', 'notes/meeting.md')
  expect(screen.getByText('tags')).toBeInTheDocument()
  expect(screen.queryByText('status')).not.toBeInTheDocument()
})

test('an old `created:` is an ordinary key now, not a date field', () => {
  // The creation date is git's first commit, shown as metadata. A note that
  // still carries the line gets a plain text row like any unknown key.
  fields('created: 2026-09-12\n', 'notes/meeting.md')
  expect(screen.getByRole('textbox', { name: 'created' })).toHaveValue('2026-09-12')
  expect(screen.queryByTestId('fm-created')).not.toBeInTheDocument()
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

  await user.click(screen.getByRole('button', { name: 'remove field priority' }))

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

test('the tag field is one control: pressing its box puts the caret in it', async () => {
  const onWrite = fields('status: todo\ntags: [home]\n')
  const input = screen.getByRole('combobox', { name: 'add to tags' })
  const user = userEvent.setup()

  // The box, not the input: before, the input was a small island inside it and
  // a press anywhere else in the field did nothing.
  await user.click(input.parentElement!)
  expect(input).toHaveFocus()

  await user.keyboard('errand{Enter}')
  expect(onWrite).toHaveBeenCalledWith(expect.stringContaining('errand'))
})

test('the last tag removed clears the key instead of writing an empty list', async () => {
  const onWrite = fields('status: todo\ntags: [home]\n')
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'remove home' }))

  expect(onWrite.mock.calls[0]![0]).not.toContain('tags')
})

test('any key can be added as free text, below the rows', async () => {
  const onWrite = fields('tags: [ops]\n', 'notes/meeting.md')
  const user = userEvent.setup()

  await user.click(screen.getByRole('button', { name: 'add field' }))
  await user.keyboard('source{Enter}')
  expect(screen.getByRole('textbox', { name: 'new field value' })).toHaveFocus()
  await user.keyboard('the standup{Enter}')

  const written = onWrite.mock.calls[0]![0] as string
  expect(written).toContain('source: the standup')
  expect(written).toContain('tags:')
})

test('Escape closes the add row and writes nothing', async () => {
  const onWrite = fields('tags: [ops]\n', 'notes/meeting.md')
  const user = userEvent.setup()

  await user.click(screen.getByRole('button', { name: 'add field' }))
  await user.keyboard('source{Escape}')

  expect(onWrite).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'add field' })).toBeInTheDocument()
})

test('done on a recurring task writes its next occurrence, not the word', async () => {
  // `done` on a repeat is the next occurrence: a bare write would end the
  // series wherever somebody happened to set it. Today is 2026-09-12.
  const onWrite = fields(
    'status: todo\ndue: 2026-09-01\nrecurrence:\n  frequency: weekly\n  interval: 1\n',
  )
  const user = userEvent.setup()

  await user.click(screen.getByRole('combobox', { name: /status/i }))
  await user.click(screen.getByRole('option', { name: 'done' }))

  const written = onWrite.mock.lastCall![0] as string
  expect(written).toContain('status: todo')
  expect(written).toContain('due: 2026-09-15')
})

test('done on a task with no rule is just done', async () => {
  const onWrite = fields('status: doing\n')
  const user = userEvent.setup()

  await user.click(screen.getByRole('combobox', { name: /status/i }))
  await user.click(screen.getByRole('option', { name: 'done' }))

  expect(onWrite).toHaveBeenLastCalledWith(expect.stringContaining('status: done'))
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

test('the × on a key you added deletes it, row and all', async () => {
  const onWrite = fields('tags: [ops]\nsource: email\n', 'notes/meeting.md')
  const user = userEvent.setup()

  await user.click(screen.getByRole('button', { name: 'remove field source' }))

  const written = onWrite.mock.calls[0]![0] as string
  expect(written).not.toContain('source')
  expect(written).toContain('ops')
})

test('the × on a schema key unsets it', async () => {
  const onWrite = fields('status: todo\npriority: high\n')
  const user = userEvent.setup()

  await user.click(screen.getByRole('button', { name: 'remove field priority' }))

  expect(onWrite.mock.calls[0]![0]).not.toContain('priority')
})

test('a row with nothing set has no × to press', () => {
  fields('status: todo\npriority: high\n')
  expect(screen.queryByRole('button', { name: 'remove field due' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'remove field priority' })).toBeInTheDocument()
})

test("a field's title puts the caret in a text field", async () => {
  fields('tags: [ops]\nsource: email\n', 'notes/meeting.md')
  await userEvent.setup().click(screen.getByText('source'))
  expect(screen.getByRole('textbox', { name: 'source' })).toHaveFocus()
})

test("a field's title opens a select", async () => {
  fields('status: todo\n')
  const user = userEvent.setup()
  // Twice: once the trigger has seen a mouse, Radix no longer opens on a click,
  // which is all a label gives it.
  await user.click(screen.getByRole('combobox', { name: 'status' }))
  await user.keyboard('{Escape}')
  // The list shrinks back into its trigger before it is gone.
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
  await user.click(screen.getByText('status'))
  expect(screen.getByRole('listbox')).toBeInTheDocument()
})

test("a field's title opens a date picker", async () => {
  fields('status: todo\n')
  await userEvent.setup().click(screen.getByText('reminder'))
  expect(screen.getByRole('dialog')).toBeInTheDocument()
})

test("a field's title puts the caret in the tags", async () => {
  fields('status: todo\n')
  await userEvent.setup().click(screen.getByText('tags'))
  expect(screen.getByRole('combobox', { name: 'add to tags' })).toHaveFocus()
})

test('a comma commits a tag, as Enter does', async () => {
  const onWrite = fields('status: todo\ntags: [home]\n')
  const user = userEvent.setup()
  await user.click(screen.getByRole('combobox', { name: 'add to tags' }))
  await user.keyboard('errand,')
  expect(onWrite).toHaveBeenLastCalledWith(expect.stringMatching(/home[\s\S]*errand/))
})

test('an empty list has no ×: there is nothing in it to remove', () => {
  fields('tags: []\n', 'notes/meeting.md')
  expect(screen.queryByRole('button', { name: 'remove field tags' })).not.toBeInTheDocument()
})
