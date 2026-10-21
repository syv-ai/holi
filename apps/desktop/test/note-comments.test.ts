import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  anchorAt,
  emptyCommentsFile,
  formatCommentsFile,
  withReply,
  withThread,
  type CommentsFile,
} from '@holi/shared'
import { runGit } from '../src/main/git'
import {
  addThread,
  pulledMentions,
  readNoteComments,
  UnreadableComments,
} from '../src/main/vault/note-comments'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'holi-note-comments-'))
  await runGit(root, ['init', '-q', '-b', 'main'])
  await runGit(root, ['config', 'user.email', 'ada@syv.ai'])
  await runGit(root, ['config', 'user.name', 'Ada Holm'])
})

afterEach(() => rm(root, { recursive: true, force: true }))

const doc = 'The budget is fixed at 40k for the year.\n'
const comment = (id: string, body: string) => ({
  id,
  author: 'bob',
  at: `2026-10-21T10:00:0${id.length}.000Z`,
  body,
})

async function commit(files: Record<string, CommentsFile | null>): Promise<string> {
  for (const [path, file] of Object.entries(files)) {
    if (file === null) {
      await rm(join(root, path))
      continue
    }
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), formatCommentsFile(file))
  }
  await runGit(root, ['add', '-A'])
  await runGit(root, ['commit', '-qm', 'change'])
  return runGit(root, ['rev-parse', 'HEAD'])
}

describe('pulledMentions', () => {
  it('compares a moved sidecar with itself at its old path', async () => {
    const old = '.holi/comments/plan.md.json'
    const moved = '.holi/comments/drafts/plan.md.json'
    let file = withThread(
      emptyCommentsFile(),
      't',
      anchorAt(doc, 14, 26),
      comment('a', 'Over to @ada, with a long enough body to keep the move a rename.'),
    )
    file = withReply(file, 't', comment('bb', 'And some more discussion that is not for anyone.'))!
    const from = await commit({ [old]: file })

    // Moved as it was: nothing new to announce.
    const plainMove = await commit({ [old]: null, [moved]: file })
    expect(await pulledMentions(root, from, plainMove, 'ada')).toEqual([])

    // Moved with a new comment in it: only that one.
    const replied = withReply(file, 't', comment('ccc', 'Ping @ada again.'))!
    const to = await commit({ [moved]: replied })
    const found = await pulledMentions(root, from, to, 'ada')
    expect(found.map((f) => [f.notePath, f.mention.comment.id])).toEqual([
      ['drafts/plan.md', 'ccc'],
    ])
  })
})

describe('a sidecar that is a symlink', () => {
  const author = { login: 'ada', agent: false }

  it('is neither read nor written through, whether the link is the file or a folder', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'holi-outside-'))
    try {
      const target = join(outside, 'theirs.json')
      const theirs = formatCommentsFile(emptyCommentsFile())
      await writeFile(target, theirs)
      await mkdir(join(root, '.holi/comments'), { recursive: true })
      await symlink(target, join(root, '.holi/comments/a.md.json'))
      await symlink(outside, join(root, '.holi/comments/linked'))

      for (const note of ['a.md', 'linked/theirs']) {
        await expect(readNoteComments(root, note)).rejects.toBeInstanceOf(UnreadableComments)
        await expect(
          addThread(root, note, anchorAt(doc, 0, 10), author, 'hello'),
        ).rejects.toBeInstanceOf(UnreadableComments)
      }
      expect(await readFile(target, 'utf8')).toBe(theirs)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('leaves an ordinary sidecar readable and writable', async () => {
    await addThread(root, 'a.md', anchorAt(doc, 0, 10), author, 'hello')
    const file = await readNoteComments(root, 'a.md')
    expect(Object.keys(file.threads)).toHaveLength(1)
  })
})
