#!/usr/bin/env node
// Holi SessionStart hook — tell the agent what this vault remembers, once per
// session, before it answers anything. See prd/agent.md §Memory (D89).
//
// SessionStart rather than UserPromptSubmit: memory is session state, and 3k
// characters injected into every turn is a cost paid over and over. It fires on
// `startup`, `resume` AND `compact`, and the third is the one that matters most
// — a compaction is precisely the moment the agent has forgotten it has memory
// at all, so this prints on all three without looking at which.
//
// Reads only: `memory/index.md` (which the memory-index transform already
// generated, so nothing is parsed twice), a scan for personal `*.local.md`
// memories, and one `git log`. No HOLI_HOOK_PORT — Claude Code spawns this, not
// Holi, so it must work with no server anywhere. Absent `memory/`, it prints
// nothing and exits 0, exactly as the focused-note hook does outside Holi.
//
// Dependency-free (`node:` builtins only), like the three hooks beside it.

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd()
const MEMORY_DIR = join(root, 'memory')

// ~3,000 characters. Over it, descriptions go first and every TITLE survives:
// a memory the agent cannot see the name of is a memory it will never Read, so
// dropping names to save room defeats the whole section.
const CAP = 3000

/** Read a file, or null. Every failure here is ordinary — no vault, no memory
 *  directory, a file deleted mid-scan — and none is worth an error. */
function readOr(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Every `.md` under `memory/`, recursively, split into personal and shared.
 *
 * The personal half is the point — a `*.local.md` appears in no committed file,
 * so this hook is the only reader it has. The shared half is counted rather
 * than read: it exists solely to notice the case below where memory files are
 * present but `index.md` is not.
 */
function memoryFiles(dir, prefix = 'memory') {
  const out = { personal: [], shared: [] }
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    const abs = join(dir, name)
    let stat
    try {
      stat = statSync(abs)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      const inner = memoryFiles(abs, `${prefix}/${name}`)
      out.personal = out.personal.concat(inner.personal)
      out.shared = out.shared.concat(inner.shared)
    } else if (name.endsWith('.md')) {
      const entry = { path: `${prefix}/${name}`, abs }
      if (name.includes('.local.')) out.personal.push(entry)
      else if (entry.path !== 'memory/index.md') out.shared.push(entry)
    }
  }
  return out
}

/** Frontmatter title/description, without a YAML parser: these are the two keys
 *  the seed asks for and both are one-line scalars. A file whose frontmatter is
 *  malformed simply yields nothing, which is this whole design's house style. */
function titleAndDescription(text, path) {
  const fence = /^---\n([\s\S]*?)\n---/.exec(text ?? '')
  const block = fence?.[1] ?? ''
  const value = (key) => {
    const m = new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm').exec(block)
    return m?.[1]?.replace(/^["']|["']$/g, '').trim() || null
  }
  const h1 = /^\s*#\s+(.+?)\s*$/m.exec((text ?? '').replace(/^---\n[\s\S]*?\n---\n/, ''))
  const name = (path.split('/').at(-1) ?? path).replace(/\.md$/i, '')
  return { title: value('title') ?? h1?.[1] ?? name, description: value('description') }
}

const index = readOr(join(MEMORY_DIR, 'index.md'))
const { personal, shared } = memoryFiles(MEMORY_DIR)

// Nothing to say. A vault with no memory directory at all is the ordinary case
// for a repo somebody opened `claude` in by hand.
if (index === null && personal.length === 0 && shared.length === 0) process.exit(0)

/** The index's own entry lines, with their `## type` headings, and the counts. */
function indexSections(text) {
  const sections = []
  let current = null
  for (const line of (text ?? '').split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) {
      current = { type: heading[1], lines: [] }
      sections.push(current)
    } else if (line.startsWith('- ') && current) {
      current.lines.push(line)
    }
  }
  return sections
}

const sections = indexSections(index)
const total = sections.reduce((n, s) => n + s.lines.length, 0)

/** `Recent: <date> <subject>` × 3. One subprocess, once per session — a looser
 *  budget than the per-turn hook's 50 ms. Every failure is swallowed: a vault
 *  mid-rebase, or a `memory/` with no commits yet, prints the rest and says
 *  nothing about recent changes rather than failing the session start. */
function recent() {
  try {
    const out = execFileSync(
      'git',
      ['log', '--format=%ad %s', '--date=short', '-n', '3', '--', 'memory/'],
      { cwd: root, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    return out.split('\n').filter((l) => l.trim() !== '')
  } catch {
    return []
  }
}

/** Build the whole thing at a given verbosity, so the cap is met by dropping a
 *  named thing rather than by cutting mid-word. */
function render({ descriptions }) {
  // Anchored past the `]]` on purpose: a bare `/\s+—\s+.*$/` would cut at the
  // FIRST em dash, and a title containing one would lose its tail along with
  // the description it was meant to drop.
  const strip = (line) => (descriptions ? line : line.replace(/^(- \[\[.*?\]\])\s+—\s+.*$/, '$1'))
  // With no index, `total` is 0 and the shared count is the only honest number.
  const count = index === null ? shared.length : total
  const out = [
    `# This vault's memory (${count} shared${personal.length > 0 ? `, ${personal.length} personal` : ''})`,
  ]

  if (sections.length > 0) {
    out.push('', `Types in use: ${sections.map((s) => `${s.type} (${s.lines.length})`).join(', ')}`)
    for (const section of sections) {
      out.push('', `## ${section.type}`, '', ...section.lines.map(strip))
    }
  }

  if (personal.length > 0) {
    out.push('', '## personal (this machine only, never committed)', '')
    for (const file of personal) {
      const { title, description } = titleAndDescription(readOr(file.abs), file.path)
      const line = `- [[${file.path}|${title}]]${description ? ` — ${description}` : ''}`
      out.push(strip(line))
    }
  }

  // Memories exist but nothing has generated the index for them — a vault
  // whose `memory/` was filled in outside Holi, or one whose index was deleted.
  // Say so rather than printing an overview that silently omits every shared
  // memory. Deliberately NOT a fallback scan: reading and grouping the files
  // here would be a second copy of the indexer, kept in step by nobody.
  if (index === null && shared.length > 0) {
    out.push(
      '',
      `${shared.length} shared memory file(s) are present but \`memory/index.md\` has not been generated yet. Read \`memory/\` directly; Holi will write the index on the next commit that touches one.`,
    )
  }

  const log = recent()
  if (log.length > 0) out.push('', '## recent', '', ...log.map((l) => `- ${l}`))

  // Only when there is something in it to split. An empty MEMORY.md is the
  // seed's own leftover and suggesting work on it would be noise.
  const legacy = readOr(join(root, 'MEMORY.md'))
  if (legacy !== null && legacy.trim() !== '') {
    out.push(
      '',
      'This vault also has a legacy `MEMORY.md`. Worth splitting into `memory/` when the user asks.',
    )
  }

  return `${out.join('\n')}\n`
}

let text = render({ descriptions: true })
if (text.length > CAP) text = render({ descriptions: false })
if (text.length > CAP) {
  // Last resort, and it still names where the rest is rather than stopping dead.
  const pointer = '\n…truncated. The whole list is in `memory/index.md`.\n'
  text = text.slice(0, CAP - pointer.length) + pointer
}

process.stdout.write(text)
process.exit(0)
