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
  ListTodo,
  Settings2,
  Table,
  AtSign,
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
  'holi-person': AtSign,
}
