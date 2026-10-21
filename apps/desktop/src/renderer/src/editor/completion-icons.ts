/**
 * The popup's glyphs, the explorer's lucide icons (`composites/file-icons.tsx`)
 * as vanilla `lucide` geometry: a CodeMirror option is plain DOM, so it is
 * drawn with `createElement` rather than a React component. The same package
 * version as `lucide-react`, so the two cannot drift. Size and stroke are CSS
 * (`theme.ts`, from the `--icon-*` tokens).
 */
import { FileText, ListTodo, Settings2, SquareSlash, Table, UserRound, type IconNode } from 'lucide'

export const GLYPHS: Record<string, IconNode> = {
  'holi-note': FileText,
  'holi-list-todo': ListTodo,
  'holi-table': Table,
  'holi-setting': Settings2,
  // A command a plugin added to the slash menu.
  'holi-command': SquareSlash,
  // A vault member, in a comment's `@login`.
  'holi-person': UserRound,
}
