/**
 * A comment that mentions the person, as an inbox entry
 * (docs/features/note-comments.md). Core finds them after a pull
 * (`PluginCtx.onMention`); the inbox is where they wait to be read.
 */
import { commentByline } from '@holi/shared'
import type { NoteMention } from '../../../../main/plugin-api'
import type { InboxNotice } from './rules'

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** A GitHub login is at most 39 letters, digits and hyphens. The author is
 *  whatever a teammate's sidecar says, so the title keeps only that. */
const loginOf = (author: string): string =>
  author.replace(/[^A-Za-z0-9-]/g, '').slice(0, 39) || 'Someone'

export function mentionNotice(m: NoteMention): InboxNotice {
  return {
    title: `${commentByline({ ...m.comment, author: loginOf(m.comment.author) })} mentioned you`,
    line: `On "${clip(m.quote, 60)}": ${clip(m.comment.body, 300)}`,
    path: m.notePath,
  }
}
