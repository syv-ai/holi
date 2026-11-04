import { SparklesIcon } from 'lucide-react'

import type { RichTextSlashItem } from './rich-text/rich-text-slash-menu'
import { onEmptyLine } from './agent-trigger'

/** "/ai": the same prompt Space opens, for those who reach for the slash. */
export function askAiSlashItem(open: (pos: number) => void, agent = 'AI'): RichTextSlashItem {
  return {
    id: 'ask-ai',
    group: 'AI',
    title: `Ask ${agent}`,
    hint: 'Write or change this document',
    keywords: ['ai', 'agent', 'write'],
    icon: <SparklesIcon aria-hidden="true" />,
    can: (editor) => editor.isEditable,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run()
      if (onEmptyLine(editor)) open(editor.state.selection.from)
    },
  }
}
