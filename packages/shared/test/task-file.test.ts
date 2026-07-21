import { describe, expect, it } from 'vitest'
import {
  TaskFileError,
  isTaskFilePath,
  parseTaskFile,
  serializeTaskFile,
  taskFileName,
  taskFilePath,
  taskSlug,
  titleFromTaskPath,
} from '../src/task-file'

const parse = (text: string, path = 'task.a.md') => parseTaskFile(text, path)

describe('taskSlug', () => {
  it('lowercases and dash-separates', () => {
    expect(taskSlug('Review the Q2 doc')).toBe('review-the-q2-doc')
  })

  it('never yields an empty or edge-dashed slug', () => {
    expect(taskSlug('!!!')).toBe('task')
    expect(taskSlug('  hi  ')).toBe('hi')
  })

  it('cannot produce a name that would nest or escape', () => {
    // The slug becomes a filename; a surviving '/' would silently relocate the
    // task, and '..' would leave the vault.
    expect(taskSlug('a/../../etc/passwd')).toBe('a-etc-passwd')
    expect(taskSlug('notes/2026')).toBe('notes-2026')
  })
})

describe('taskFilePath', () => {
  it('is `task.<slug>.md` inside the folder the task belongs to', () => {
    expect(taskFilePath('projects/q2', 'Fix login')).toBe('projects/q2/task.fix-login.md')
  })

  it('drops the folder segment at the vault root', () => {
    expect(taskFilePath('', 'Fix login')).toBe('task.fix-login.md')
  })
})

describe('isTaskFilePath', () => {
  it('matches the `task.` prefix in any folder', () => {
    expect(isTaskFilePath('task.a.md')).toBe(true)
    expect(isTaskFilePath('projects/q2/task.fix-login.md')).toBe(true)
  })

  it('does not match a note that merely mentions tasks', () => {
    expect(isTaskFilePath('projects/tasks.md')).toBe(false)
    expect(isTaskFilePath('tasks/a.md')).toBe(false)
    expect(isTaskFilePath('projects/task-list.md')).toBe(false)
    expect(isTaskFilePath('projects/my.task.md')).toBe(false)
  })

  it('is markdown-only', () => {
    expect(isTaskFilePath('task.a.txt')).toBe(false)
  })
})

describe('titleFromTaskPath', () => {
  it('reads a title back out of the filename', () => {
    expect(titleFromTaskPath('projects/q2/task.fix-login.md')).toBe('Fix login')
  })

  it('is what makes a frontmatter-less file usable', () => {
    expect(titleFromTaskPath('task.call-the-vendor.md')).toBe('Call the vendor')
  })
})

describe('parseTaskFile', () => {
  it('reads every field', () => {
    const parsed = parse(
      [
        '---',
        'title: Review the Q2 doc',
        'status: doing',
        'due: 2026-07-20',
        'priority: high',
        'tags: [finance, q2]',
        'reminder: 1d',
        'recurrence: { frequency: weekly, interval: 2, weekdays: [mon, wed] }',
        '---',
        '',
        'Body text with [[a.md]].',
        '',
      ].join('\n'),
      'projects/q2/task.review-the-q2-doc.md',
    )
    expect(parsed).toEqual({
      path: 'projects/q2/task.review-the-q2-doc.md',
      title: 'Review the Q2 doc',
      status: 'doing',
      due: '2026-07-20',
      priority: 'high',
      tags: ['finance', 'q2'],
      reminder: '1d',
      recurrence: { frequency: 'weekly', interval: 2, weekdays: ['mon', 'wed'] },
      description: 'Body text with [[a.md]].',
    })
  })

  it('falls back to the filename when there is no title', () => {
    const parsed = parse('---\nstatus: todo\n---\n', 'projects/task.fix-login.md')
    expect(parsed.title).toBe('Fix login')
  })

  it('defaults status to todo and tags to empty', () => {
    const parsed = parse('---\ntitle: Bare\n---\n')
    expect(parsed.status).toBe('todo')
    expect(parsed.tags).toEqual([])
    expect(parsed.description).toBe('')
  })

  it('accepts a file with no frontmatter at all — the whole file is the body', () => {
    // The agent can create a task with one Write and no ceremony. Requiring
    // frontmatter would make the cheapest path the broken one.
    const parsed = parse('Just some text.\n', 'task.just-some-text.md')
    expect(parsed.title).toBe('Just some text')
    expect(parsed.status).toBe('todo')
    expect(parsed.description).toBe('Just some text.')
  })

  it('rejects malformed YAML rather than half-applying it', () => {
    expect(() => parse('---\ntitle: "unterminated\n---\n')).toThrow(TaskFileError)
  })

  it('rejects an out-of-vocabulary status or priority', () => {
    expect(() => parse('---\nstatus: blocked\n---\n')).toThrow(/status must be one of/)
    expect(() => parse('---\npriority: urgent\n---\n')).toThrow(/priority must be one of/)
  })

  it('rejects a due date that is not YYYY-MM-DD', () => {
    expect(() => parse('---\ndue: 20th July\n---\n')).toThrow(/due must be YYYY-MM-DD/)
  })

  it('accepts an unparseable reminder — an inert reminder is not an error', () => {
    expect(parse('---\nreminder: whenever\n---\n').reminder).toBe('whenever')
  })

  it('ignores keys the record no longer has, rather than rejecting the file', () => {
    // Files written before D60 carry id/version/area/related, and so will any
    // vault migrated from the old app. They must stay readable: the alternative
    // is a vault whose every task fails to parse.
    const parsed = parse(
      [
        '---',
        'id: 3f2504e0-4f89-11d3-9a0c-0305e82c3301',
        'version: 7',
        'title: Legacy',
        'area: projects/q2',
        'related:',
        '  - { kind: note, path: a.md }',
        '---',
      ].join('\n'),
    )
    expect(parsed.title).toBe('Legacy')
    expect(parsed).not.toHaveProperty('id')
    expect(parsed).not.toHaveProperty('area')
  })
})

describe('serializeTaskFile', () => {
  const task = {
    path: 'projects/q2/task.review.md',
    title: 'Review',
    status: 'todo' as const,
    tags: [] as string[],
    description: '',
  }

  it('round-trips through parse unchanged', () => {
    const full = {
      ...task,
      due: '2026-07-20',
      priority: 'high' as const,
      tags: ['finance'],
      reminder: '1d',
      recurrence: { frequency: 'weekly' as const, interval: 1, weekdays: ['mon' as const] },
      description: 'Some body.',
    }
    expect(parse(serializeTaskFile(full), full.path)).toEqual(full)
  })

  it('omits absent fields instead of writing nulls', () => {
    expect(serializeTaskFile(task)).toBe('---\ntitle: Review\nstatus: todo\n---\n')
  })

  it('writes no id and no version — nothing in the file is machine-owned', () => {
    const text = serializeTaskFile({ ...task, description: 'x' })
    expect(text).not.toMatch(/\bid:/)
    expect(text).not.toMatch(/\bversion:/)
  })

  it('is byte-stable for an unchanged task', () => {
    // The editor's watcher compares on text to tell its own save from a foreign
    // write; an unstable serializer would make every rewrite look foreign.
    expect(serializeTaskFile(task)).toBe(serializeTaskFile({ ...task }))
  })
})

describe('taskFileName', () => {
  it('is the filename half of taskFilePath', () => {
    expect(taskFileName('Fix login')).toBe('task.fix-login.md')
  })
})
