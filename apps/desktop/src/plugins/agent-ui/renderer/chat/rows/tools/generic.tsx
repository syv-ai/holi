/**
 * The view of a tool nobody wrote a renderer for, and what a renderer falls
 * back to when the call is not shaped as it expected or it throws. It shows
 * what is there: a humanised name, the first plain input, the input as JSON
 * and the result as text, each clipped, pictures as chips, and a note when the
 * transcript already shortened the call. It reads everything defensively and
 * is itself written not to throw.
 */
import { Wrench } from 'lucide-react'
import type { ToolItem } from '../../../../../agent/renderer/chat/items'
import {
  argsOf,
  dataOf,
  firstLine,
  isRec,
  looksBinary,
  nameOf,
  scalarLabel,
  textOf,
  unwrap,
} from './coerce'
import { Caption, CodeBlock, ErrorPane, ImageChips, Stack, imagesOf } from './parts'
import { stateOf, type CardView } from './view'

/** `mcp__server__tool` into its parts; null for any other name. The tool may
 *  contain `_`; a server that contained `__` would be ambiguous, so the raw
 *  name is kept and this is only for display. */
export function parseMcp(name: string): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__')) return null
  const rest = name.slice('mcp__'.length)
  const at = rest.indexOf('__')
  if (at <= 0 || at + 2 >= rest.length) return null
  return { server: rest.slice(0, at), tool: rest.slice(at + 2) }
}

const spaced = (text: string): string => text.replace(/[_]+/g, ' ').trim()

/** "Server · tool" for an MCP tool, the name as written otherwise. */
export function humanName(name: string): string {
  const mcp = parseMcp(name)
  if (mcp !== null) {
    const server = spaced(mcp.server.replace(/^claude_ai_/, ''))
    return `${server} · ${spaced(mcp.tool)}`.slice(0, 80)
  }
  return (spaced(name) || 'Tool').slice(0, 60)
}

const SUMMARY_KEYS = [
  'description',
  'file_path',
  'path',
  'notebook_path',
  'url',
  'query',
  'command',
  'title',
  'name',
  'prompt',
]

const BINARY_KEY = /base64|blob|(^|_)data$|image|bytes/i

/** A plain input to show, never something that is binary or enormous. */
export function readableInput(key: string, value: unknown): string | undefined {
  if (BINARY_KEY.test(key)) return undefined
  const label = scalarLabel(value)
  if (label === undefined || looksBinary(label)) return undefined
  return label
}

/** The first of the usual keys that holds a plain string, else the first
 *  readable scalar of any key. */
export function firstInput(item: ToolItem): string | undefined {
  const args = argsOf(item)
  for (const key of SUMMARY_KEYS) {
    const value = Object.hasOwn(args, key) ? args[key] : undefined
    if (typeof value === 'string' && value.trim() !== '' && !looksBinary(value)) {
      return firstLine(value).slice(0, 100)
    }
  }
  for (const key of Object.keys(args)) {
    const value = args[key]
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      const label = readableInput(key, value)
      if (label !== undefined && label.trim() !== '') return firstLine(label).slice(0, 100)
    }
  }
  return undefined
}

/** JSON for display: indented, with anything binary-ish replaced by a note. */
export function safeJson(value: unknown): string {
  try {
    return (
      JSON.stringify(
        value,
        (key, v: unknown) => {
          if (typeof v === 'bigint') return v.toString()
          if (typeof v === 'string' && (BINARY_KEY.test(key) || looksBinary(v)) && v.length > 200) {
            return `[${v.length} characters of data]`
          }
          return v
        },
        2,
      ) ?? ''
    )
  } catch {
    return ''
  }
}

export function GenericBody({ item }: { item: ToolItem }): React.JSX.Element {
  const state = stateOf(item)
  const args = argsOf(item)
  const data = dataOf(item)
  const text = unwrap(textOf(item))
  const json = Object.keys(args).length > 0 ? safeJson(args) : ''
  const structured = text === '' && Object.keys(data).length > 0 ? safeJson(data) : ''
  const shortened = item?.clipped === true || item?.result?.clipped === true
  return (
    <Stack>
      {json !== '' && <CodeBlock text={json} lines={60} chars={2000} wrap={false} label="Input" />}
      {state === 'error' ? (
        <ErrorPane item={item} />
      ) : (
        state !== 'rejected' &&
        text !== '' && <CodeBlock text={text} lines={60} chars={4000} label="Result" />
      )}
      {state !== 'rejected' && structured !== '' && (
        <CodeBlock text={structured} lines={60} chars={2000} wrap={false} label="Data" />
      )}
      <ImageChips item={item} />
      {shortened && <Caption>The transcript shortened this call.</Caption>}
      {state === 'rejected' && <Caption>Declined: it did not run.</Caption>}
    </Stack>
  )
}

/** The view that always works. */
export function genericView(item: ToolItem): CardView {
  const name = (() => {
    try {
      return nameOf(item)
    } catch {
      return ''
    }
  })()
  let summary = ''
  try {
    summary = firstInput(item) ?? (typeof item?.summary === 'string' ? firstLine(item.summary) : '')
  } catch {
    summary = ''
  }
  const hasBody =
    isRec(item?.args) || typeof item?.result?.text === 'string' || imagesOf(item).length > 0
  return {
    label: humanName(name),
    icon: Wrench,
    summary,
    chips: [],
    body: hasBody ? <GenericBody item={item} /> : null,
  }
}
