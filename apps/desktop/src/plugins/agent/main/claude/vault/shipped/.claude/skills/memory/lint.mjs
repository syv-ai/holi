#!/usr/bin/env node
// Holi memory lint: what in `.holi/memory/` looks wrong, as proposals the agent
// or the user acts on. It never writes anything. See docs/features/agent-memory.md.
//
// Run it from the vault root:  node .claude/skills/memory/lint.mjs
// The SessionStart overview imports `lintVault` from here and prints only the
// count, so the agent learns there is something to look at without the list
// being paid for in every session.
//
// Deterministic and dependency-free (`node:` builtins only), like the hooks:
// Claude Code runs it, not Holi, so it must work in any Claude Code. That is
// also why it reads frontmatter without a YAML parser, the way the overview
// does: it only needs to know whether three one-line keys are there.

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MEMORY_DIR = '.holi/memory'
const MEMORY_INDEX = `${MEMORY_DIR}/index.md`

/**
 * Every memory file, `{ path, text }` with a vault-relative path: each `.md`
 * under `.holi/memory/`, personal ones included, the generated index excluded.
 * Sorted, so the findings come out in the same order every time.
 */
export function readMemoryFiles(root) {
  const out = []
  const walk = (rel) => {
    let names
    try {
      names = readdirSync(join(root, rel))
    } catch {
      return
    }
    for (const name of names) {
      const path = `${rel}/${name}`
      let stat
      try {
        stat = statSync(join(root, path))
      } catch {
        continue
      }
      if (stat.isDirectory()) walk(path)
      else if (name.endsWith('.md') && path !== MEMORY_INDEX) {
        try {
          out.push({ path, text: readFileSync(join(root, path), 'utf8') })
        } catch {
          // Deleted mid-scan: not a finding.
        }
      }
    }
  }
  walk(MEMORY_DIR)
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** `{ block, body }`, or `{ unclosed: true }` for a fence that never closes.
 *  The same fence rule as the indexer's `splitFrontmatter`. */
function splitFrontmatter(text) {
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return { block: null, body: normalized }
  const end = normalized.indexOf('\n---', 3)
  if (end === -1) return { unclosed: true, body: normalized }
  const after = normalized.indexOf('\n', end + 1)
  return {
    block: normalized.slice(4, end + 1),
    body: after === -1 ? '' : normalized.slice(after + 1),
  }
}

/** A top-level key's raw value, or null when the key is absent. */
function rawValue(block, key) {
  const m = new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, 'm').exec(block ?? '')
  return m ? m[1] : null
}

/** A key's value without its quotes, or null when absent or empty. */
function value(block, key) {
  const raw = rawValue(block, key)
  if (raw === null) return null
  const unquoted = raw.replace(/^(["'])(.*)\1$/, '$2').trim()
  return unquoted === '' ? null : unquoted
}

/**
 * An unquoted value YAML rejects. `: ` inside a plain scalar is the one an agent
 * writes by accident ("description: node is broken: use pnpm"), and it is not a
 * small error: the indexer then treats the whole frontmatter as absent, so the
 * memory is filed as `note` with its first sentence as its description.
 */
function breaksYaml(raw) {
  if (raw === null || /^["'|>]/.test(raw)) return false
  return /:(\s|$)/.test(raw)
}

/** The text with fenced code blocks and inline code removed: a wiki-link shown
 *  as an example is not a link. */
function prose(text) {
  let fence = null
  const kept = []
  for (const line of text.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence === null && marker) fence = marker[0]
    else if (fence !== null && marker?.[0] === fence) fence = null
    else if (fence === null) kept.push(line.replace(/`[^`]*`/g, ''))
  }
  return kept.join('\n')
}

/** Wiki-link targets, the grammar of `packages/shared/src/wiki-links.ts`. */
function linkTargets(text) {
  const out = []
  for (const m of prose(text).matchAll(/\[\[([^\]\n]+)\]\]/g)) {
    const body = m[1].trim()
    const pipe = body.indexOf('|')
    const target = (pipe >= 0 ? body.slice(0, pipe) : body).trim()
    if (target !== '') out.push(target)
  }
  return out
}

/** The title the indexer would show: `title`, else the H1, else the filename. */
function titleOf(block, body, path) {
  const h1 = /^\s*#\s+(.+?)\s*$/m.exec(body)?.[1]
  const name = (path.split('/').at(-1) ?? path).replace(/\.md$/i, '').replace(/\.local$/, '')
  return value(block, 'title') ?? h1 ?? name
}

/** Case, punctuation and spacing do not make two memories different. */
function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

const isLocal = (path) => (path.split('/').at(-1) ?? '').includes('.local.')

/**
 * The lint, pure: memory files in, findings out, in a stable order.
 *
 * `exists(path)` answers whether a vault-relative path exists; the caller owns
 * the disk. Each finding is `{ path, kind, message }`, where `kind` is one of
 * `frontmatter`, `broken-link`, `stale` and `duplicate`, and the message says
 * what to do. A finding is a proposal: nothing here is ever applied.
 */
export function lintMemory(files, exists) {
  const findings = []
  const add = (path, kind, message) => findings.push({ path, kind, message })
  const byDescription = new Map()
  const byTitle = new Map()
  const group = (map, key, path) => {
    if (key === '') return
    const list = map.get(key)
    if (list) list.push(path)
    else map.set(key, [path])
  }

  for (const { path, text } of files) {
    const fm = splitFrontmatter(text)
    if (fm.unclosed) {
      add(path, 'frontmatter', 'the frontmatter has no closing `---`, so none of it is read')
    } else if (fm.block === null) {
      add(path, 'frontmatter', 'no frontmatter: add `type` and `description`')
    } else {
      for (const key of ['type', 'description']) {
        if (value(fm.block, key) === null) add(path, 'frontmatter', `no \`${key}\`: add one`)
      }
      for (const key of ['type', 'description', 'title']) {
        if (breaksYaml(rawValue(fm.block, key))) {
          add(
            path,
            'frontmatter',
            `\`${key}\` contains ": " unquoted, which is invalid YAML and hides every key: quote the value`,
          )
        }
      }
    }

    for (const target of new Set(linkTargets(text))) {
      if (!exists(target)) {
        if (target.startsWith(`${MEMORY_DIR}/`)) {
          add(
            path,
            'broken-link',
            `links to \`${target}\`, which does not exist: fix or drop the link`,
          )
        } else {
          add(
            path,
            'stale',
            `refers to \`${target}\`, which is not in the vault: check the fact still holds`,
          )
        }
      } else if (!isLocal(path) && isLocal(target)) {
        add(
          path,
          'broken-link',
          `links to the personal \`${target}\`, which no other clone has: link a shared memory or drop it`,
        )
      }
    }

    if (!fm.unclosed) {
      group(byDescription, normalize(value(fm.block, 'description') ?? ''), path)
      group(byTitle, normalize(titleOf(fm.block, fm.body, path)), path)
    }
  }

  // One finding per group, on its first file, naming the others. A pair with the
  // same description and the same title is reported once.
  const reported = new Set()
  for (const [map, what] of [
    [byDescription, 'description'],
    [byTitle, 'title'],
  ]) {
    for (const paths of map.values()) {
      if (paths.length < 2) continue
      const key = paths.join('\n')
      if (reported.has(key)) continue
      reported.add(key)
      const others = paths
        .slice(1)
        .map((p) => `\`${p}\``)
        .join(', ')
      add(paths[0], 'duplicate', `same ${what} as ${others}: likely one fact, propose merging them`)
    }
  }

  return findings.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** The lint over a vault on disk. */
export function lintVault(root) {
  return lintMemory(readMemoryFiles(root), (path) => existsSync(join(root, path)))
}

/** The findings as the agent reads them. */
export function formatFindings(findings) {
  if (findings.length === 0) return 'No memory lint findings.\n'
  const lines = findings.map((f) => `- ${f.path} (${f.kind}): ${f.message}`)
  return [
    `${findings.length} memory lint finding(s). Proposals, not errors: fix a memory you or the user wrote; for shared memory someone else recorded, propose the change and let the user decide.`,
    '',
    ...lines,
    '',
  ].join('\n')
}

/** Whether this file is the script node was asked to run. Through realpath,
 *  because node resolves symlinks for `import.meta.url` and not for `argv`. */
function runDirectly() {
  try {
    return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

// Run directly, print the list. Imported by the overview, do nothing.
if (runDirectly()) {
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd()
  process.stdout.write(formatFindings(lintVault(root)))
}
