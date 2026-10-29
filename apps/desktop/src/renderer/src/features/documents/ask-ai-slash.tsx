import { SparklesIcon } from 'lucide-react'

import type { RichTextSlashItem } from './rich-text/rich-text-slash-menu'
import { onEmptyLine } from './agent-trigger'

/** "/ai": the same prompt Space opens, for those who reach for the slash. */
export function askAiSlashItem(open: (pos: number) => void): RichTextSlashItem {
  return {
    id: 'ask-ai',
    group: 'AI',
    title: 'Ask AI',
    hint: 'Have Sonnet write or change the document',
    keywords: ['ai', 'agent', 'write', 'sonnet', 'claude'],
    icon: <SparklesIcon aria-hidden="true" />,
    can: (editor) => editor.isEditable,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run()
      if (onEmptyLine(editor)) open(editor.state.selection.from)
    },
  }
}
