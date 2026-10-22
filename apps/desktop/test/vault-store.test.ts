import { emptyVaultSnapshot } from '@holi/shared'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { scanVault as scan, type ScanClaim } from '../src/main/vault/vault-store'

/** A stand-in plugin's claim: `card.<name>.md` in any folder, with a
 *  required `kind`. The scanner knows no plugin; any claim will do. */
const CARDS: ScanClaim = {
  plugin: 'cards',
  match: (path) => /(^|\/)card\.[^/]+\.md$/.test(path),
  parse: (text, path) => {
    const kind = /^kind: (\w+)$/m.exec(text)?.[1]
    if (kind === undefined) throw new Error('kind is required')
    return { path, kind }
  },
}
const scanVault = (root: string) => scan(root, [CARDS])
const cards = (snap: Awaited<ReturnType<typeof scan>>) =>
  snap.claimed['cards'] ?? { items: [], broken: [] }

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
  it("separates notes from a claim's files by its match, parsed by the claim", async () => {
    const root = await vault({
      'roadmap.md': '# Roadmap\n',
      'projects/q2/card.fix-login.md': '---\nkind: bug\n---\n',
      'projects/cards.md': 'a note that merely mentions cards\n',
    })
    const snap = await scanVault(root)

    expect(snap.docs.map((d) => d.path).sort()).toEqual(['projects/cards.md', 'roadmap.md'])
    expect(cards(snap).items).toEqual([{ path: 'projects/q2/card.fix-login.md', kind: 'bug' }])
  })

  it('lists a claimed file as a plain note when nothing claims it', async () => {
    const root = await vault({ 'card.a.md': '---\nkind: bug\n---\n' })
    const snap = await scan(root, [])
    expect(snap.docs.map((d) => d.path)).toEqual(['card.a.md'])
    expect(snap.claimed).toEqual({})
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

  it('surfaces a claimed file that will not parse instead of dropping it', async () => {
    const root = await vault({ 'card.broken.md': '---\ntitle: no kind\n---\n' })
    const snap = await scanVault(root)

    expect(cards(snap).items).toEqual([])
    expect(cards(snap).broken).toEqual([{ path: 'card.broken.md', error: 'kind is required' }])
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
      '.holi/settings/app.local.yaml': '{}\n',
      '.holi/settings/theme.local.css': '{}\n',
    })
    const snap = await scanVault(root)
    // Local-only markdown does NOT become a note — it stays out of docs and the
    // link-aware ops (backrefs/rename/mentions).
    expect(snap.docs.map((d) => d.path)).toEqual(['note.md'])
    // ...but every local file DOES reach the snapshot as a file, so the tree can
    // show it under show-hidden. Git keeps it uncommitted, not the scanner.
    expect(snap.files.map((f) => f.path).sort()).toEqual([
      '.holi/settings/app.local.yaml',
      '.holi/settings/theme.local.css',
      'USER.local.md',
    ])
  })

  it('gives a local file a claim takes to its claim, and leaves the rest plain files', async () => {
    // A private task (`task.<name>.local.md`) is a task on this machine's board.
    const root = await vault({
      'card.mine.local.md': '---\nkind: bug\n---\n',
      'USER.local.md': '# private\n',
    })
    const snap = await scanVault(root)
    expect(cards(snap).items).toEqual([{ path: 'card.mine.local.md', kind: 'bug' }])
    expect(snap.files.map((f) => f.path)).toEqual(['USER.local.md'])
    expect(snap.docs).toEqual([])
  })

  it('ignores non-markdown files', async () => {
    const root = await vault({ 'note.md': '# real\n', 'logo.png': 'binary', 'data.json': '{}' })
    const snap = await scanVault(root)
    expect(snap.docs.map((d) => d.path)).toEqual(['note.md'])
  })

  it('is empty, not an error, on a vault with nothing in it', async () => {
    const root = await vault({})
    await expect(scan(root, [])).resolves.toEqual(emptyVaultSnapshot())
  })

  it('surfaces every ancestor directory of every file as a dir', async () => {
    const root = await vault({
      'roadmap.md': '# Roadmap\n',
      'projects/q2/card.fix-login.md': '---\nkind: bug\n---\n',
    })
    const snap = await scanVault(root)
    // Both the leaf dir and its parent, so the tree can render the chain, even
    // though `projects/q2` holds only a claimed file.
    expect(snap.dirs.sort()).toEqual(['projects', 'projects/q2'])
  })

  it('keeps an empty folder alive by its .gitkeep, without showing the marker', async () => {
    const root = await vault({ 'bolig/.gitkeep': '' })
    const snap = await scanVault(root)
    // The folder exists (in dirs) but the keep-file is never content: not a file,
    // not a doc, not a claimed file.
    expect(snap.dirs).toEqual(['bolig'])
    expect(snap.files).toEqual([])
    expect(snap.docs).toEqual([])
    expect(cards(snap).items).toEqual([])
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
