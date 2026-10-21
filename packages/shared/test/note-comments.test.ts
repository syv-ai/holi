import { describe, expect, it } from 'vitest'
import {
  anchorAt,
  commentThreads,
  commentsPathFor,
  emptyCommentsFile,
  formatCommentsFile,
  formatNoteComments,
  locateAnchor,
  mentionedLogins,
  mergeCommentsText,
  newMentions,
  notePathOfComments,
  parseCommentsFile,
  withReply,
  withStatus,
  withThread,
  type CommentsFile,
  type NoteComment,
} from '../src/note-comments'

const comment = (id: string, body: string, author = 'ada', at = '2026-10-21T10:00:00.000Z') =>
  ({ id, author, at, body }) satisfies NoteComment

const at = (doc: string, quote: string, nth = 0) => {
  let from = -1
  for (let i = 0; i <= nth; i++) from = doc.indexOf(quote, from + 1)
  return anchorAt(doc, from, from + quote.length)
}

const slice = (doc: string, r: { from: number; to: number } | null) =>
  r === null ? null : doc.slice(r.from, r.to)

describe('sidecar paths', () => {
  it('maps a note to its sidecar and back', () => {
    expect(commentsPathFor('notes/plan.md')).toBe('.holi/comments/notes/plan.md.json')
    expect(notePathOfComments('.holi/comments/notes/plan.md.json')).toBe('notes/plan.md')
    expect(notePathOfComments('.holi/comments/.json')).toBeNull()
    expect(notePathOfComments('notes/plan.md.json')).toBeNull()
    expect(notePathOfComments('.holi/comments/a.md')).toBeNull()
  })
})

describe('locateAnchor', () => {
  const doc = 'Intro line.\n\nThe budget is fixed at 40k for the year.\n\nOutro.\n'

  it('finds the passage where it moved to', () => {
    const anchor = at(doc, 'fixed at 40k')
    const moved = `A new first paragraph.\n\n${doc}`
    expect(slice(moved, locateAnchor(moved, anchor))).toBe('fixed at 40k')
  })

  it('tells repeated passages apart by their context, then by line', () => {
    const twice = 'alpha beta gamma\nsomething else\nalpha beta gamma\n'
    const second = at(twice, 'beta', 1)
    expect(locateAnchor(twice, second)).toEqual({ from: 38, to: 42 })
    const repeated = 'x\nsame\nx\nsame\n'
    const anchor = { ...at(repeated, 'same', 1), prefix: '', suffix: '' }
    expect(locateAnchor(repeated, anchor)?.from).toBe(9)
  })

  it('follows a passage edited in place by the text around it', () => {
    const anchor = at(doc, 'fixed at 40k')
    const edited = doc.replace('fixed at 40k', 'capped at 45k')
    expect(slice(edited, locateAnchor(edited, anchor))).toBe('capped at 45k')
  })

  it('follows a passage edited in the middle by its own ends', () => {
    const long = 'Start. The quarterly review moves to the second week of March. End.'
    const anchor = {
      ...at(long, 'The quarterly review moves to the second week of March.'),
      prefix: '',
      suffix: '',
    }
    const edited = long.replace('moves to', 'is moved to')
    expect(slice(edited, locateAnchor(edited, anchor))).toBe(
      'The quarterly review is moved to the second week of March.',
    )
  })

  it('detaches a passage that is gone', () => {
    const anchor = at(doc, 'fixed at 40k')
    expect(locateAnchor('Something else entirely.\n', anchor)).toBeNull()
  })
})

describe('threads', () => {
  it('round-trips through the file, in reading order, oldest comment first', () => {
    const doc = 'one\ntwo\nthree\n'
    let file = withThread(emptyCommentsFile(), 't2', at(doc, 'three'), comment('c1', 'Later line'))
    file = withThread(file, 't1', at(doc, 'one'), comment('c2', 'First line'))
    file = withReply(file, 't1', comment('c4', 'second', 'bob', '2026-10-21T12:00:00.000Z'))!
    file = withReply(file, 't1', comment('c3', 'first', 'bob', '2026-10-21T11:00:00.000Z'))!
    file = withStatus(file, 't1', { resolved: true, by: 'bob', at: '2026-10-21T13:00:00.000Z' })!

    const back = parseCommentsFile(formatCommentsFile(file))!
    const threads = commentThreads(back)
    expect(threads.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(threads[0]!.comments.map((c) => c.id)).toEqual(['c2', 'c3', 'c4'])
    expect(threads[0]!.status?.resolved).toBe(true)
    expect(withReply(file, 'nope', comment('x', 'y'))).toBeNull()
  })

  it('leaves out what it cannot read rather than failing the file', () => {
    const text = JSON.stringify({
      threads: {
        good: { anchor: { quote: 'q' }, comments: { c: { author: 'a', at: 't', body: 'b' } } },
        noQuote: { anchor: {}, comments: { c: { author: 'a', at: 't', body: 'b' } } },
        noComments: { anchor: { quote: 'q' }, comments: { c: { author: 'a' } } },
      },
    })
    expect(Object.keys(parseCommentsFile(text)!.threads)).toEqual(['good'])
    expect(parseCommentsFile('[1]')).toBeNull()
  })
})

describe('mergeCommentsText', () => {
  const doc = 'one\ntwo\n'
  const base: CommentsFile = withThread(
    emptyCommentsFile(),
    't',
    at(doc, 'one'),
    comment('a', 'hi'),
  )
  const f = formatCommentsFile

  it('keeps comments added on both sides', () => {
    const ours = withReply(base, 't', comment('b', 'mine'))!
    const theirs = withThread(
      withReply(base, 't', comment('c', 'yours'))!,
      'u',
      at(doc, 'two'),
      comment('d', 'new thread'),
    )
    const out = mergeCommentsText(f(base), f(ours), f(theirs))
    expect(out.ok).toBe(true)
    const threads = commentThreads(parseCommentsFile(out.ok ? out.text : '')!)
    expect(threads.map((t) => t.id)).toEqual(['t', 'u'])
    expect(threads[0]!.comments.map((c) => c.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('keeps the later of a resolve and a reopen', () => {
    const ours = withStatus(base, 't', { resolved: true, by: 'ada', at: '2026-10-21T10:00:00Z' })!
    const theirs = withStatus(base, 't', {
      resolved: false,
      by: 'bob',
      at: '2026-10-21T11:00:00Z',
    })!
    const out = mergeCommentsText(f(base), f(ours), f(theirs))
    expect(out.ok && parseCommentsFile(out.text)!.threads.t!.status?.by).toBe('bob')
  })

  it('merges two files both sides created', () => {
    const theirs = withThread(emptyCommentsFile(), 'u', at(doc, 'two'), comment('d', 'x'))
    const out = mergeCommentsText(null, f(base), f(theirs))
    expect(out.ok && Object.keys(parseCommentsFile(out.text)!.threads).sort()).toEqual(['t', 'u'])
  })

  it('refuses what is not a comments file', () => {
    expect(mergeCommentsText(null, 'nope', f(base)).ok).toBe(false)
  })
})

describe('mentions', () => {
  it('reads logins, not email addresses', () => {
    expect(mentionedLogins('@Ada-H and @bob, not ada@syv.ai or a/@x')).toEqual(['ada-h', 'bob'])
  })

  it('finds new comments that mention me, written by someone else', () => {
    const doc = 'one\n'
    const before = withThread(emptyCommentsFile(), 't', at(doc, 'one'), comment('a', '@ada old'))
    let after = withReply(before, 't', comment('b', 'over to @Ada', 'bob'))!
    after = withReply(after, 't', comment('c', 'note to self @ada', 'ada'))!
    after = withReply(after, 't', comment('d', 'for @carl', 'bob'))!
    const found = newMentions(before, after, 'ada')
    expect(found.map((m) => m.comment.id)).toEqual(['b'])
    expect(found[0]!.quote).toBe('one')
    expect(newMentions(null, after, 'ada').map((m) => m.comment.id)).toEqual(['b'])
  })
})

describe('formatNoteComments', () => {
  it('prints threads with where they are, replies and status', () => {
    const doc = 'one\n'
    let file = withThread(emptyCommentsFile(), 't1', at(doc, 'one'), comment('a', 'Check this'))
    file = withReply(file, 't1', {
      ...comment('b', 'Done', 'ada', '2026-10-21T11:00:00Z'),
      agent: true,
    })!
    file = withStatus(file, 't1', { resolved: true, by: 'ada', at: '2026-10-21T12:00:00Z' })!
    const [thread] = commentThreads(file)
    expect(formatNoteComments('a.md', [{ ...thread!, line: null }], { timeZone: 'UTC' })).toBe(
      [
        '[From a.md, 0 open, 1 resolved]',
        '',
        'Thread t1 on "one" (detached, the passage is gone)',
        '  ada, 2026-10-21 10:00',
        '  > Check this',
        "  Reply, ada's agent, 2026-10-21 11:00",
        '  > Done',
        '  Resolved by ada, 2026-10-21 12:00',
      ].join('\n'),
    )
    expect(formatNoteComments('a.md', [])).toBe('No comments on a.md.')
  })
})
