#!/usr/bin/env node
// Holi SessionStart hook — tell the agent what this vault remembers, once per
// session, before it answers anything. See docs/features/agent-memory.md.
//
// SessionStart rather than UserPromptSubmit: memory is session state, and 3k
// characters injected into every turn is a cost paid over and over. It prints on
// `startup`, `resume` AND `compact`: after a compaction the agent has forgotten
// it has memory at all.
//
// Reads only. The shared memories' titles come from `.holi/memory/index.md`,
// which the memory-index transform already generated; personal `*.local.md`
// memories, which no index lists, are read here, and so are the names in the
// work log's folder. Every memory file is also parsed once per session by the
// memory lint (`.claude/skills/memory/lint.mjs`), of which only the count is
// printed, plus one `git log`. It never calls Holi's bridge: Claude Code spawns
// this, not Holi, so it must work with no server anywhere. Absent
// `.holi/memory/`, it prints nothing and exits 0, exactly as the focused-note
// hook does outside Holi.
//
// Dependency-free (`node:` builtins only), like the three hooks beside it.

import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd()
const MEMORY_DIR = join(root, '.holi/memory')

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
 * Every `.md` under `.holi/memory/`, recursively, split into personal and shared.
 *
 * The personal half is the point — a `*.local.md` appears in no committed file,
 * so this hook is the only reader it has. The shared half is counted rather
 * than read: it exists solely to notice the case below where memory files are
 * present but `index.md` is not. Symlinks are skipped, not followed, as the lint
 * skips them: one could point outside the vault or loop.
 */
function memoryFiles(dir, prefix = '.holi/memory') {
  const out = { personal: [], shared: [] }
  let entries
  try {
    // Sorted: `readdir`'s order is the filesystem's, and this text opens the
    // session, so it may change only when memory changes, a scratch note
    // expires, or the day turns, never with the machine it runs on.
    entries = readdirSync(dir).sort()
  } catch {
    return out
  }
  for (const name of entries) {
    const abs = join(dir, name)
    let stat
    try {
      stat = lstatSync(abs)
    } catch {
      continue
    }
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) {
      const inner = memoryFiles(abs, `${prefix}/${name}`)
      out.personal = out.personal.concat(inner.personal)
      out.shared = out.shared.concat(inner.shared)
    } else if (name.endsWith('.md')) {
      const entry = { path: `${prefix}/${name}`, abs }
      if (name.includes('.local.')) out.personal.push(entry)
      else if (entry.path !== '.holi/memory/index.md') out.shared.push(entry)
    }
  }
  return out
}

/** One frontmatter value, or null for an empty one, or undefined when it is
 *  not a scalar this reader is sure of: escapes, flow and block syntax, a
 *  leading indicator, or an unquoted `: ` (which YAML rejects outright). A
 *  trailing ` # comment` is dropped, as YAML drops it. */
function scalar(raw) {
  const quoted = /^(?:"([^"\\]*)"|'([^']*)')(?:[ \t]+#.*)?$/.exec(raw)
  if (quoted) return (quoted[1] ?? quoted[2]).trim() || null
  const plain = raw.replace(/(?:^|[ \t]+)#.*$/, '').trim()
  if (plain === '') return null
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(plain) || /:(?:[ \t]|$)/.test(plain)) return undefined
  return plain
}

/**
 * Frontmatter title/description (and a scratch note's type/expires), without a
 * YAML parser: all are one-line scalars. The fence is found as `@holi/shared`'s
 * `splitFrontmatter` finds it, CRLF included.
 *
 * `complete` says whether every line was one this reader is sure YAML reads the
 * same way. Holi's sweep parses real YAML and reads invalid YAML as no
 * frontmatter, so a scratch note may be hidden as expired only when `complete`:
 * anything less is a note the sweep might never delete. Values from lines it
 * could not read are still used for display, best effort.
 */
function frontmatter(text, path) {
  const normalized = (text ?? '').replace(/\r\n/g, '\n')
  const fields = new Map()
  let complete = true
  let body = normalized
  if (normalized.startsWith('---\n')) {
    const end = normalized.indexOf('\n---', 3)
    if (end === -1) complete = false
    else {
      const after = normalized.indexOf('\n', end + 1)
      body = after === -1 ? '' : normalized.slice(after + 1)
      for (const line of normalized.slice(4, end).split('\n')) {
        if (/^[ \t]*(?:#.*)?$/.test(line)) continue
        const m = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*))?$/.exec(line)
        if (!m || fields.has(m[1])) {
          complete = false
          continue
        }
        const value = scalar(m[2] ?? '')
        if (value === undefined) complete = false
        fields.set(m[1], value === undefined ? m[2].trim() : value)
      }
    }
  }
  const value = (key) => fields.get(key) ?? null
  const h1 = /^\s*#\s+(.+?)\s*$/m.exec(body)
  const name = (path.split('/').at(-1) ?? path).replace(/\.md$/i, '')
  return {
    title: value('title') ?? h1?.[1] ?? name,
    description: value('description'),
    type: value('type'),
    expires: value('expires'),
    complete,
  }
}

/** When a scratch note's `expires` passes, on this machine's clock, or null when
 *  it is no stamp. A date lasts through that day; `YYYY-MM-DDTHH:MM` ends at
 *  that minute. The same rule as `scratchExpiry` in `@holi/shared`, which Holi's
 *  sweep deletes by; this hook imports nothing, so it is written twice. */
function expiry(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value ?? '')
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])]
  const day = new Date(y, mo, d)
  if (day.getMonth() !== mo || day.getDate() !== d) return null
  if (m[4] === undefined) return new Date(y, mo, d + 1)
  const [h, min, sec] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)]
  if (h > 23 || min > 59 || sec > 59) return null
  return new Date(y, mo, d, h, min, sec)
}

const index = readOr(join(MEMORY_DIR, 'index.md'))
const { personal: personalFiles, shared } = memoryFiles(MEMORY_DIR)

// Personal memories, read once, with scratch notes apart. An expired scratch
// note is already gone as far as the agent is concerned: Holi deletes it on
// its next sweep, and outside Holi nothing does, so it is left out here. Only
// when the sweep would delete it, though: one whose frontmatter this hook
// cannot fully read stays listed, since the sweep may never take it.
const now = new Date()
const personal = []
const scratch = []
for (const file of personalFiles) {
  const meta = { ...file, ...frontmatter(readOr(file.abs), file.path) }
  if (meta.type !== 'scratch') personal.push(meta)
  else {
    const ends = expiry(meta.expires)
    if (ends === null || now < ends || !meta.complete) scratch.push({ ...meta, ends })
  }
}

/** Today's work log and the newest one before it, as vault paths, when they
 *  exist. Only the names: the log is read when someone asks what was done. */
function workLogs() {
  let names
  try {
    names = readdirSync(join(root, '.holi/state/log'))
  } catch {
    return []
  }
  const pad = (n) => String(n).padStart(2, '0')
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const days = names
    .map((n) => /^(\d{4}-\d{2}-\d{2})\.local\.md$/.exec(n)?.[1])
    .filter((d) => d !== undefined && d <= today)
    .sort()
  const out = []
  if (days.at(-1) === today) out.push({ day: days.pop(), label: 'today' })
  if (days.length > 0) out.push({ day: days.at(-1), label: 'previous' })
  return out.map(({ day, label }) => `\`.holi/state/log/${day}.local.md\` (${label})`)
}
const logs = workLogs()

// Nothing to say. A vault with no memory directory at all is the ordinary case
// for a repo somebody opened `claude` in by hand.
if (
  index === null &&
  personal.length === 0 &&
  scratch.length === 0 &&
  shared.length === 0 &&
  logs.length === 0
)
  process.exit(0)

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

/** How many lint findings there are, or 0 when the lint is missing or throws:
 *  the overview never fails a session start. Imported rather than copied, so the
 *  count and the list the agent runs are the same code. Only the count is
 *  printed, and it depends on nothing but the files, so it changes only when
 *  memory does. */
async function lintCount() {
  try {
    const { lintVault } = await import(new URL('../skills/memory/lint.mjs', import.meta.url).href)
    return lintVault(root).length
  } catch {
    return 0
  }
}

const findings = await lintCount()
const total = sections.reduce((n, s) => n + s.lines.length, 0)

/** `Recent: <date> <subject>` × 3. One subprocess, once per session — a looser
 *  budget than the per-turn hook's 50 ms. Every failure is swallowed: a vault
 *  mid-rebase, or a `.holi/memory/` with no commits yet, prints the rest and says
 *  nothing about recent changes rather than failing the session start. */
function recent() {
  try {
    const out = execFileSync(
      'git',
      ['log', '--format=%ad %s', '--date=short', '-n', '3', '--', '.holi/memory/'],
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
  // A scratch line's `(expires …)` sits between the link and the description.
  const strip = (line) =>
    descriptions ? line : line.replace(/^(- \[\[.*?\]\](?: \([^)]*\))?)\s+—\s+.*$/, '$1')
  // With no index, `total` is 0 and the shared count is the only honest number.
  const count = index === null ? shared.length : total
  const out = [
    `# This vault's memory (${count} shared${personal.length > 0 ? `, ${personal.length} personal` : ''}${scratch.length > 0 ? `, ${scratch.length} scratch` : ''})`,
  ]

  // Next to the heading, so the cap's truncation can never cut it.
  if (findings > 0) {
    out.push(
      '',
      `${findings} memory lint finding(s): run \`node .claude/skills/memory/lint.mjs\` to list them, as proposals.`,
    )
  }

  if (sections.length > 0) {
    out.push('', `Types in use: ${sections.map((s) => `${s.type} (${s.lines.length})`).join(', ')}`)
    for (const section of sections) {
      out.push('', `## ${section.type}`, '', ...section.lines.map(strip))
    }
  }

  if (personal.length > 0) {
    out.push('', '## personal (this machine only, never committed)', '')
    for (const { path, title, description } of personal) {
      const line = `- [[${path}|${title}]]${description ? ` — ${description}` : ''}`
      out.push(strip(line))
    }
  }

  // After the expiry, so dropping descriptions over the cap keeps it.
  if (scratch.length > 0) {
    out.push('', '## scratch (this machine only, deleted once expired)', '')
    for (const { path, title, description, expires, ends } of scratch) {
      const until = ends === null ? 'no valid `expires`, never deleted' : `expires ${expires}`
      const line = `- [[${path}|${title}]] (${until})${description ? ` — ${description}` : ''}`
      out.push(strip(line))
    }
  }

  // Memories exist but nothing has generated the index for them — a vault
  // whose `.holi/memory/` was filled in outside Holi, or one whose index was deleted.
  // Say so rather than printing an overview that silently omits every shared
  // memory. Deliberately NOT a fallback scan: reading and grouping the files
  // here would be a second copy of the indexer, kept in step by nobody.
  if (index === null && shared.length > 0) {
    out.push(
      '',
      `${shared.length} shared memory file(s) are present but \`.holi/memory/index.md\` has not been generated yet. Read \`.holi/memory/\` directly; Holi will write the index on the next commit that touches one.`,
    )
  }

  if (logs.length > 0) {
    out.push('', `Work log (this machine): ${logs.join(', ')}. Read it when asked what was done.`)
  }

  const log = recent()
  if (log.length > 0) out.push('', '## recent', '', ...log.map((l) => `- ${l}`))

  // The two older shapes. Only when there is something in one to split: an
  // empty `MEMORY.md` is not worth suggesting work on.
  //
  // `USER.local.md` is auto-loaded by nothing (Claude Code reads `AGENTS.md`,
  // not it) and appears in no index, whereas a `.holi/memory/<name>.local.md` is
  // printed here at the start of every session.
  const legacy = ['MEMORY.md', 'USER.local.md'].filter((name) => {
    const text = readOr(join(root, name))
    return text !== null && text.trim() !== ''
  })
  if (legacy.length > 0) {
    out.push(
      '',
      `This vault also has ${legacy.map((n) => `\`${n}\``).join(' and ')} in the older shape. Still read, never moved unasked; worth splitting into \`.holi/memory/\` when the user asks.`,
    )
  }

  return `${out.join('\n')}\n`
}

let text = render({ descriptions: true })
if (text.length > CAP) text = render({ descriptions: false })
if (text.length > CAP) {
  // Last resort, and it still names where the rest is rather than stopping dead.
  const pointer = '\n…truncated. The whole list is in `.holi/memory/index.md`.\n'
  text = text.slice(0, CAP - pointer.length) + pointer
}

process.stdout.write(text)
process.exit(0)
