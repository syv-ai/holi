/**
 * MCP tools (`mcp__<server>__<tool>`) and the browser's. An MCP server's result
 * is usually JSON inside text, so a result that parses and is small enough is
 * drawn as a tree; anything else is text. Inputs can be enormous or binary
 * (`attach_file.content_base64`, a flow's nodes): the card shows the plain ones
 * and says "N items" for the rest, never the bytes.
 */
import { Globe, Plug } from 'lucide-react'
import type { ToolItem } from '../../../../../agent/renderer/public'
import type { ToolRenderer } from '../registry'
import {
  argsOf,
  arr,
  firstLine,
  firstStr,
  isRec,
  nameOf,
  parseJson,
  textOf,
  unwrap,
} from './coerce'
import { firstInput, humanName, parseMcp, readableInput } from './generic'
import { JsonTree } from './JsonTree'
import { Caption, CodeBlock, ErrorPane, ImageChips, Stack } from './parts'
import { stateOf, type CardView } from './view'

/** A result that is JSON and small enough to open as a tree. */
const TREE_LIMIT = 8 * 1024

/** The plain inputs as `key: value` lines; the rest as a count. */
function Inputs({ item, max = 8 }: { item: ToolItem; max?: number }): React.JSX.Element | null {
  const args = argsOf(item)
  const rows = Object.keys(args)
    .map((key) => ({ key, value: readableInput(key, args[key]) }))
    .filter((row): row is { key: string; value: string } => row.value !== undefined)
  if (rows.length === 0) return null
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs" data-chat-inputs="">
      {rows.slice(0, max).map((row) => (
        <div key={row.key} className="contents">
          <dt className="text-muted-foreground">{row.key.slice(0, 40)}</dt>
          <dd className="min-w-0 truncate font-mono">{firstLine(row.value).slice(0, 120)}</dd>
        </div>
      ))}
      {rows.length > max && (
        <dd className="col-span-2 text-muted-foreground">{`${rows.length - max} more inputs`}</dd>
      )}
    </dl>
  )
}

function McpResult({ item }: { item: ToolItem }): React.JSX.Element | null {
  const state = stateOf(item)
  if (state === 'error') return <ErrorPane item={item} />
  if (state !== 'done') return null
  const text = unwrap(textOf(item))
  if (text === '') return null
  const parsed = text.length <= TREE_LIMIT ? parseJson(text) : undefined
  if (parsed !== undefined) return <JsonTree value={parsed} />
  return <CodeBlock text={text} lines={40} chars={4000} label="Result" />
}

export const mcpRenderer: ToolRenderer = (item) => {
  const name = nameOf(item)
  if (parseMcp(name) === null) return null
  const state = stateOf(item)
  const view: CardView = {
    label: humanName(name),
    icon: Plug,
    summary: firstInput(item) ?? firstLine(item.summary ?? ''),
    chips: [],
    body: (
      <Stack>
        <Inputs item={item} />
        <McpResult item={item} />
        <ImageChips item={item} />
        {state === 'rejected' && <Caption>Declined: it did not run.</Caption>}
      </Stack>
    ),
  }
  return view
}

/** What a browser action says in one line. */
function browserSummary(tool: string, args: Record<string, unknown>): string | undefined {
  const url = firstStr(args, ['url'])
  if (url !== undefined) return url
  const action = firstStr(args, ['action'])
  if (action !== undefined) {
    const text = firstStr(args, ['text', 'ref'])
    const at = arr(args.coordinate)
    const where = at.length === 2 ? ` at ${String(at[0])}, ${String(at[1])}` : ''
    return `${action}${text === undefined ? '' : ` “${firstLine(text).slice(0, 60)}”`}${where}`
  }
  const query = firstStr(args, ['query', 'text', 'ref', 'pattern'])
  if (query !== undefined) return firstLine(query).slice(0, 100)
  if (tool === 'browser_batch' || tool === 'batch') {
    const steps = arr(args.actions)
    return `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`
  }
  return undefined
}

export const browserRenderer: ToolRenderer = (item) => {
  const name = nameOf(item)
  const mcp = parseMcp(name)
  if (mcp === null) return null
  const args = argsOf(item)
  const state = stateOf(item)
  const steps = arr(args.actions).filter(isRec)
  const text = unwrap(textOf(item))
  const view: CardView = {
    label: `Browser · ${mcp.tool.replace(/_/g, ' ')}`,
    icon: Globe,
    summary: browserSummary(mcp.tool, args) ?? firstInput(item) ?? firstLine(item.summary ?? ''),
    chips: [],
    body: (
      <Stack>
        {steps.length > 0 && (
          <ol className="flex list-decimal flex-col gap-0.5 pl-5 text-xs" data-chat-steps="">
            {steps.slice(0, 10).map((step, i) => (
              <li key={i} className="truncate font-mono">
                {firstStr(step, ['name']) ?? 'step'}
                {isRec(step.input) && browserSummary('', step.input) !== undefined
                  ? ` ${browserSummary('', step.input)}`
                  : ''}
              </li>
            ))}
            {steps.length > 10 && (
              <li className="list-none text-muted-foreground">{`${steps.length - 10} more`}</li>
            )}
          </ol>
        )}
        {steps.length === 0 && <Inputs item={item} max={4} />}
        {state === 'error' ? (
          <ErrorPane item={item} />
        ) : (
          state === 'done' &&
          text !== '' && <CodeBlock text={text} lines={12} chars={1000} label="Result" />
        )}
        <ImageChips item={item} />
        {state === 'rejected' && <Caption>Declined: it did not run.</Caption>}
      </Stack>
    ),
  }
  return view
}
