import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { mentionCompletions, type MentionData } from './mentions'

function ctx(doc: string) {
  const state = EditorState.create({ doc })
  return new CompletionContext(state, doc.length, false)
}

const data: MentionData = {
  notes: [{ path: 'notes/a.md' }],
  tasks: [{ path: 'projects/task.fix-login.md', title: 'Fix login', status: 'doing' }],
}

describe('mentionCompletions', () => {
  it('completes a task as a path link carrying its status', () => {
    const result = mentionCompletions(ctx('@fix'), data)
    const opt = result?.options.find((o) => o.label === 'Fix login')
    expect(opt?.apply).toBe('[[projects/task.fix-login.md]]')
    expect(opt?.detail).toBe('doing')
  })

  it('completes a note as a path link', () => {
    const result = mentionCompletions(ctx('@a.md'), data)
    expect(result?.options.find((o) => o.label === 'notes/a.md')?.apply).toBe('[[notes/a.md]]')
  })

  it('does not hijack an email address', () => {
    expect(mentionCompletions(ctx('mail me at bob@ex'), data)).toBeNull()
  })
})
