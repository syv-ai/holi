/**
 * Edit and Write. An edit is a diff: Claude Code's hunks when the result has
 * them (`structuredPatch`), else the call's own `old_string` and `new_string`.
 * A written file that is new is its content; one that replaced another is a
 * diff when the hunks are there.
 */
import { FilePlus2, PencilLine } from 'lucide-react'
import type { ToolItem } from '../../../../../agent/renderer/public'
import type { ToolRenderer } from '../registry'
import { argsOf, countLabel, dataOf, firstStr, flag, get, shortPath, str, textOf } from './coerce'
import { Diff, diffFromPatch, diffFromStrings, type DiffModel } from './Diff'
import { CodeBlock, ErrorPane, Stack } from './parts'
import { stateOf, verb, type CardView } from './view'

function pathOf(item: ToolItem): string | undefined {
  return firstStr(argsOf(item), ['file_path', 'path', 'notebook_path'])
}

const churn = (m: DiffModel): string[] =>
  m.added === 0 && m.removed === 0 ? [] : [`+${m.added} −${m.removed}`]

export const editRenderer: ToolRenderer = (item) => {
  const args = argsOf(item)
  const data = dataOf(item)
  const path = pathOf(item)
  const before = str(get(args, 'old_string')) ?? str(get(data, 'oldString'))
  const after = str(get(args, 'new_string')) ?? str(get(data, 'newString'))
  const patch = diffFromPatch(data.structuredPatch)
  if (path === undefined && patch === null && before === undefined && after === undefined) {
    return null
  }
  const state = stateOf(item)
  const model: DiffModel | null =
    patch ??
    (before !== undefined || after !== undefined
      ? diffFromStrings(before ?? '', after ?? '')
      : null)

  const chips: string[] = model === null ? [] : churn(model)
  if (flag(get(args, 'replace_all')) || flag(get(data, 'replaceAll'))) chips.push('all matches')
  if (flag(get(data, 'userModified'))) chips.push('changed by you')

  const view: CardView = {
    label: verb(item, 'Editing', 'Edited'),
    icon: PencilLine,
    summary: path === undefined ? item.summary : shortPath(path),
    chips,
    body: (
      <Stack>
        {state === 'error' && <ErrorPane item={item} />}
        {model !== null && (model.lines.length > 0 || state !== 'error') && <Diff model={model} />}
      </Stack>
    ),
  }
  return view
}

export const writeRenderer: ToolRenderer = (item) => {
  const args = argsOf(item)
  const data = dataOf(item)
  const path = pathOf(item)
  const content =
    str(get(args, 'content')) ?? str(get(args, 'file_text')) ?? str(get(data, 'content'))
  if (path === undefined && content === undefined) return null
  const state = stateOf(item)
  const patch = diffFromPatch(data.structuredPatch)
  const kind = firstStr(data, ['type'])
  // New unless the result says it replaced a file (the text, when there is no
  // structured result: "updated successfully" against "created successfully").
  const updated =
    kind === 'update' || (kind === undefined && /updated successfully/.test(textOf(item)))
  const lines = content === undefined ? 0 : content === '' ? 0 : content.split('\n').length

  const chips: string[] = []
  if (patch !== null) chips.push(...churn(patch))
  else if (content !== undefined) chips.push(countLabel(lines, 'line'))
  if (kind === 'create' || (!updated && state === 'done')) chips.push('new file')

  const view: CardView = {
    label: verb(item, 'Writing', updated ? 'Rewrote' : 'Wrote'),
    icon: updated ? PencilLine : FilePlus2,
    summary: path === undefined ? item.summary : shortPath(path),
    chips,
    body: (
      <Stack>
        {state === 'error' && <ErrorPane item={item} />}
        {patch !== null ? (
          <Diff model={patch} />
        ) : (
          content !== undefined && (
            <CodeBlock text={content} lines={120} chars={6000} wrap={false} label="Content" />
          )
        )}
      </Stack>
    ),
  }
  return view
}
