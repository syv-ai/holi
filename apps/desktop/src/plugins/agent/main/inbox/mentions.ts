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

export function mentionNotice(m: NoteMention): InboxNotice {
  return {
    title: `${commentByline(m.comment)} mentioned you`,
    line: `On "${clip(m.quote, 60)}": ${clip(m.comment.body, 300)}`,
    path: m.notePath,
  }
}
