/**
 * The small ones: Skill, Monitor, Workflow, TaskStop, ToolSearch and
 * StructuredOutput. A chip or two and, behind the card's disclosure, the one
 * block worth reading (a command, a script), clipped.
 */
import { Activity, Square, Workflow as WorkflowIcon, Wand2, Search, Braces } from 'lucide-react'
import type { ToolRenderer } from '../registry'
import {
  argsOf,
  countLabel,
  dataOf,
  firstLine,
  firstStr,
  flag,
  parseJson,
  str,
  strings,
  textOf,
  unwrap,
} from './coerce'
import { Caption, Chip, CodeBlock, ErrorPane, Stack } from './parts'
import { JsonTree } from './JsonTree'
import { stateOf, verb, type CardView } from './view'

export const skillRenderer: ToolRenderer = (item) => {
  const args = argsOf(item)
  const data = dataOf(item)
  const skill = firstStr(args, ['skill', 'name']) ?? firstStr(data, ['commandName'])
  if (skill === undefined) return null
  const state = stateOf(item)
  const extra = str(args.args)
  const forked = firstStr(data, ['status']) === 'forked'
  const view: CardView = {
    label: verb(item, 'Loading skill', 'Used skill'),
    icon: Wand2,
    summary: skill,
    chips: forked ? ['forked'] : [],
    body:
      extra !== undefined && extra.trim() !== '' ? (
        <Stack>
          <CodeBlock text={extra} lines={12} chars={1000} label="Arguments" />
          {state === 'error' && <ErrorPane item={item} />}
        </Stack>
      ) : state === 'error' ? (
        <ErrorPane item={item} />
      ) : null,
  }
  return view
}

export const monitorRenderer: ToolRenderer = (item) => {
  const args = argsOf(item)
  const data = dataOf(item)
  const command = firstStr(args, ['command'])
  const description = firstStr(args, ['description'])
  if (command === undefined && description === undefined) return null
  const state = stateOf(item)
  const taskId = firstStr(data, ['taskId']) ?? /task (\S+?)[,)]/.exec(textOf(item))?.[1]
  const chips: string[] = []
  if (taskId !== undefined) chips.push(`task ${taskId}`)
  if (flag(args.persistent) || flag(data.persistent)) chips.push('persistent')
  const view: CardView = {
    label: verb(item, 'Starting monitor', 'Monitoring'),
    icon: Activity,
    summary: description ?? firstLine(command ?? ''),
    chips,
    body: (
      <Stack>
        {command !== undefined && (
          <CodeBlock text={command} lines={12} chars={1000} label="Command" />
        )}
        {state === 'error' && <ErrorPane item={item} />}
      </Stack>
    ),
  }
  return view
}

export const workflowRenderer: ToolRenderer = (item) => {
  const args = argsOf(item)
  const data = dataOf(item)
  const name = firstStr(data, ['workflowName']) ?? firstStr(args, ['scriptPath', 'name'])
  const script = firstStr(args, ['script'])
  if (name === undefined && script === undefined) return null
  const state = stateOf(item)
  const taskId = firstStr(data, ['taskId', 'runId'])
  const summary = firstStr(data, ['summary'])
  const chips: string[] = []
  if (taskId !== undefined) chips.push(`task ${taskId}`)
  const status = firstStr(data, ['status'])
  if (status !== undefined) chips.push(status.replace(/_/g, ' '))
  const view: CardView = {
    label: verb(item, 'Starting workflow', 'Workflow'),
    icon: WorkflowIcon,
    summary: name ?? firstLine(script ?? ''),
    chips,
    busy: status === 'async_launched' && item.note === undefined,
    body: (
      <Stack>
        {summary !== undefined && <Caption>{summary}</Caption>}
        {script !== undefined && (
          <CodeBlock text={script} lines={30} chars={3000} wrap={false} label="Script" />
        )}
        {state === 'error' && <ErrorPane item={item} />}
      </Stack>
    ),
  }
  return view
}

export const taskStopRenderer: ToolRenderer = (item) => {
  const args = argsOf(item)
  const parsed = parseJson(unwrap(textOf(item)))
  const data = dataOf(item)
  const id = firstStr(args, ['task_id', 'taskId', 'shell_id']) ?? firstStr(data, ['task_id'])
  if (id === undefined) return null
  const command = firstStr(parsed, ['command']) ?? firstStr(data, ['command'])
  const kind = firstStr(parsed, ['task_type']) ?? firstStr(data, ['task_type'])
  const state = stateOf(item)
  const view: CardView = {
    label: verb(item, 'Stopping', 'Stopped'),
    icon: Square,
    summary: command === undefined ? `task ${id}` : firstLine(command),
    chips: [`task ${id}`, ...(kind === undefined ? [] : [kind])],
    body:
      command !== undefined || state === 'error' ? (
        <Stack>
          {command !== undefined && (
            <CodeBlock text={command} lines={12} chars={1000} label="Command" />
          )}
          {state === 'error' && <ErrorPane item={item} />}
        </Stack>
      ) : null,
  }
  return view
}

const CHIPS = 12

export const toolSearchRenderer: ToolRenderer = (item) => {
  const args = argsOf(item)
  const data = dataOf(item)
  const query = firstStr(args, ['query'])
  const matches = strings(data.matches)
  // Without a structured result the names are in the query ("select:A,B").
  const named =
    matches.length > 0
      ? matches
      : (query ?? '').startsWith('select:')
        ? (query ?? '')
            .slice('select:'.length)
            .split(',')
            .map((n) => n.trim())
            .filter((n) => n !== '')
        : []
  if (query === undefined && matches.length === 0) return null
  const state = stateOf(item)
  const count = matches.length > 0 ? matches.length : named.length
  const view: CardView = {
    label: verb(item, 'Looking up tools', 'Loaded tools'),
    icon: Search,
    summary: state === 'done' && count > 0 ? countLabel(count, 'tool') : (query ?? ''),
    chips: [],
    body: (
      <Stack>
        {query !== undefined && !query.startsWith('select:') && <Caption>{query}</Caption>}
        {named.length > 0 && (
          <div className="flex flex-wrap gap-1.5" data-chat-tool-names="">
            {named.slice(0, CHIPS).map((n, i) => (
              <Chip key={i}>{n.replace(/^mcp__/, '').replace(/__/g, ' · ')}</Chip>
            ))}
            {named.length > CHIPS && <Chip>{`+${named.length - CHIPS} more`}</Chip>}
          </div>
        )}
        {state === 'error' && <ErrorPane item={item} />}
      </Stack>
    ),
  }
  return view
}

/** StructuredOutput: the sub-agent's answer in the caller's own schema. */
export const structuredOutputRenderer: ToolRenderer = (item) => {
  const args = argsOf(item)
  const keys = Object.keys(args)
  if (keys.length === 0) return null
  const state = stateOf(item)
  const view: CardView = {
    label: verb(item, 'Returning', 'Returned'),
    icon: Braces,
    summary: keys.slice(0, 4).join(', '),
    chips: [countLabel(keys.length, 'field')],
    body: (
      <Stack>
        <JsonTree value={args} />
        {state === 'error' && <ErrorPane item={item} />}
      </Stack>
    ),
  }
  return view
}
