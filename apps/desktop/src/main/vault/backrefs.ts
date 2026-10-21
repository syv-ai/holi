/**
 * The vault's link scans: what links to a path, for the delete preview and
 * rename, and both directions of one file's links for the links drawer. There
 * is no link index: a grep across the vault's markdown is enough
 * for an interactive one-shot, and it cannot drift out of sync the way an
 * index can (docs/features/wiki-links.md).
 *
 * A note linking to *itself* is not a backref, so the target file is excluded.
 */
import { readFile } from 'node:fs/promises'
import { fileKind, parseWikiLinks, wikiLinksToText } from '@holi/shared'
import { listFiles } from './vault-files'

/** A note, as the snapshot scanner counts one: a `.md` file. The one markdown
 *  test every scan here makes. */
const isNote = (path: string): boolean => path.endsWith('.md')

/** Every markdown file in the vault with its text, in walk order, skipping the
 *  paths `skip` names and any file that cannot be read. The one walk every
 *  scan here makes; `paths` is the vault's file list when the caller already
 *  has it. */
export async function* markdownFiles(
  root: string,
  skip: (path: string) => boolean = () => false,
  paths?: readonly string[],
): AsyncGenerator<{ path: string; text: string }> {
  for (const path of paths ?? (await listFiles(root))) {
    if (!isNote(path) || skip(path)) continue
    const text = await readFile(`${root}/${path}`, 'utf8').catch(() => null)
    if (text !== null) yield { path, text }
  }
}

/** Files that reference `target`, with how many times each does, sorted by
 *  path so the result is stable and testable. */
export async function scanBackrefs(
  root: string,
  target: string,
): Promise<{ path: string; count: number }[]> {
  return scanBackrefsMany(root, [target])
}

/**
 * Files OUTSIDE `targets` that link INTO the set, with how many such links each
 * has: the delete preview for a folder or multi-selection.
 *
 * Links that ORIGINATE from within the set are excluded: an internal link
 * between two notes being deleted together is not a tombstone anyone is left
 * with, so counting it would over-warn.
 */
export async function scanBackrefsMany(
  root: string,
  targets: string[],
): Promise<{ path: string; count: number }[]> {
  const set = new Set(targets)
  const out: { path: string; count: number }[] = []
  for await (const { path, text } of markdownFiles(root, (p) => set.has(p))) {
    const count = parseWikiLinks(text).filter((link) => set.has(link.target)).length
    if (count > 0) out.push({ path, count })
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

/** A note a file links to, once per target in first-seen order. */
export interface OutgoingLink {
  target: string
  /** The first link's explicit label, if it had one. */
  label?: string
  /** How many times the file links there. */
  count: number
  /** Whether the target is a file in the vault now. */
  exists: boolean
}

/** One line of another file that links to the scanned one. */
export interface Backlink {
  path: string
  /** 1-based. */
  line: number
  /** The line, links read as their text, trimmed and capped. */
  snippet: string
}

const SNIPPET_MAX = 160

/** An asset a link can point at: an image, a PDF, an office document. Such a
 *  link embeds or attaches a file; it is not a link between notes. */
const isAsset = (path: string): boolean => {
  const kind = fileKind(path)
  return kind === 'image' || kind === 'pdf' || kind === 'doc'
}

/**
 * Both directions of one file's links, in one walk: what it links to, and
 * every line elsewhere that links to it. A link to an asset is not an outgoing
 * link. Any other target is, whatever it looks like (`[[note]]` with no
 * extension included), and says whether it exists, as its chip does.
 *
 * `path`'s own text is read off disk, so an edit shows once autosave has
 * written it.
 */
export async function scanLinks(
  root: string,
  path: string,
): Promise<{ outgoing: OutgoingLink[]; backlinks: Backlink[] }> {
  const paths = await listFiles(root)
  const outgoing = new Map<string, OutgoingLink>()
  const backlinks: Backlink[] = []
  for await (const file of markdownFiles(root, undefined, paths)) {
    if (file.path === path) {
      for (const link of parseWikiLinks(file.text)) {
        if (isAsset(link.target)) continue
        const seen = outgoing.get(link.target)
        if (seen) seen.count++
        else
          outgoing.set(link.target, {
            target: link.target,
            ...(link.label !== undefined && { label: link.label }),
            count: 1,
            exists: false,
          })
      }
      continue
    }
    if (!file.text.includes(path)) continue
    file.text.split('\n').forEach((text, i) => {
      if (!parseWikiLinks(text).some((link) => link.target === path)) return
      const plain = wikiLinksToText(text).trim()
      backlinks.push({
        path: file.path,
        line: i + 1,
        snippet: plain.length > SNIPPET_MAX ? `${plain.slice(0, SNIPPET_MAX - 1)}…` : plain,
      })
    })
  }
  const files = new Set(paths)
  for (const link of outgoing.values()) link.exists = files.has(link.target)
  backlinks.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
  return { outgoing: [...outgoing.values()], backlinks }
}

/** The most notes the graph view draws. A force layout over more is slow to
 *  settle and unreadable as a picture; past it, the best-connected notes are
 *  kept, since an orphan says the least. */
export const GRAPH_NODE_CAP = 1500

/** The vault's notes and the resolved links between them, undirected. */
export interface LinkGraph {
  /** Note paths, sorted. */
  nodes: string[]
  /** Pairs of indexes into `nodes`, each pair once whichever way it links. */
  edges: [number, number][]
  /** How many notes there were before the cap. */
  total: number
}

/**
 * The whole link graph in one walk: every markdown file `include` admits is a
 * node, every wiki-link between two of them an edge. A link to a note that does
 * not exist, to an asset, or to itself is not an edge. Built per ask and held
 * by nobody: there is no link index to go stale.
 */
export async function buildLinkGraph(
  root: string,
  include: (path: string) => boolean = () => true,
): Promise<LinkGraph> {
  const targets = new Map<string, string[]>()
  for await (const { path, text } of markdownFiles(root, (p) => !include(p))) {
    targets.set(
      path,
      parseWikiLinks(text).map((link) => link.target),
    )
  }
  const seen = new Set<string>()
  const pairs: [string, string][] = []
  const degree = new Map<string, number>()
  for (const [from, tos] of targets) {
    for (const to of tos) {
      if (to === from || !targets.has(to)) continue
      const key = from < to ? `${from}\n${to}` : `${to}\n${from}`
      if (seen.has(key)) continue
      seen.add(key)
      pairs.push([from, to])
      degree.set(from, (degree.get(from) ?? 0) + 1)
      degree.set(to, (degree.get(to) ?? 0) + 1)
    }
  }
  let nodes = [...targets.keys()]
  if (nodes.length > GRAPH_NODE_CAP) {
    nodes = nodes
      .sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || a.localeCompare(b))
      .slice(0, GRAPH_NODE_CAP)
  }
  nodes.sort((a, b) => a.localeCompare(b))
  const index = new Map(nodes.map((n, i) => [n, i]))
  const edges: [number, number][] = []
  for (const [a, b] of pairs) {
    const i = index.get(a)
    const j = index.get(b)
    if (i !== undefined && j !== undefined) edges.push([i, j])
  }
  return { nodes, edges, total: targets.size }
}
