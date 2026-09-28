/**
 * `- []` as a task, the way `- [ ]` is. GFM's task list wants the space, and
 * people type the brackets without it, so the line read as a bullet holding
 * `[]`. This is GFM's own `TaskList` rule with a two-character marker: the
 * same `Task` and `TaskMarker` nodes, so the checkbox widget draws it as is.
 * A tick writes `[x]`; unticking writes the canonical `[ ]`.
 */
import type { BlockContext, LeafBlock, LeafBlockParser, MarkdownConfig } from '@lezer/markdown'

class EmptyTaskParser implements LeafBlockParser {
  nextLine(): boolean {
    return false
  }

  finish(cx: BlockContext, leaf: LeafBlock): boolean {
    cx.addLeafElement(
      leaf,
      cx.elt('Task', leaf.start, leaf.start + leaf.content.length, [
        cx.elt('TaskMarker', leaf.start, leaf.start + 2),
        ...cx.parser.parseInline(leaf.content.slice(2), leaf.start + 2),
      ]),
    )
    return true
  }
}

export const emptyTaskMarker: MarkdownConfig = {
  parseBlock: [
    {
      name: 'EmptyTask',
      leaf: (cx, leaf) =>
        /^\[\][ \t]/.test(leaf.content) && cx.parentType().name === 'ListItem'
          ? new EmptyTaskParser()
          : null,
      before: 'TaskList',
    },
  ],
}
