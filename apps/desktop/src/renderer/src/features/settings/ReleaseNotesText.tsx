/**
 * A release's GitHub notes, rendered (docs/features/updates.md). The notes are
 * someone else's Markdown; `MarkdownText` shows them without ever making HTML.
 */
import { MarkdownText, SettingsNote } from '@/composites'

/** Notes as formatted text, headings, lists, emphasis, code and links. */
export function ReleaseNotesText({ body }: { body: string }): React.JSX.Element {
  if (body.trim() === '') return <SettingsNote>No notes for this version.</SettingsNote>
  return (
    <MarkdownText
      body={body}
      className="max-h-64 space-y-1 overflow-auto text-[11px] text-muted-foreground"
    />
  )
}
