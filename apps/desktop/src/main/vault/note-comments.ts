/**
 * A note's comment threads on disk (docs/features/note-comments.md): reading
 * and changing its sidecar, moving it with its note at the commit boundary,
 * and finding the comments a pull brought that mention the person signed in.
 * The rules are `@holi/shared`'s `note-comments.ts`; this is the file I/O.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { randomBytes } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import {
  anchorAt,
  commentThreads,
  commentsPathFor,
  COMMENTS_DIR,
  emptyCommentsFile,
  formatCommentsFile,
  locateAnchor,
  newMentions,
  notePathOfComments,
  parseCommentsFile,
  vaultRelPath,
  withReply,
  withStatus,
  withThread,
  type CommentAnchor,
  type CommentMention,
  type CommentsFile,
  type LocatedThread,
  type NoteComment,
} from '@holi/shared'
import { runGit, tryGit } from '../git'
import type { StagedChanges } from './hooks/staged'
import type { TransformResult } from './hooks/relink'
import { absPathFor, listFiles, moveDocFile, writeAtomic } from './vault-files'

/** A thread's or a comment's id: short, random, unique within a note. */
export const commentId = (): string => randomBytes(4).toString('hex')

/** Thrown for a sidecar that is there but cannot be read: writing over it
 *  would lose what it holds. */
export class UnreadableComments extends Error {}

async function readText(root: string, rel: string): Promise<string | null> {
  return readFile(absPathFor(root, vaultRelPath(rel)), 'utf8').catch(() => null)
}

/** `notePath`'s threads, as stored. A note nobody commented on has none. */
export async function readNoteComments(root: string, notePath: string): Promise<CommentsFile> {
  const text = await readText(root, commentsPathFor(notePath))
  if (text === null) return emptyCommentsFile()
  const file = parseCommentsFile(text)
  if (file === null) {
    throw new UnreadableComments(`${commentsPathFor(notePath)} is not a comments file`)
  }
  return file
}

/** One change at a time per sidecar, so two quick writes never read the same
 *  old file and drop each other's comment. */
const queues = new Map<string, Promise<unknown>>()

/**
 * Change `notePath`'s threads: `edit` gets the file as it is now and returns
 * the new one, or null to leave it. Returns what was written.
 */
export function changeNoteComments(
  root: string,
  notePath: string,
  edit: (file: CommentsFile) => CommentsFile | null,
): Promise<CommentsFile | null> {
  const key = `${root}\0${notePath}`
  const run = (queues.get(key) ?? Promise.resolve()).then(async () => {
    const next = edit(await readNoteComments(root, notePath))
    if (next === null) return null
    await writeAtomic(root, vaultRelPath(commentsPathFor(notePath)), formatCommentsFile(next))
    return next
  })
  const settled = run.catch(() => {})
  queues.set(key, settled)
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key)
  })
  return run
}

/** Who writes a comment: the signed-in login, and whether it is their agent. */
export interface CommentAuthor {
  login: string
  agent: boolean
}

/** The longest comment Holi takes: a review, not a document. */
export const MAX_COMMENT_LENGTH = 10_000

/** A comment body, trimmed, or the reason it is refused. */
export function commentBody(raw: string): string | { refused: string } {
  const body = raw.trim()
  if (body === '') return { refused: 'the comment is empty' }
  if (body.length > MAX_COMMENT_LENGTH) {
    return { refused: `a comment is at most ${MAX_COMMENT_LENGTH} characters` }
  }
  return body
}

function newComment(author: CommentAuthor, body: string, now: Date): NoteComment {
  return {
    id: commentId(),
    author: author.login,
    ...(author.agent ? { agent: true as const } : {}),
    at: now.toISOString(),
    body,
  }
}

/** Open a thread on `anchor`; its id. */
export async function addThread(
  root: string,
  notePath: string,
  anchor: CommentAnchor,
  author: CommentAuthor,
  body: string,
  now = new Date(),
): Promise<string> {
  const id = commentId()
  await changeNoteComments(root, notePath, (file) =>
    withThread(file, id, anchor, newComment(author, body, now)),
  )
  return id
}

/** Answer thread `threadId`. False when the note has no such thread. */
export async function addReply(
  root: string,
  notePath: string,
  threadId: string,
  author: CommentAuthor,
  body: string,
  now = new Date(),
): Promise<boolean> {
  const out = await changeNoteComments(root, notePath, (file) =>
    withReply(file, threadId, newComment(author, body, now)),
  )
  return out !== null
}

/** Resolve or reopen thread `threadId`. False when there is no such thread. */
export async function setResolved(
  root: string,
  notePath: string,
  threadId: string,
  resolved: boolean,
  by: string,
  now = new Date(),
): Promise<boolean> {
  const out = await changeNoteComments(root, notePath, (file) =>
    withStatus(file, threadId, { resolved, by, at: now.toISOString() }),
  )
  return out !== null
}

/** Every note that has a sidecar, by its path. */
export async function commentedNotes(root: string): Promise<string[]> {
  return (await listFiles(root, COMMENTS_DIR))
    .map(notePathOfComments)
    .filter((p): p is string => p !== null)
    .sort()
}

/** `notePath`'s threads, each placed in the note's text as it is now. */
export function locate(text: string, file: CommentsFile): LocatedThread[] {
  return commentThreads(file).map((t) => {
    const range = locateAnchor(text, t.anchor)
    return { ...t, line: range === null ? null : anchorAt(text, range.from, range.to).line }
  })
}

/**
 * Comment threads follow their note: a note moved in this commit takes its
 * sidecar along, and a note deleted takes its sidecar with it. Run inside
 * `relink`, at the commit boundary, because that is where git has paired a
 * move's delete and add; a move Holi made and one made with `git mv` or by the
 * agent are the same rename there.
 *
 * A sidecar that is already at the new path (moved along by someone else) is
 * left alone, and so is one whose note was deleted and re-added in the same
 * commit. History keeps a deleted note's threads, as it keeps the note.
 */
export async function followNoteComments(
  root: string,
  staged: StagedChanges,
): Promise<TransformResult> {
  const changed: string[] = []
  const notes: string[] = []
  const exists = async (rel: string) => (await readText(root, rel)) !== null

  for (const { from, to } of staged.renamed) {
    if (notePathOfComments(from) !== null || notePathOfComments(to) !== null) continue
    const was = commentsPathFor(from)
    const now = commentsPathFor(to)
    if (!(await exists(was)) || (await exists(now))) continue
    await moveDocFile(root, vaultRelPath(was), vaultRelPath(now))
    changed.push(was, now)
    notes.push(`relink: moved the comments of ${from} to ${to}`)
  }

  const added = new Set(staged.added)
  for (const path of staged.deleted) {
    if (notePathOfComments(path) !== null || added.has(path)) continue
    const sidecar = commentsPathFor(path)
    if (!(await exists(sidecar)) || (await exists(path))) continue
    await rm(absPathFor(root, vaultRelPath(sidecar)), { force: true })
    changed.push(sidecar)
    notes.push(`relink: deleted the comments of ${path} with it`)
  }
  return { changed, notes }
}

/**
 * The comments that came in between two commits (a pull's before and after)
 * which mention `login` and were written by someone else, by note.
 *
 * With rename detection: a sidecar moved along with its note is compared with
 * itself at its old path, so moving a note does not announce every mention it
 * already had again.
 */
export async function pulledMentions(
  root: string,
  from: string,
  to: string,
  login: string,
): Promise<{ notePath: string; mention: CommentMention }[]> {
  const raw = await runGit(root, [
    'diff',
    '--name-status',
    '-M',
    '--diff-filter=AMR',
    '-z',
    from,
    to,
    '--',
    COMMENTS_DIR,
  ])
  // `-z` name-status: a status, then one path, or two (old, new) for a rename.
  const fields = raw.split('\0').filter((p) => p !== '')
  const changes: { was: string; path: string }[] = []
  for (let i = 0; i < fields.length;) {
    const status = fields[i++]!
    if (status.startsWith('R')) {
      changes.push({ was: fields[i]!, path: fields[i + 1]! })
      i += 2
    } else {
      changes.push({ was: fields[i]!, path: fields[i]! })
      i += 1
    }
  }
  const show = async (rev: string, path: string) => {
    const r = await tryGit(root, ['show', `${rev}:${path}`])
    return r.ok ? parseCommentsFile(r.stdout) : null
  }
  const out: { notePath: string; mention: CommentMention }[] = []
  for (const { was, path } of changes) {
    const notePath = notePathOfComments(path)
    if (notePath === null) continue
    const after = await show(to, path)
    if (after === null) continue
    for (const mention of newMentions(await show(from, was), after, login)) {
      out.push({ notePath, mention })
    }
  }
  return out
}
