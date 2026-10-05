/**
 * What a notification says of a conversation, read from the tail of its
 * transcript: the answer that was just given, and the tool call a session is
 * waiting to be allowed to run. Pure.
 */
import type { ChatEntry } from '../agent-cap'

/** The most a preview keeps: a notification is a glance, not the answer. */
const PREVIEW_CHARS = 240

/** Markdown as a line of plain words: no fences, no marks, one space between. */
export function plainPreview(markdown: string): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[>#\-*+\d.\s]+(?=\S)/gm, '')
    .replace(/[*_~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS).trimEnd()}…` : text
}

/** The last thing the agent said, as a preview, or '' when it said nothing. */
export function lastAnswer(entries: readonly ChatEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!
    if (entry.kind === 'assistant') return plainPreview(entry.text)
    // A person's message after it: it has not answered that yet.
    if (entry.kind === 'user') return ''
  }
  return ''
}

/** The call the agent is waiting on, as `Bash: ls`, or '' when it asked
 *  nothing of a tool. */
export function pendingTool(entries: readonly ChatEntry[]): string {
  const done = new Set(entries.flatMap((e) => (e.kind === 'tool-result' ? [e.id] : [])))
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!
    if (entry.kind === 'tool' && !done.has(entry.id)) {
      return entry.summary === '' ? entry.name : `${entry.name}: ${entry.summary}`
    }
  }
  return ''
}
