/**
 * Where a markdown file's YAML frontmatter ends and its body begins.
 *
 * One splitter for every reader (tasks, memory, notes, the editor's hidden
 * region, PDF fields) so they all agree on where the block ends. It only finds
 * the fence; parsing the YAML inside is the caller's business.
 */

/** A `---` fence that opens and never closes. */
export class FrontmatterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FrontmatterError'
  }
}

/** `yaml: null` means the file had no frontmatter fence at all, so its body is
 * the whole file. Throws `FrontmatterError` for a fence that is never closed. */
export function splitFrontmatter(text: string): { yaml: string | null; body: string } {
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return { yaml: null, body: normalized.trim() }

  const end = normalized.indexOf('\n---', 3)
  if (end === -1) {
    throw new FrontmatterError('unterminated YAML frontmatter: no closing `---`')
  }
  const yaml = normalized.slice(4, end + 1)
  const afterFence = normalized.indexOf('\n', end + 1)
  const body = afterFence === -1 ? '' : normalized.slice(afterFence + 1)
  return { yaml: yaml.trim() === '' ? null : yaml, body: body.trim() }
}
