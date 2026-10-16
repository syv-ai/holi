/**
 * A JSON value as a tree you can open and close: keys muted, strings clipped,
 * the top level open. A tool's JSON can be huge, so the tree is built first as
 * a bounded model (at most `BUDGET` nodes, never nested past `DEPTH`) that says
 * how many it left out, and only then drawn.
 */
import { useMemo } from 'react'
import { isRec } from './coerce'

const BUDGET = 300
const DEPTH = 6
const STRING = 300

interface Leaf {
  name: string | null
  text: string
  children?: undefined
}
interface Branch {
  name: string | null
  /** `{3 keys}` or `[2 items]`. */
  text: string
  children: Model[]
}
type Model = Leaf | Branch

function scalar(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value.length > STRING ? `${value.slice(0, STRING)}…` : value)
  }
  if (typeof value === 'bigint') return value.toString()
  return JSON.stringify(value) ?? String(value)
}

/** The model of a value within a budget; `skipped` counts what did not fit. */
export function buildTree(value: unknown): { root: Model; skipped: number } {
  let left = BUDGET
  let skipped = 0
  const build = (name: string | null, v: unknown, depth: number): Model | null => {
    if (left <= 0) {
      skipped++
      return null
    }
    left--
    if (!Array.isArray(v) && !isRec(v)) return { name, text: scalar(v) }
    const entries: [string, unknown][] = Array.isArray(v)
      ? v.map((item, i) => [String(i), item])
      : Object.entries(v)
    const text = Array.isArray(v)
      ? `[${entries.length} ${entries.length === 1 ? 'item' : 'items'}]`
      : `{${entries.length} ${entries.length === 1 ? 'key' : 'keys'}}`
    if (depth >= DEPTH) return { name, text: entries.length === 0 ? text : `${text} …` }
    const children: Model[] = []
    for (const [key, child] of entries) {
      const node = build(key, child, depth + 1)
      if (node !== null) children.push(node)
    }
    return { name, text, children }
  }
  return { root: build(null, value, 0) ?? { name: null, text: '…' }, skipped }
}

function Node({ node, depth }: { node: Model; depth: number }): React.JSX.Element {
  const label =
    node.name === null ? null : (
      <span className="text-muted-foreground">{node.name.slice(0, 60)}: </span>
    )
  if (node.children === undefined || node.children.length === 0) {
    const empty = node.children !== undefined
    return (
      <div className="min-w-0 break-words whitespace-pre-wrap">
        {label}
        <span className={empty ? 'text-muted-foreground' : undefined}>{node.text}</span>
      </div>
    )
  }
  return (
    <details open={depth < 1} data-json-node="">
      <summary className="cursor-pointer select-none">
        {label}
        <span className="text-muted-foreground">{node.text}</span>
      </summary>
      <div className="flex flex-col gap-0.5 pl-3">
        {node.children.map((child, i) => (
          <Node key={i} node={child} depth={depth + 1} />
        ))}
      </div>
    </details>
  )
}

export function JsonTree({ value }: { value: unknown }): React.JSX.Element {
  const { root, skipped } = useMemo(() => buildTree(value), [value])
  return (
    <div
      className="max-h-80 overflow-auto rounded-lg bg-muted/40 px-2.5 py-2 font-mono text-xs [content-visibility:auto] [contain-intrinsic-size:auto_8rem]"
      data-chat-json=""
    >
      <Node node={root} depth={0} />
      {skipped > 0 && (
        <div className="pt-1 text-muted-foreground">{`${skipped}+ more not shown`}</div>
      )}
    </div>
  )
}
