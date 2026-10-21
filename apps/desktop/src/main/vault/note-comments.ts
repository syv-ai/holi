/**
 * A note's comment threads on disk (docs/features/note-comments.md): reading
 * and changing its sidecar, moving it with its note,
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
  mergeCommentsText,
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
import { exactPath } from '@holi/shared/path-safety-node'
import { runGit, tryGit } from '../git'
import type { StagedChanges } from './hooks/staged'
import type { TransformResult } from './hooks/relink'
import { absPathFor, listFiles, moveDocFile, withFileLock, writeAtomic } from './vault-files'

/** A thread's or a comment's id: short, random, unique within a note. */
export const commentId = (): string => randomBytes(4).toString('hex')

/** Thrown for a sidecar that is there but cannot be read: writing over it
 *  would lose what it holds. */
export class UnreadableComments extends Error {}

async function readText(root: string, rel: string): Promise<string | null> {
  return readFile(absPathFor(root, vaultRelPath(rel)), 'utf8').catch(() => null)
}

/**
 * The sidecar's file, only when it is the path as named: no symlink on the way
 * and the case it has on disk (`exactPath`). A sidecar arrives with a pull, so
 * a link committed in its place must not let a read or a write reach a file
 * outside it. The file need not exist.
 */
async function sidecarFile(root: string, rel: string): Promise<string> {
  const abs = await exactPath(root, rel)
  if (abs === null) throw new UnreadableComments(`${rel} is not a plain file in the vault`)
  return abs
}

/** `notePath`'s threads, as stored. A note nobody commented on has none. */
export async function readNoteComments(root: string, notePath: string): Promise<CommentsFile> {
  return (await readStored(root, notePath)).file
}

/** The sidecar's text as it is on disk (null when there is none) and its threads. */
async function readStored(
  root: string,
  notePath: string,
): Promise<{ text: string | null; file: CommentsFile }> {
  const abs = await sidecarFile(root, commentsPathFor(notePath))
  const text = await readFile(abs, 'utf8').catch(() => null)
  if (text === null) return { text, file: emptyCommentsFile() }
  const file = parseCommentsFile(text)
  if (file === null) {
    throw new UnreadableComments(`${commentsPathFor(notePath)} is not a comments file`)
  }
  return { text, file }
}

/**
 * Change `notePath`'s threads: `edit` gets the file as it is now and returns
 * the new one, or null to leave it. Returns what was written. One change at a
 * time per sidecar (`withFileLock`), so two quick writes never read the same
 * old file and drop each other's comment.
 *
 * A pull does not take the lock, so the file is read again just before the
 * write: one that changed since the first read gets the change merged into
 * it (`mergeCommentsText`, the merge driver's own rule) rather than written
 * over, so a teammate's comment that landed meanwhile stays.
 */
export function changeNoteComments(
  root: string,
  notePath: string,
  edit: (file: CommentsFile) => CommentsFile | null,
): Promise<CommentsFile | null> {
  const rel = vaultRelPath(commentsPathFor(notePath))
  return withFileLock(absPathFor(root, rel), async () => {
    const read = await readStored(root, notePath)
    const next = edit(read.file)
    if (next === null) return null
    // Checked again right before the write: the read's check is a lock-wait
    // and a parse behind.
    const abs = await sidecarFile(root, rel)
    let text = formatCommentsFile(next)
    const now = await readFile(abs, 'utf8').catch(() => null)
    if (now !== read.text && now !== null) {
      const merged = mergeCommentsText(read.text, text, now)
      if (!merged.ok) {
        throw new UnreadableComments(`${rel} changed while this comment was written: try again`)
      }
      text = merged.text
    }
    await writeAtomic(root, rel, text)
    return parseCommentsFile(text) ?? next
  })
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
 * Move the comment threads of notes Holi itself moves (`renameNote`,
 * `moveNotes`) along with them, at the moment of the move. Done here rather
 * than left to the commit's rename detection, because a note renamed and then
 * edited before the commit no longer looks like a rename to git: its threads
 * would stay behind at the old path.
 *
 * Read all, then write, so a chain (a to b, b to c) moves each sidecar once.
 * A sidecar already at the destination (the threads of a note deleted there
 * earlier) is merged with the one arriving, never written over; one that
 * cannot be read or merged stays where it is, detached rather than lost.
 * Returns every sidecar path it changed.
 */
export async function moveNoteComments(
  root: string,
  moves: readonly { from: string; to: string }[],
): Promise<string[]> {
  const planned: { was: string; now: string; text: string }[] = []
  for (const { from, to } of moves) {
    if (from === to || notePathOfComments(from) !== null || notePathOfComments(to) !== null) {
      continue
    }
    const text = await readSidecarText(root, commentsPathFor(from))
    if (text !== null) planned.push({ was: commentsPathFor(from), now: commentsPathFor(to), text })
  }
  const leaving = new Set(planned.map((p) => p.was))
  const writes: { was: string; now: string; text: string }[] = []
  for (const p of planned) {
    const there = leaving.has(p.now) ? null : await readSidecarText(root, p.now)
    if (there === null) {
      writes.push(p)
      continue
    }
    const merged = mergeCommentsText(null, there, p.text)
    if (merged.ok) writes.push({ ...p, text: merged.text })
  }
  for (const w of writes) await rm(absPathFor(root, vaultRelPath(w.was)), { force: true })
  for (const w of writes) await writeAtomic(root, vaultRelPath(w.now), w.text)
  return writes.flatMap((w) => [w.was, w.now])
}

/** A sidecar's text, or null when there is none or it is not a plain file in
 *  the vault (a link must not carry another file's text into the vault). */
async function readSidecarText(root: string, rel: string): Promise<string | null> {
  const abs = await exactPath(root, rel)
  return abs === null ? null : readFile(abs, 'utf8').catch(() => null)
}

/**
 * Comment threads follow a note moved outside Holi: a note git sees renamed in
 * this commit (`git mv`, or the agent's own move) takes its sidecar along. Run
 * inside `relink`, at the commit boundary, because that is where git has paired
 * a move's delete and add. A sidecar already at the new path (Holi's own move
 * took it, or someone else did) is left alone.
 *
 * A note deleted takes nothing with it: its sidecar stays, its threads
 * detached, listed by `holi comments list` until someone resolves or removes
 * them. Git's rename detection is a guess (half the lines alike), and a note
 * renamed and rewritten in one commit reads as a delete and an add; deleting
 * the threads then would delete and push every comment on it.
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
