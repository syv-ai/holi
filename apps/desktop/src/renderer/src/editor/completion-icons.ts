/**
 * The popup's glyphs, the explorer's lucide icons (`composites/file-icons.tsx`)
 * as vanilla `lucide` geometry: a CodeMirror option is plain DOM, so it is
 * drawn with `createElement` rather than a React component. The same package
 * version as `lucide-react`, so the two cannot drift. Size and stroke are CSS
 * (`theme.ts`, from the `--icon-*` tokens).
 */
import {
  Circle,
  CircleCheck,
  CircleDot,
  FileText,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Settings2,
  SquareCode,
  Table,
  TableOfContents,
  TextQuote,
  Type,
  type IconNode,
} from 'lucide'

export const GLYPHS: Record<string, IconNode> = {
  'holi-note': FileText,
  // The explorer's `TaskIcon` vocabulary.
  'holi-task-todo': Circle,
  'holi-task-doing': CircleDot,
  'holi-task-done': CircleCheck,
  'holi-list-todo': ListTodo,
  'holi-table': Table,
  'holi-setting': Settings2,
  // The slash menu's blocks, ReUI's glyphs (`slash.ts`).
  'holi-block-text': Type,
  'holi-block-heading-1': Heading1,
  'holi-block-heading-2': Heading2,
  'holi-block-heading-3': Heading3,
  'holi-block-bullet-list': List,
  'holi-block-numbered-list': ListOrdered,
  'holi-block-task-list': ListTodo,
  'holi-block-quote': TextQuote,
  'holi-block-code-block': SquareCode,
  'holi-block-divider': Minus,
  'holi-block-table': Table,
  'holi-block-contents': TableOfContents,
}
