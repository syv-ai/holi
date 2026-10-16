/**
 * ExitPlanMode: the plan, as markdown, open from the start. It is in the call's
 * input, in the structured result and again in the result text, so it is read
 * from the first of those that has it and drawn once.
 */
import { ClipboardList } from 'lucide-react'
import type { ToolRenderer } from '../registry'
import { argsOf, dataOf, firstLine, firstStr } from './coerce'
import { ErrorPane, Markdown, Stack } from './parts'
import { stateOf, type CardView } from './view'

export const planRenderer: ToolRenderer = (item) => {
  const plan = firstStr(argsOf(item), ['plan']) ?? firstStr(dataOf(item), ['plan'])
  if (plan === undefined) return null
  const state = stateOf(item)
  const title = firstLine(plan.replace(/^[\s#>*-]+/, ''))
  const chips =
    state === 'done'
      ? ['approved']
      : state === 'pending'
        ? ['awaiting approval']
        : state === 'rejected'
          ? ['rejected']
          : ['not approved']
  const view: CardView = {
    label: state === 'pending' ? 'Proposing a plan' : 'Plan',
    icon: ClipboardList,
    summary: title,
    chips,
    defaultOpen: true,
    body: (
      <Stack>
        <Markdown text={plan} lines={40} chars={6000} />
        {state === 'error' && <ErrorPane item={item} />}
      </Stack>
    ),
  }
  return view
}
