/**
 * A plugin's slash command (a vault app's, docs/features/vault-apps.md) as a
 * row of the document editor's slash menu.
 */
import type { Editor, JSONContent, Range } from '@tiptap/react'
import { SquareSlashIcon } from 'lucide-react'
import { toast } from 'sonner'

import type { RichTextSlashItem } from '@/features/documents/rich-text/rich-text-slash-menu'
import type { SlashCommand } from '@/plugin-api/types'

/**
 * A plugin's command as a slash menu row. Picked, the typed "/query" goes,
 * and the command is given the caret's line and the note; what it answers
 * is written at the caret as markdown, or opens the ask prompt with its
 * instruction written in. A failure leaves the note as it was: its plugin
 * says why where it keeps such things (an app's log), and a toast says the
 * command did not run.
 */
export function pluginSlashItem(
  command: SlashCommand,
  path: string,
  ask: (pos: number, instruction: string) => void,
): RichTextSlashItem {
  return {
    id: `plugin:${command.meta ?? ''}:${command.name}`,
    group: command.meta ?? 'Commands',
    title: command.name,
    hint: command.detail ?? (command.meta ? `From ${command.meta}` : ''),
    keywords: [command.name, ...(command.meta ? [command.meta] : [])],
    icon: <SquareSlashIcon aria-hidden="true" />,
    can: (editor) => editor.isEditable,
    run: (editor, range) => {
      // The line as it was before the command was typed into it.
      const line = lineWithout(editor, range)
      editor.chain().focus().deleteRange(range).run()
      const at = range.from
      command.run({ text: '', line, path }).then(
        (result) => {
          if (result === null || editor.isDestroyed) return
          if ('agent' in result) return ask(at, result.agent)
          const written = 'replace' in result ? result.replace : result.insert
          if (written === '') return
          editor.chain().focus().insertContentAt(at, asContent(editor, written)).run()
        },
        () =>
          toast.error(`/${command.name} did not run`, {
            description: command.meta ? `${command.meta}’s log says why.` : undefined,
          }),
      )
    },
  }
}

/** The caret's block's text with the typed "/query" taken out. */
function lineWithout(editor: Editor, range: Range): string {
  const $from = editor.state.doc.resolve(range.from)
  const text = $from.parent.textContent
  const start = $from.start()
  return text.slice(0, range.from - start) + text.slice(range.to - start)
}

/**
 * Markdown as what to insert at the caret: one paragraph's inline content
 * stays on the caret's line (a number, a bold word, a link), and anything
 * more (a list, two paragraphs) is inserted as its blocks.
 */
function asContent(editor: Editor, markdown: string): JSONContent | JSONContent[] {
  const doc = editor.markdown?.parse(markdown) ?? {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: markdown }] }],
  }
  const blocks = doc.content ?? []
  if (blocks.length === 1 && blocks[0]!.type === 'paragraph') {
    return blocks[0]!.content ?? []
  }
  return blocks
}
