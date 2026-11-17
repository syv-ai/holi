import { Fragment, Slice } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { closeHistory } from '@tiptap/pm/history'
import {
  containerAt,
  graphemeBoundaries,
  logicalLineAt as lineAt,
  STRUCTURAL_CONTAINERS,
} from './rich-text-vim-range'

function cappedCount(count: number) {
  return Math.min(999, Math.max(1, count))
}

type VimRegister = {
  content: Slice
  linewise: boolean
  linewiseTextblock?: 'codeBlock' | 'hardBreak'
  linewiseContainer?: 'listItem' | 'taskItem'
}

export function pasteVimRegister(
  view: EditorView,
  key: 'p' | 'P',
  register: VimRegister,
  count: number,
  editable: () => boolean,
  onFeedback: ((message: string) => void) | undefined,
  updateCount: () => void,
  closeHistoryBoundary: () => void,
) {
  const repetitions = cappedCount(count)
  const content =
    repetitions === 1
      ? register.content
      : new Slice(
          Array.from({ length: repetitions }, () => register.content.content).reduce(
            (combined, fragment) => combined.append(fragment),
            Fragment.empty,
          ),
          register.content.openStart,
          register.content.openEnd,
        )
  const pasteRegister = { ...register, content }
  if (count) updateCount()
  if (editable()) {
    const line = lineAt(view.state, view.state.selection.head)
    const nested = line && containerAt(view.state, line.block.from, STRUCTURAL_CONTAINERS)
    const at =
      pasteRegister.linewise && line
        ? nested
          ? nested.type === 'tableCell' || nested.type === 'tableHeader'
            ? key === 'p'
              ? line.block.to + 1
              : line.block.from - 1
            : key === 'p'
              ? line.block.to
              : line.block.from
          : key === 'p'
            ? line.block.to + 1
            : line.block.from - 1
        : key === 'p' && !pasteRegister.linewise
          ? (graphemeBoundaries(view.state, line?.from ?? 0, line?.to ?? 0).find(
              (at) => at > view.state.selection.head,
            ) ?? view.state.selection.head)
          : view.state.selection.head
    const pos = Math.max(0, Math.min(at, view.state.doc.content.size))
    if (pasteRegister.linewiseContainer) {
      const item = line && containerAt(view.state, line.block.from, ['listItem', 'taskItem'])
      const node = item ? view.state.doc.nodeAt(item.pos) : null
      if (!item || item.type !== pasteRegister.linewiseContainer || !node) {
        onFeedback?.('Vim list register must be pasted into a matching list; no text was changed')
      } else {
        const insertAt = key === 'p' ? item.pos + node.nodeSize : item.pos
        const tr = closeHistory(
          view.state.tr.replaceRange(insertAt, insertAt, pasteRegister.content),
        )
        try {
          tr.doc.check()
          if (!tr.docChanged) throw new Error('empty replacement')
          view.dispatch(
            tr.setSelection(TextSelection.near(tr.doc.resolve(insertAt), 1)).scrollIntoView(),
          )
          closeHistoryBoundary()
          updateCount()
        } catch {
          onFeedback?.('Vim register does not fit at this position; no text was changed')
        }
      }
    } else if (
      line &&
      pasteRegister.linewiseTextblock === 'codeBlock' &&
      line.block.node.type.name === 'codeBlock'
    ) {
      const value = pasteRegister.content.content.textBetween(
        0,
        pasteRegister.content.content.size,
        '\n',
      )
      const insertion = key === 'p' ? `\n${value}` : `${value}\n`
      const atLine = key === 'p' ? line.to : line.from
      const tr = closeHistory(view.state.tr.insertText(insertion, atLine))
      if (tr.docChanged) {
        view.dispatch(
          tr.setSelection(TextSelection.near(tr.doc.resolve(atLine), 1)).scrollIntoView(),
        )
        closeHistoryBoundary()
        updateCount()
      }
    } else if (
      line &&
      pasteRegister.linewiseTextblock === 'hardBreak' &&
      line.block.node.type.name !== 'codeBlock'
    ) {
      const hardBreak = view.state.schema.nodes.hardBreak
      const content = pasteRegister.content.content
      const separator = hardBreak?.create()
      if (separator) {
        const fragment =
          key === 'p'
            ? Fragment.from(separator).append(content)
            : content.append(Fragment.from(separator))
        const atLine = key === 'p' ? line.to : line.from
        const tr = closeHistory(view.state.tr.insert(atLine, fragment))
        try {
          tr.doc.check()
          view.dispatch(
            tr.setSelection(TextSelection.near(tr.doc.resolve(atLine), 1)).scrollIntoView(),
          )
          closeHistoryBoundary()
          updateCount()
        } catch {
          onFeedback?.('Vim register does not fit at this position; no text was changed')
        }
      }
    } else if (line && pasteRegister.linewise && nested) {
      const tr = closeHistory(view.state.tr.replaceRange(pos, pos, pasteRegister.content))
      try {
        tr.doc.check()
        if (!tr.docChanged) throw new Error('empty replacement')
        closeHistoryBoundary()
        view.dispatch(
          tr
            .setSelection(TextSelection.near(tr.doc.resolve(Math.min(pos, tr.doc.content.size)), 1))
            .scrollIntoView(),
        )
        updateCount()
      } catch {
        onFeedback?.('Vim register does not fit at this position; no text was changed')
      }
    } else {
      closeHistoryBoundary()
      const insertion = view.state.tr.replaceRange(pos, pos, pasteRegister.content)
      const tr = closeHistory(insertion)
      try {
        tr.doc.check()
        if (!tr.docChanged) throw new Error('empty replacement')
        view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(pos), 1)).scrollIntoView())
        closeHistoryBoundary()
        updateCount()
      } catch {
        onFeedback?.('Vim register does not fit at this position; no text was changed')
      }
    }
  }
  return true
}
