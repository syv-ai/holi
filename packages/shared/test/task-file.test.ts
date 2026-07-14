import { describe, expect, it } from 'vitest'
import {
  TaskFileError,
  areaFromFile,
  isTaskFilePath,
  parseTaskFile,
  relatedFromFile,
  serializeTaskFile,
  taskIdFromPath,
  taskFilePath,
  taskSlug,
  type TaskFileResolvers,
  type TaskFileSource,
} from '../src/task-file'

const ID = 'a1b2c3d4-1111-4222-8333-444455556666'
const NOTE_ID = 'bbbbcccc-2222-4333-8444-555566667777'
const AREA_ID = 'cccddddd-3333-4444-8555-666677778888'

const full: TaskFileSource = {
  id: ID,
  title: 'Review the Q2 doc',
  status: 'todo',
  area: AREA_ID,
  due: '2026-07-20',
  priority: 'high',
  tags: ['finance', 'q2'],
  reminder: '1d',
  recurrence: { frequency: 'weekly', interval: 1, weekdays: ['mon', 'wed'] },
  related: [{ kind: 'note', id: NOTE_ID }],
  description: 'First paragraph.\n\nSecond paragraph with a [[wiki-link]].',
}

const notePathFor = (docId: string) =>
  docId === NOTE_ID ? 'meetings/2026-07-13.md' : undefined
const folderPathFor = (folderId: string) => (folderId === AREA_ID ? 'projects/q2' : undefined)

const resolvers: TaskFileResolvers = { notePathFor, folderPathFor }
const noResolvers: TaskFileResolvers = {
  notePathFor: () => undefined,
  folderPathFor: () => undefined,
}

describe('serializeTaskFile / parseTaskFile', () => {
  it('round-trips every field', () => {
    const parsed = parseTaskFile(serializeTaskFile(full, resolvers))

    expect(parsed.id).toBe(ID)
    expect(parsed.description).toBe(full.description)
    expect(parsed.fields).toEqual({
      title: 'Review the Q2 doc',
      status: 'todo',
      // the folder renders as a path too — the agent has no way to discover a
      // folder id, so a uuid here would make `area` unsettable from the file
      area: 'projects/q2',
      due: '2026-07-20',
      priority: 'high',
      tags: ['finance', 'q2'],
      reminder: '1d',
      recurrence: { frequency: 'weekly', interval: 1, weekdays: ['mon', 'wed'] },
      // notes render as paths in the file — the docId lives only in the record
      related: [{ kind: 'note', path: 'meetings/2026-07-13.md' }],
    })
  })

  it('round-trips a minimal task, omitting absent fields rather than emitting nulls', () => {
    const min: TaskFileSource = { id: ID, title: 'Call the vendor', status: 'todo' }
    const text = serializeTaskFile(min, resolvers)

    expect(text).not.toMatch(/null/)
    expect(text).not.toMatch(/^(due|area|priority|reminder|recurrence|tags|related):/m)

    const parsed = parseTaskFile(text)
    expect(parsed.fields).toEqual({ title: 'Call the vendor', status: 'todo' })
    expect(parsed.description).toBe('')
  })

  it('absent keys stay absent — presence is what the inbound per-field diff reads', () => {
    const parsed = parseTaskFile(`---\nid: ${ID}\ntitle: T\n---\n`)
    expect('due' in parsed.fields).toBe(false)
    expect('status' in parsed.fields).toBe(false)
  })

  /** D33 — the concurrency token is NOT in the file.
   *
   * It bumps on every mutation, so with it in the frontmatter a reminder firing
   * rewrites the task file to change one integer — and once the git mirror is on,
   * the bot *commits* that. It is also a machine token the agent must never touch.
   * The desktop carries it out-of-band in the ProjectionStore; git ingest diffs
   * against the commit's own base blob and needs no token at all. */
  it('never serializes `version` — the token is carried out-of-band', () => {
    const text = serializeTaskFile({ ...full, version: 7 } as TaskFileSource, resolvers)
    expect(text).not.toMatch(/^version:/m)
    expect(parseTaskFile(text).version).toBeUndefined()
  })

  it('still *parses* a version — files written before D33 must not become unparseable', () => {
    const parsed = parseTaskFile(`---\nid: ${ID}\ntitle: T\nversion: 7\n---\n`)
    expect(parsed.version).toBe(7)
    expect(parsed.fields.title).toBe('T')
  })

  it('the body is the description, verbatim, multi-paragraph', () => {
    const body = 'Line one.\n\n- a bullet\n- another\n\nClosing line.'
    const parsed = parseTaskFile(serializeTaskFile({ ...full, description: body }, resolvers))
    expect(parsed.description).toBe(body)
  })

  it('survives a title with a colon, a hash and unicode', () => {
    const title = 'Ship: the #1 thing — æøå 🚀'
    const parsed = parseTaskFile(serializeTaskFile({ ...full, title }, resolvers))
    expect(parsed.fields.title).toBe(title)
  })

  it('a note whose doc is gone round-trips as an id tombstone, never dropped', () => {
    // Dropping the ref would silently delete the link on the next inbound write.
    const text = serializeTaskFile(full, noResolvers)
    const parsed = parseTaskFile(text)
    expect(parsed.fields.related).toEqual([{ kind: 'note', id: NOTE_ID }])
  })

  it('non-note refs keep their ids', () => {
    const src: TaskFileSource = { ...full, related: [{ kind: 'task', id: ID }] }
    const parsed = parseTaskFile(serializeTaskFile(src, resolvers))
    expect(parsed.fields.related).toEqual([{ kind: 'task', id: ID }])
  })

  it('an id-less file is a create, not an error', () => {
    const parsed = parseTaskFile(`---\ntitle: Written by the agent\n---\n\nBody.`)
    expect(parsed.id).toBeUndefined()
    expect(parsed.fields.title).toBe('Written by the agent')
    expect(parsed.description).toBe('Body.')
  })
})

describe('parseTaskFile — writes that lose', () => {
  // Each of these must throw, never partially apply. The model *will* produce them.
  const bad: Array<[string, string]> = [
    ['no frontmatter fence', 'Just a body, no fence.\n'],
    ['unterminated fence', `---\nid: ${ID}\ntitle: T\n`],
    ['frontmatter is not a map', '---\n- a\n- b\n---\n'],
    ['frontmatter is empty', '---\n---\n'],
    ['garbage yaml', '---\ntitle: "unterminated\n---\n'],
    ['missing title', `---\nid: ${ID}\nstatus: todo\n---\n`],
    ['empty title', `---\nid: ${ID}\ntitle: "   "\n---\n`],
    ['status outside the enum', `---\nid: ${ID}\ntitle: T\nstatus: in-progress\n---\n`],
    ['due not YYYY-MM-DD', `---\nid: ${ID}\ntitle: T\ndue: next friday\n---\n`],
    ['priority outside the enum', `---\nid: ${ID}\ntitle: T\npriority: urgent\n---\n`],
    ['id present but not a uuid', '---\nid: not-a-uuid\ntitle: T\n---\n'],
    ['version not an integer', `---\nid: ${ID}\ntitle: T\nversion: seven\n---\n`],
    ['tags not a list of strings', `---\nid: ${ID}\ntitle: T\ntags: finance\n---\n`],
    ['recurrence frequency invalid', `---\nid: ${ID}\ntitle: T\nrecurrence: { frequency: fortnightly, interval: 1 }\n---\n`],
    ['recurrence interval below 1', `---\nid: ${ID}\ntitle: T\nrecurrence: { frequency: weekly, interval: 0 }\n---\n`],
    ['recurrence weekday invalid', `---\nid: ${ID}\ntitle: T\nrecurrence: { frequency: weekly, interval: 1, weekdays: [funday] }\n---\n`],
    ['related is not a list', `---\nid: ${ID}\ntitle: T\nrelated: nope\n---\n`],
    ['related kind invalid', `---\nid: ${ID}\ntitle: T\nrelated: [{ kind: pizza, id: x }]\n---\n`],
    ['related note with neither path nor id', `---\nid: ${ID}\ntitle: T\nrelated: [{ kind: note }]\n---\n`],
  ]

  for (const [label, text] of bad) {
    it(`rejects: ${label}`, () => {
      expect(() => parseTaskFile(text)).toThrow(TaskFileError)
    })
  }
})

describe('areaFromFile — the inbound folder seam', () => {
  const folderIdForPath = (path: string) => (path === 'projects/q2' ? AREA_ID : undefined)

  it('resolves a folder path to its stable folder id', () => {
    expect(areaFromFile('projects/q2', folderIdForPath)).toBe(AREA_ID)
  })

  it('passes a raw folder id through — that is the deleted-folder tombstone', () => {
    expect(areaFromFile(AREA_ID, () => undefined)).toBe(AREA_ID)
  })

  it('rejects the write on an unknown folder path', () => {
    expect(() => areaFromFile('projects/nope', folderIdForPath)).toThrow(TaskFileError)
  })

  it('a deleted folder round-trips as an id tombstone, never dropped', () => {
    // Omitting it would silently clear the task's area on the next inbound write.
    const parsed = parseTaskFile(serializeTaskFile(full, noResolvers))
    expect(parsed.fields.area).toBe(AREA_ID)
    expect(areaFromFile(parsed.fields.area!, folderIdForPath)).toBe(AREA_ID)
  })

  it('survives the full round-trip: record -> file -> record', () => {
    const parsed = parseTaskFile(serializeTaskFile(full, resolvers))
    expect(areaFromFile(parsed.fields.area!, folderIdForPath)).toBe(AREA_ID)
  })
})

describe('relatedFromFile — the inbound path -> docId seam', () => {
  const docIdForPath = (path: string) =>
    path === 'meetings/2026-07-13.md' ? NOTE_ID : undefined

  it('resolves a note path back to its stable docId', () => {
    const refs = relatedFromFile(
      [{ kind: 'note', path: 'meetings/2026-07-13.md' }],
      docIdForPath,
    )
    expect(refs).toEqual([{ kind: 'note', id: NOTE_ID }])
  })

  it('round-trips an id tombstone without a lookup — a deleted note keeps its link', () => {
    const refs = relatedFromFile([{ kind: 'note', id: NOTE_ID }], () => undefined)
    expect(refs).toEqual([{ kind: 'note', id: NOTE_ID }])
  })

  it('passes non-note kinds through untouched', () => {
    const refs = relatedFromFile([{ kind: 'task', id: ID }], docIdForPath)
    expect(refs).toEqual([{ kind: 'task', id: ID }])
  })

  it('rejects the whole write on an unresolvable note path', () => {
    // Deliberately harsh: dropping just the bad ref would be invisible data
    // loss. Rejecting is visible and self-healing — the file is rewritten from
    // truth and the agent re-reads it.
    expect(() =>
      relatedFromFile([{ kind: 'note', path: 'ghosts/nope.md' }], docIdForPath),
    ).toThrow(TaskFileError)
  })

  it('survives the full file round-trip: record -> file -> record', () => {
    const parsed = parseTaskFile(serializeTaskFile(full, resolvers))
    expect(relatedFromFile(parsed.fields.related ?? [], docIdForPath)).toEqual(full.related)
  })
})

describe('taskSlug / taskFilePath / isTaskFilePath', () => {
  it('slugs a title', () => {
    expect(taskSlug('Review the Q2 doc')).toBe('review-the-q2-doc')
  })

  it('collapses runs, trims edges, and strips punctuation', () => {
    expect(taskSlug('  Ship: the #1 thing!!  ')).toBe('ship-the-1-thing')
  })

  it('falls back rather than producing a leading dash when a title has no alphanumerics', () => {
    // `???` must not yield `tasks/-<id>.md`
    expect(taskSlug('???')).toBe('task')
    expect(taskFilePath({ id: ID, title: '???' })).toBe(`tasks/task-${ID}.md`)
  })

  it('caps a runaway title', () => {
    const slug = taskSlug('word '.repeat(60))
    expect(slug.length).toBeLessThanOrEqual(60)
    expect(slug.endsWith('-')).toBe(false)
  })

  it('builds the canonical path', () => {
    expect(taskFilePath({ id: ID, title: 'Review the Q2 doc' })).toBe(
      `tasks/review-the-q2-doc-${ID}.md`,
    )
  })

  it('recognises task files, and only task files', () => {
    expect(isTaskFilePath(`tasks/review-${ID}.md`)).toBe(true)
    expect(isTaskFilePath('tasks/anything.md')).toBe(true)
    expect(isTaskFilePath('tasks/nested/deep.md')).toBe(true)
    expect(isTaskFilePath('notes/tasks/x.md')).toBe(false)
    expect(isTaskFilePath('tasks/notes.txt')).toBe(false)
    expect(isTaskFilePath('tasks')).toBe(false)
    expect(isTaskFilePath('tasksy/x.md')).toBe(false)
  })

  /** The filename is the identity for git ingest: a delete has no blob left to read
   * an id out of, and a rename must be recognised as the same task before either
   * blob is parsed. */
  it('reads the task id back out of the path', () => {
    expect(taskIdFromPath(taskFilePath({ id: ID, title: 'Review the Q2 doc' }))).toBe(ID)
    expect(taskIdFromPath(`tasks/${ID}.md`)).toBeUndefined() // no `-` separator
    expect(taskIdFromPath('tasks/hand-written.md')).toBeUndefined()
    expect(taskIdFromPath('tasks/x.md')).toBeUndefined()
  })

  it('a slug containing a uuid does not shadow the real suffix', () => {
    const other = 'b2c3d4e5-2222-4333-8444-555566667777'
    // a title that slugs to something uuid-shaped, followed by the *real* id
    const rel = `tasks/ticket-${other}-${ID}.md`
    expect(taskIdFromPath(rel)).toBe(ID)
  })
})
