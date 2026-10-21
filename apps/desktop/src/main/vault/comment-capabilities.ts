/**
 * Comment threads on notes for the agent (docs/features/note-comments.md):
 * `holi comments list|add|reply|resolve|reopen`. What the agent writes is
 * signed with the signed-in person's login and marked as their agent's.
 * Holi's own panel reaches the same module through the router.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import {
  anchorAt,
  formatNoteComments,
  isCommentableNote,
  isResolved,
  locateAnchor,
  type LocatedThread,
} from '@holi/shared'
import { CapabilityError } from '../capabilities/error'
import { readNote, shownPath } from '../capabilities/fences'
import { optionalStringParam, paramsObject, stringParam } from '../capabilities/params'
import { cap, type CapabilityContext } from '../capabilities/registry'
import {
  addReply,
  addThread,
  commentBody,
  commentedNotes,
  locate,
  readNoteComments,
  setResolved,
  UnreadableComments,
  type CommentAuthor,
} from './note-comments'

export const COMMENT_NAMESPACES = ['comments'] as const

export interface CommentCapabilitiesDeps {
  /** The signed-in GitHub login, or null when nobody is signed in. */
  login(): string | null
}

/** A note's vault path and text, refusing what takes no comments
 *  (`isCommentableNote`, on the normalised path, with the vault's claims) or
 *  what a read may not reach
 *  (the shared fences, through `readNote`). */
async function noteText(
  ctx: CapabilityContext,
  path: string,
): Promise<{ rel: string; text: string }> {
  const rel = shownPath(path)
  if (!isCommentableNote(rel, await ctx.claims())) {
    throw new CapabilityError('BAD_REQUEST', `${path} takes no comments`)
  }
  return { rel, text: await readNote(ctx, rel) }
}

async function threadsOf(ctx: CapabilityContext, path: string): Promise<LocatedThread[]> {
  const { rel, text } = await noteText(ctx, path)
  try {
    return locate(text, await readNoteComments(ctx.root, rel))
  } catch (err) {
    if (err instanceof UnreadableComments) throw new CapabilityError('BAD_REQUEST', err.message)
    throw err
  }
}

function body(raw: Record<string, unknown>): string {
  const out = commentBody(stringParam(raw, 'body'))
  if (typeof out !== 'string') throw new CapabilityError('BAD_REQUEST', out.refused)
  return out
}

const threadParams = (raw: unknown) => {
  const p = paramsObject(raw)
  return { path: stringParam(p, 'path'), thread: stringParam(p, 'thread') }
}

/** What a list says about one note in the vault-wide listing. */
function summary(path: string, threads: LocatedThread[]): string | null {
  const open = threads.filter((t) => !isResolved(t))
  if (open.length === 0) return null
  const detached = open.filter((t) => t.line === null).length
  return `${path}\t${open.length} open${detached > 0 ? `, ${detached} detached` : ''}`
}

export const commentCapabilities = (deps: CommentCapabilitiesDeps) => {
  const agent = (): CommentAuthor => {
    const login = deps.login()
    if (login === null) throw new CapabilityError('UNAVAILABLE', 'Holi is not signed in to GitHub.')
    return { login, agent: true }
  }
  const missing = (thread: string, path: string) =>
    new CapabilityError('NOT_FOUND', `no thread ${thread} on ${path}`)

  return {
    'comments.list': cap({
      doors: ['cli'],
      cli: {
        args: ['path?'],
        summary:
          "a note's comment threads: the passage, line, author, date, replies and status; without a path, every note with open threads",
      },
      params: (raw) => ({ path: optionalStringParam(paramsObject(raw), 'path') }),
      run: async (
        ctx,
        { path },
      ): Promise<
        | { path: string; threads: LocatedThread[] }
        | { notes: { path: string; threads: LocatedThread[] }[] }
      > => {
        if (path !== undefined) return { path, threads: await threadsOf(ctx, path) }
        const notes: { path: string; threads: LocatedThread[] }[] = []
        for (const note of await commentedNotes(ctx.root)) {
          // A sidecar whose note is gone, or one that cannot be read, is
          // nothing to review.
          const threads = await threadsOf(ctx, note).catch(() => null)
          if (threads !== null) notes.push({ path: note, threads })
        }
        return { notes }
      },
      text: (result) => {
        if ('threads' in result) return formatNoteComments(result.path, result.threads)
        const lines = result.notes.flatMap((n) => summary(n.path, n.threads) ?? [])
        return lines.length === 0 ? 'No open comments in this vault.' : lines.join('\n')
      },
    }),

    'comments.add': cap({
      doors: ['cli'],
      cli: {
        args: ['path', 'quote', 'body'],
        summary:
          'open a thread on the passage quoted exactly from the note; --line n picks between repeats; the comment from stdin when not given',
        stdin: 'body',
      },
      writes: true,
      params: (raw) => {
        const p = paramsObject(raw)
        const line = optionalStringParam(p, 'line')
        const n = line === undefined ? undefined : Number(line)
        if (n !== undefined && (!Number.isInteger(n) || n < 1)) {
          throw new CapabilityError('BAD_REQUEST', 'line must be a positive integer')
        }
        return {
          path: stringParam(p, 'path'),
          quote: stringParam(p, 'quote'),
          body: body(p),
          ...(n === undefined ? {} : { line: n }),
        }
      },
      run: async (ctx, { path, quote, body, line }) => {
        const author = agent()
        const { rel, text } = await noteText(ctx, path)
        const range = locateAnchor(text, { quote, prefix: '', suffix: '', line: line ?? 1 })
        if (range === null || text.slice(range.from, range.to) !== quote) {
          throw new CapabilityError('BAD_REQUEST', `that text is not in ${path}; quote it exactly`)
        }
        const repeats = text.split(quote).length - 1
        if (repeats > 1 && line === undefined) {
          throw new CapabilityError(
            'BAD_REQUEST',
            `that text is in ${path} ${repeats} times; say which with --line`,
          )
        }
        const anchor = anchorAt(text, range.from, range.to)
        const id = await addThread(ctx.root, rel, anchor, author, body)
        return { thread: id, line: anchor.line }
      },
      text: ({ thread, line }) => `Opened thread ${thread} on line ${line}.`,
    }),

    'comments.reply': cap({
      doors: ['cli'],
      cli: {
        args: ['path', 'thread', 'body'],
        summary: 'answer a comment thread; the reply from stdin when not given',
        stdin: 'body',
      },
      writes: true,
      params: (raw) => ({ ...threadParams(raw), body: body(paramsObject(raw)) }),
      run: async (ctx, { path, thread, body }) => {
        const author = agent()
        const { rel } = await noteText(ctx, path)
        if (!(await addReply(ctx.root, rel, thread, author, body))) throw missing(thread, path)
        return { thread }
      },
      text: ({ thread }) => `Replied in thread ${thread}.`,
    }),

    'comments.resolve': cap({
      doors: ['cli'],
      cli: { args: ['path', 'thread'], summary: 'mark a comment thread resolved' },
      writes: true,
      params: threadParams,
      run: async (ctx, { path, thread }) => {
        const { login } = agent()
        const { rel } = await noteText(ctx, path)
        if (!(await setResolved(ctx.root, rel, thread, true, login))) throw missing(thread, path)
        return { thread }
      },
      text: ({ thread }) => `Resolved thread ${thread}.`,
    }),

    'comments.reopen': cap({
      doors: ['cli'],
      cli: { args: ['path', 'thread'], summary: 'reopen a resolved comment thread' },
      writes: true,
      params: threadParams,
      run: async (ctx, { path, thread }) => {
        const { login } = agent()
        const { rel } = await noteText(ctx, path)
        if (!(await setResolved(ctx.root, rel, thread, false, login))) throw missing(thread, path)
        return { thread }
      },
      text: ({ thread }) => `Reopened thread ${thread}.`,
    }),
  }
}
