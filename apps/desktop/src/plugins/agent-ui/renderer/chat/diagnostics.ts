/**
 * What "Copy diagnostics" puts on the clipboard when a conversation holds
 * parts this build could not place: signatures and counts, and the Claude
 * Code version that wrote them. Never a word of the conversation.
 */
import type { ChatItem } from '../../../agent/renderer/chat/items'

export interface Shapes {
  total: number
  shapes: { shape: string; count: number }[]
}

const MAX_SHAPES = 40
const MAX_SHAPE = 160

function listShapes(shapes: Shapes['shapes']): string[] {
  const lines = shapes
    .slice(0, MAX_SHAPES)
    .map(({ shape, count }) => `- ${String(shape).slice(0, MAX_SHAPE)} x${count}`)
  if (shapes.length > MAX_SHAPES) lines.push(`- … and ${shapes.length - MAX_SHAPES} more`)
  return lines
}

/** The Claude Code versions that wrote lines this build did not know. */
export function claudeVersions(items: readonly ChatItem[]): string[] {
  const seen = new Set<string>()
  for (const item of items) {
    if (item.kind === 'unknown' && typeof item.version === 'string' && item.version !== '') {
      seen.add(item.version.slice(0, 40))
    }
  }
  return [...seen]
}

/** What the reader could not place: the signatures it has no rule for, and the
 *  lines it could not read at all. */
export interface Unplaced {
  unknownShapes: Shapes['shapes']
  oversize?: number
  unparseable?: number
}

const count = (n: number | undefined): number => (typeof n === 'number' && n > 0 ? n : 0)

/** How many parts of the conversation the reader could not place. */
export function unplacedTotal(drift: Unplaced): number {
  return (
    drift.unknownShapes.reduce((sum, u) => sum + count(u.count), 0) +
    count(drift.oversize) +
    count(drift.unparseable)
  )
}

export function chatDiagnostics(args: {
  drift: Unplaced
  failed: Shapes
  versions: readonly string[]
}): string {
  const lines = ['Holi chat diagnostics']
  if (args.versions.length > 0) lines.push(`Claude Code: ${args.versions.join(', ')}`)
  lines.push(`Parts not recognised: ${unplacedTotal(args.drift)}`)
  lines.push(...listShapes(args.drift.unknownShapes))
  if (count(args.drift.oversize) > 0) lines.push(`Lines too large to read: ${args.drift.oversize}`)
  if (count(args.drift.unparseable) > 0)
    lines.push(`Lines that were not JSON: ${args.drift.unparseable}`)
  if (args.failed.total > 0) {
    lines.push(`Parts that could not be drawn: ${args.failed.total}`)
    lines.push(...listShapes(args.failed.shapes))
  }
  return lines.join('\n')
}
