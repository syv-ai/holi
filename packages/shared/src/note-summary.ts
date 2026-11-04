/**
 * What a note looks like from the outside, for a view that lists notes rather
 * than opening them (the finder's cards and table): a one-line description,
 * its tags, how long it is, and its first lines as a preview.
 *
 * **Read from the file, never stored.** The description is the frontmatter's
 * `description` when the note has one, because that is the author saying what
 * the note is; otherwise the body's first paragraph. Nothing here is written
 * back, so a summary can never drift from the note.
 *
 * Pure and browser-safe: main runs it over files it reads, and a test runs it
 * over strings.
 */
import { parse as parseYaml } from 'yaml'
import { splitFrontmatter } from './frontmatter'

export interface NoteSummary {
  /** The frontmatter's `description`, else the first paragraph, as plain text. */
  description: string
  /** The frontmatter's `tags`, as written; empty when there are none. */
  tags: string[]
  /** Words in the body, frontmatter excluded. */
  words: number
  /** The body's first lines, markdown kept, for a thumbnail of the page. */
  preview: string
}

/** How much of the body a preview carries: enough to fill a card. */
const PREVIEW_LINES = 12
const PREVIEW_CHARS = 600
/** A description longer than this is cut at a word, with an ellipsis. */
const DESCRIPTION_CHARS = 200

export function summarizeNote(text: string): NoteSummary {
  let yaml: string | null = null
  let body = text
  try {
    ;({ yaml, body } = splitFrontmatter(text))
  } catch {
    // An unclosed fence: the whole file is the body, as the editor shows it.
  }
  const meta = readMeta(yaml)
  const description = clip(meta.description ?? firstParagraph(body), DESCRIPTION_CHARS)
  return {
    description,
    tags: meta.tags,
    words: body.split(/\s+/).filter((w) => /\w/.test(w)).length,
    preview: body.split('\n').slice(0, PREVIEW_LINES).join('\n').slice(0, PREVIEW_CHARS),
  }
}

function readMeta(yaml: string | null): { description?: string; tags: string[] } {
  if (yaml === null) return { tags: [] }
  let data: unknown
  try {
    data = parseYaml(yaml)
  } catch {
    return { tags: [] }
  }
  if (data === null || typeof data !== 'object') return { tags: [] }
  const record = data as Record<string, unknown>
  const description =
    typeof record.description === 'string' && record.description.trim() !== ''
      ? record.description.trim()
      : undefined
  const raw = record.tags
  const tags = Array.isArray(raw)
    ? raw.filter((t): t is string | number => typeof t === 'string' || typeof t === 'number')
    : typeof raw === 'string'
      ? raw.split(',')
      : []
  return {
    ...(description === undefined ? {} : { description }),
    tags: tags.map((t) => String(t).trim()).filter((t) => t !== ''),
  }
}

/** The first paragraph that is prose: not a heading, a list, a quote marker,
 *  a fence or a table, with its inline markdown reduced to text. */
function firstParagraph(body: string): string {
  for (const block of body.split(/\n\s*\n/)) {
    const line = block.trim()
    if (line === '' || /^(#|[-*+] |\d+[.)] |>|```|\||<!--)/.test(line)) continue
    return plain(line.replace(/\s*\n\s*/g, ' '))
  }
  return ''
}

/** Inline markdown to the text it reads as. */
function plain(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|~~|`)/g, '')
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 20)).trimEnd()}…`
}
