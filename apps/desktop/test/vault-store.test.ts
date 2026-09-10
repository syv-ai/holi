import { emptyVaultSnapshot } from '@holi/shared'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { scanVault } from '../src/main/vault/vault-store'

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

async function vault(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holi-vs-'))
  dirs.push(root)
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, text, 'utf8')
  }
  return root
}

describe('scanVault', () => {
  it('separates notes from tasks by the filename marker', async () => {
    const root = await vault({
      'roadmap.md': '# Roadmap\n',
      'projects/q2/task.fix-login.md': '---\ntitle: Fix login\nstatus: doing\n---\n',
      'projects/tasks.md': 'a note that merely mentions tasks\n',
    })
    const snap = await scanVault(root)

    expect(snap.docs.map((d) => d.path).sort()).toEqual(['projects/tasks.md', 'roadmap.md'])
    expect(snap.tasks.map((t) => t.path)).toEqual(['projects/q2/task.fix-login.md'])
    expect(snap.tasks[0]!.status).toBe('doing')
  })

  it('takes a task lane from its folder, not from a field', async () => {
    const root = await vault({
      'projects/q2/task.a.md': '---\ntitle: A\n---\n',
      'task.b.md': '---\ntitle: B\n---\n',
    })
    const snap = await scanVault(root)
    const lanes = Object.fromEntries(snap.tasks.map((t) => [t.title, t.path]))
    expect(lanes.A).toBe('projects/q2/task.a.md')
    expect(lanes.B).toBe('task.b.md')
  })

  it('marks a daily note from its frontmatter, never its filename', async () => {
    const root = await vault({
      '21-07-2026.md': '---\ntype: daily-note\ndate: 2026-07-21\n---\n\n# 21-07-2026\n',
      // looks like a daily, was written by a human — must stay an ordinary note,
      // or the archive sweep would delete a note the system never created
      '20-07-2026.md': '# Notes from the offsite\n',
    })
    const snap = await scanVault(root)
    const kinds = Object.fromEntries(snap.docs.map((d) => [d.path, d.kind]))
    expect(kinds['21-07-2026.md']).toBe('daily')
    expect(kinds['20-07-2026.md']).toBe('note')
  })

  it('does not read `type: daily-note` out of the body', async () => {
    // A horizontal rule opens something that looks like frontmatter to a loose
    // matcher. Getting this wrong hands the note to the archive sweep, which
    // deletes empty dailies.
    const root = await vault({
      'meeting.md': '# Meeting\n\nWe discussed:\n\n---\n\ntype: daily-note\n',
    })
    const snap = await scanVault(root)
    expect(snap.docs[0]!.kind).toBe('note')
  })

  it('surfaces an unparseable task instead of dropping it', async () => {
    const root = await vault({ 'task.broken.md': '---\nstatus: blocked\n---\n' })
    const snap = await scanVault(root)

    expect(snap.tasks).toEqual([])
    expect(snap.broken).toHaveLength(1)
    expect(snap.broken[0]!.path).toBe('task.broken.md')
    expect(snap.broken[0]!.error).toMatch(/status must be one of/)
  })

  it('never walks into .git', async () => {
    const root = await vault({
      'note.md': '# real\n',
      '.git/COMMIT_EDITMSG': 'wip\n',
      '.git/refs/heads/note.md': 'not a note\n',
    })
    const snap = await scanVault(root)
    expect(snap.docs.map((d) => d.path)).toEqual(['note.md'])
  })

  it('surfaces machine-local files as files (out of the note graph), never as notes', async () => {
    const root = await vault({
      'note.md': '# real\n',
      'USER.local.md': '# private\n',
      '.holi/settings.local.json': '{}\n',
      '.holi/theme.local.json': '{}\n',
    })
    const snap = await scanVault(root)
    // Local-only markdown does NOT become a note — it stays out of docs and the
    // link-aware ops (backrefs/rename/mentions).
    expect(snap.docs.map((d) => d.path)).toEqual(['note.md'])
    // ...but every local file DOES reach the snapshot as a file, so the tree can
    // show it under show-hidden. Git keeps it uncommitted, not the scanner.
    expect(snap.files.map((f) => f.path).sort()).toEqual([
      '.holi/settings.local.json',
      '.holi/theme.local.json',
      'USER.local.md',
    ])
  })

  it('ignores non-markdown files', async () => {
    const root = await vault({ 'note.md': '# real\n', 'logo.png': 'binary', 'data.json': '{}' })
    const snap = await scanVault(root)
    expect(snap.docs.map((d) => d.path)).toEqual(['note.md'])
  })

  it('is empty, not an error, on a vault with nothing in it', async () => {
    const root = await vault({})
    await expect(scanVault(root)).resolves.toEqual(emptyVaultSnapshot())
  })

  it('surfaces every ancestor directory of every file as a dir', async () => {
    const root = await vault({
      'roadmap.md': '# Roadmap\n',
      'projects/q2/task.fix-login.md': '---\ntitle: Fix login\n---\n',
    })
    const snap = await scanVault(root)
    // Both the leaf dir and its parent, so the tree can render the chain — even
    // though `projects/q2` holds only a (hidden-by-default) task.
    expect(snap.dirs.sort()).toEqual(['projects', 'projects/q2'])
  })

  it('keeps an empty folder alive by its .gitkeep, without showing the marker', async () => {
    const root = await vault({ 'bolig/.gitkeep': '' })
    const snap = await scanVault(root)
    // The folder exists (in dirs) but the keep-file is never content: not a file,
    // not a doc, not a task.
    expect(snap.dirs).toEqual(['bolig'])
    expect(snap.files).toEqual([])
    expect(snap.docs).toEqual([])
    expect(snap.tasks).toEqual([])
  })

  it('lists non-markdown files separately from notes, ignoring junk', async () => {
    const root = await vault({
      'note.md': '# Note',
      'data.json': '{"a":1}',
      'sub/pic.png': 'binary-ish',
      '.DS_Store': 'junk',
    })
    const snap = await scanVault(root)
    expect(snap.docs.map((d) => d.path)).toEqual(['note.md'])
    expect(snap.files.map((f) => f.path).sort()).toEqual(['data.json', 'sub/pic.png'])
  })
})
