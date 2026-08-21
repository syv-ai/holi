import { describe, expect, it } from 'vitest'
import {
  TaskFileError,
  isTaskFilePath,
  parseTaskFile,
  parseTaskPatch,
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

  it('keeps unknown keys aside rather than forgetting them', () => {
    const parsed = parse('---\ntitle: Legacy\nid: abc\narea: projects/q2\n---\n')
    expect(parsed.extra).toEqual({ id: 'abc', area: 'projects/q2' })
  })

  it('has no `extra` at all when every key was understood', () => {
    // Absent, not `{}` — an empty map would serialize a task differently from
    // one that never had unknown keys, and byte-stability is the whole point.
    expect(parse('---\ntitle: Plain\n---\n')).not.toHaveProperty('extra')
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

  it('writes unknown keys back, so an edit never eats them', () => {
    // Dragging a card rewrites the whole file. Anything a human, another tool, or
    // a pre-D60 vault put in the frontmatter must survive that rewrite — the
    // alternative is silent data loss on the first status change.
    const text = serializeTaskFile({ ...task, extra: { id: 'abc', area: 'projects/q2' } })
    expect(parse(text, task.path).extra).toEqual({ id: 'abc', area: 'projects/q2' })
  })

  it('keeps the known keys first, so an unknown one cannot reorder the file', () => {
    const text = serializeTaskFile({ ...task, extra: { zzz: 1 } })
    expect(text).toBe('---\ntitle: Review\nstatus: todo\nzzz: 1\n---\n')
  })

  it('is byte-stable for an unchanged task', () => {
    // The editor's watcher compares on text to tell its own save from a foreign
    // write; an unstable serializer would make every rewrite look foreign.
    expect(serializeTaskFile(task)).toBe(serializeTaskFile({ ...task }))
  })
})

describe('parseTaskPatch', () => {
  it('reads the fields a detail-view edit can send', () => {
    expect(
      parseTaskPatch({
        title: 'Renamed',
        status: 'doing',
        due: '2026-08-01',
        priority: 'low',
        tags: ['ops'],
        reminder: '2d',
        recurrence: { frequency: 'daily', interval: 3 },
        description: 'New body.',
      }),
    ).toEqual({
      title: 'Renamed',
      status: 'doing',
      due: '2026-08-01',
      priority: 'low',
      tags: ['ops'],
      reminder: '2d',
      recurrence: { frequency: 'daily', interval: 3 },
      description: 'New body.',
    })
  })

  it('leaves an omitted key out entirely — a patch touches only what it names', () => {
    expect(Object.keys(parseTaskPatch({ status: 'done' }))).toEqual(['status'])
  })

  it('clears an optional field with null', () => {
    // The detail view needs a way to say "no due date" that is distinguishable
    // from "I did not touch the due date".
    const patch = parseTaskPatch({ due: null })
    expect('due' in patch).toBe(true)
    expect(patch.due).toBeUndefined()
  })

  it('refuses to clear a field that has no empty state', () => {
    expect(() => parseTaskPatch({ status: null })).toThrow(/status cannot be cleared/)
    expect(() => parseTaskPatch({ title: null })).toThrow(/title cannot be cleared/)
  })

  it('rejects a value outside the vocabulary, exactly as the parser does', () => {
    expect(() => parseTaskPatch({ status: 'blocked' })).toThrow(/status must be one of/)
    expect(() => parseTaskPatch({ priority: 'urgent' })).toThrow(/priority must be one of/)
    expect(() => parseTaskPatch({ due: 'Friday' })).toThrow(/due must be YYYY-MM-DD/)
    expect(() => parseTaskPatch({ tags: 'finance' })).toThrow(/tags must be a list/)
    expect(() => parseTaskPatch({ recurrence: { frequency: 'fortnightly' } })).toThrow(
      /recurrence.frequency must be one of/,
    )
  })

  it('rejects a key it does not know, rather than dropping the edit on the floor', () => {
    // Unlike the file parser, which must stay forgiving of foreign keys: this
    // input comes from our own UI, so an unrecognised key is a typo, and
    // ignoring it would look like the edit simply did not take.
    expect(() => parseTaskPatch({ area: 'projects/q2' })).toThrow(/unknown field: area/)
  })
})

describe('taskFileName', () => {
  it('is the filename half of taskFilePath', () => {
    expect(taskFileName('Fix login')).toBe('task.fix-login.md')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// D79: `due` is a stamp — the time is optional on it.
describe('a due date that names an hour', () => {
  it('parses and round-trips a timed due unchanged', () => {
    const task = parse('---\ndue: 2026-08-25T14:00\n---\nbody\n')
    expect(task.due).toBe('2026-08-25T14:00')
    expect(serializeTaskFile(task)).toContain('due: 2026-08-25T14:00')
  })

  it('leaves a timeless due timeless through the same round trip', () => {
    const task = parse('---\ndue: 2026-08-25\n---\nbody\n')
    expect(task.due).toBe('2026-08-25')
    expect(serializeTaskFile(task)).toContain('due: 2026-08-25')
    expect(serializeTaskFile(task)).not.toContain('T00:00')
  })

  it('still rejects a due that is neither shape, naming both in the error', () => {
    expect(() => parse('---\ndue: 20th July\n---\n')).toThrow(/YYYY-MM-DD/)
    expect(() => parse('---\ndue: 20th July\n---\n')).toThrow(/YYYY-MM-DDTHH:MM/)
    // The old reminder grammar is not a date, wherever it turns up.
    expect(() => parse('---\ndue: 1d\n---\n')).toThrow(/due must be/)
    expect(() => parse('---\ndue: 2026-02-30\n---\n')).toThrow(/due must be/)
  })

  it('accepts a timed due through parseTaskPatch, and still clears with null', () => {
    expect(parseTaskPatch({ due: '2026-08-25T14:00' }).due).toBe('2026-08-25T14:00')
    const cleared = parseTaskPatch({ due: null })
    expect('due' in cleared).toBe(true)
    expect(cleared.due).toBeUndefined()
  })

  // The reminder reader stays lenient, and that is load-bearing rather than an
  // oversight: PATCH_READERS is shared with the file parser on purpose, so a
  // strict reader would make a legacy `reminder: 1d` in a hand-written file
  // break the whole task into the broken strip. An unparseable reminder is
  // inert — it costs a notification, not a task.
  it('carries a legacy relative reminder through verbatim, without throwing', () => {
    expect(parse('---\nreminder: 1d\n---\n').reminder).toBe('1d')
    expect(parseTaskPatch({ reminder: '1d' }).reminder).toBe('1d')
  })
})

describe('order', () => {
  it('reads a rank off the file and writes it back unchanged', () => {
    // The board's manual ordering (`prd/tasks.md` §Board UX). A rank is the one
    // key in a task file that means nothing to a human, so it earns its place
    // by round-tripping exactly — a rewrite that rounded it would reshuffle a
    // column nobody touched.
    const task = parseTaskFile('---\ntitle: T\nstatus: todo\norder: 1.5\n---\n', 'task.t.md')
    expect(task.order).toBe(1.5)
    expect(serializeTaskFile(task)).toContain('order: 1.5')
  })

  it('treats a rank that is not a number as no rank at all', () => {
    // Same rule `reminder` follows, for the same reason: these readers are
    // shared with the patch path, so a strict one would take a hand-written
    // `order: first` and break the whole task into the broken strip over a
    // sort key. An absent rank sorts last; that is a fine answer for junk.
    const task = parseTaskFile('---\ntitle: T\nstatus: todo\norder: first\n---\n', 'task.t.md')
    expect(task.order).toBeUndefined()
  })
})
