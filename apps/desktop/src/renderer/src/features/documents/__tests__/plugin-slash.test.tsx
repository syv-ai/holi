/**
 * A vault app's slash command in the document editor: given the caret's
 * line without the typed "/query" and the note's path, its answer written
 * at the caret as markdown, an agent answer opening the prompt, and a
 * failure leaving the note as it was.
 */
import { Editor } from '@tiptap/react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { bindEditorActivity, useDocumentActivity } from '@/hooks/use-editor-activity'
import type { EditorActivity } from '@/hooks/use-editor-activity'
import type { SlashCommand } from '@/plugin-api/types'
import { createDocumentExtensions } from '../document-extensions'
import { pluginSlashItem } from '../plugin-slash'

let editor: Editor | null = null
let activityHook: ReturnType<typeof renderHook<EditorActivity, void>> | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
  activityHook?.unmount()
  activityHook = null
  ask.mockClear()
})

/** "Total: /sum" with the caret after it, and the range "/sum" covers. */
function open(): { ed: Editor; range: { from: number; to: number } } {
  const ed = new Editor({
    extensions: createDocumentExtensions({
      folder: '',
      placeholder: '',
      onOpenLink: () => undefined,
    }),
    content: 'Total: /sum\n',
    contentType: 'markdown',
  })
  editor = ed
  activityHook = renderHook(() => useDocumentActivity(true, true))
  bindEditorActivity(ed, activityHook.result.current)
  let from = -1
  ed.state.doc.descendants((node, pos) => {
    if (from === -1 && node.isText && node.text!.includes('/sum')) {
      from = pos + node.text!.indexOf('/sum')
    }
  })
  return { ed, range: { from, to: from + 4 } }
}

function command(answer: Awaited<ReturnType<SlashCommand['run']>>) {
  const run = vi.fn(async () => answer)
  const item = pluginSlashItem({ name: 'sum', meta: 'Budget', run }, 'Notes/Plan.md', ask)
  return { run, item }
}
const ask = vi.fn()

test('is listed under its app, and writes its answer at the caret', async () => {
  const { ed, range } = open()
  const { run, item } = command({ insert: '**42**' })
  expect(item.group).toBe('Budget')
  expect(item.title).toBe('sum')
  item.run(ed, range)
  expect(run).toHaveBeenCalledWith({
    text: '',
    line: 'Total: ',
    path: 'Notes/Plan.md',
  })
  await vi.waitFor(() => expect(ed.getMarkdown()).toContain('Total: **42**'))
  expect(ed.getMarkdown()).not.toContain('/sum')
})

test('an agent answer opens the prompt with its instruction during its focus visit', async () => {
  const { ed, range } = open()
  const { item } = command({ agent: 'Sum the table above' })
  item.run(ed, range)
  await vi.waitFor(() => expect(ask).toHaveBeenCalledWith(range.from, 'Sum the table above'))
})

test('a delayed agent answer does not open a prompt after leaving and returning', async () => {
  const { ed, range } = open()
  let respond!: (result: { agent: string }) => void
  const run = vi.fn(() => new Promise<{ agent: string }>((resolve) => (respond = resolve)))
  const item = pluginSlashItem({ name: 'sum', run }, 'Notes/Plan.md', ask)
  item.run(ed, range)
  const activity = activityHook!.result.current
  act(() => activity.update(false, false))
  act(() => activity.update(true, true))
  await act(async () => respond({ agent: 'Sum the table above' }))
  expect(ask).not.toHaveBeenCalled()
})

test.each([
  { kind: 'insert', response: { insert: '**42**' } },
  { kind: 'replace', response: { replace: '**42**' } },
])(
  'a delayed $kind answer inserts in the background without focusing the editor',
  async ({ response }) => {
    const { ed, range } = open()
    let respond!: (result: { insert: string } | { replace: string }) => void
    const run = vi.fn(
      () => new Promise<{ insert: string } | { replace: string }>((resolve) => (respond = resolve)),
    )
    const item = pluginSlashItem({ name: 'sum', run }, 'Notes/Plan.md', ask)
    item.run(ed, range)
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
    const focus = vi.spyOn(ed.view, 'focus')
    const activity = activityHook!.result.current
    act(() => activity.update(false, false))
    act(() => activity.update(true, false))
    await act(async () => respond(response))
    await vi.waitFor(() => expect(ed.getMarkdown()).toContain('Total: **42**'))
    expect(focus).not.toHaveBeenCalled()
  },
)

test('a delayed agent answer does not open a prompt while its split is displayed but unfocused', async () => {
  const { ed, range } = open()
  let respond!: (result: { agent: string }) => void
  const run = vi.fn(() => new Promise<{ agent: string }>((resolve) => (respond = resolve)))
  const item = pluginSlashItem({ name: 'sum', run }, 'Notes/Plan.md', ask)
  item.run(ed, range)
  act(() => activityHook!.result.current.update(true, false))
  await act(async () => respond({ agent: 'Sum the table above' }))
  expect(ask).not.toHaveBeenCalled()
})

test('a delayed result is ignored after the editor is destroyed', async () => {
  const { ed, range } = open()
  let respond!: (result: { insert: string }) => void
  const run = vi.fn(() => new Promise<{ insert: string }>((resolve) => (respond = resolve)))
  const item = pluginSlashItem({ name: 'sum', run }, 'Notes/Plan.md', ask)
  item.run(ed, range)
  ed.destroy()
  expect(() => respond({ insert: '**42**' })).not.toThrow()
  await Promise.resolve()
  expect(ask).not.toHaveBeenCalled()
})

test('a command that fails leaves the note without the typed command', async () => {
  const { ed, range } = open()
  const run = vi.fn(async () => {
    throw new Error('took longer than 10 s')
  })
  const item = pluginSlashItem({ name: 'sum', run }, 'Notes/Plan.md', ask)
  item.run(ed, range)
  await vi.waitFor(() => expect(run).toHaveBeenCalled())
  expect(ed.getMarkdown().trim()).toBe('Total:')
})
