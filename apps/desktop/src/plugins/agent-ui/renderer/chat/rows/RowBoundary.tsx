/**
 * One row's error boundary: a row that throws while it draws shows a compact
 * "could not be shown" line with its raw item behind a disclosure, and
 * every other row stays. Each failure is counted per conversation, once per
 * item, for the chat's footer (`useRowErrors`).
 */
import { Component, useSyncExternalStore, type ErrorInfo, type ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'
import { Icon } from '@/primitives'
import { RawDisclosure, safeJson } from './parts'

type Scope = string
/** item key -> the shape that failed to draw, by scope (a conversation). */
const failed = new Map<Scope, Map<string, string>>()
const listeners = new Set<() => void>()

export interface RowErrors {
  total: number
  shapes: { shape: string; count: number }[]
}
const NONE: RowErrors = { total: 0, shapes: [] }
let snapshots = new Map<Scope, RowErrors>()

function emit(scope: Scope): void {
  const items = failed.get(scope)
  if (items === undefined || items.size === 0) snapshots.delete(scope)
  else {
    const counts = new Map<string, number>()
    for (const shape of items.values()) counts.set(shape, (counts.get(shape) ?? 0) + 1)
    snapshots.set(scope, {
      total: items.size,
      shapes: [...counts].map(([shape, count]) => ({ shape, count })),
    })
  }
  snapshots = new Map(snapshots)
  for (const l of listeners) l()
}

/** Count a row that failed to draw. The same item failing again (a redraw
 *  after an update) is one failure. */
export function reportRowError(scope: Scope, itemKey: string, shape: string): void {
  let items = failed.get(scope)
  if (items === undefined) failed.set(scope, (items = new Map()))
  if (items.get(itemKey) === shape) return
  items.set(itemKey, shape)
  emit(scope)
}

/** What has failed to draw in a conversation since the page loaded. */
export function rowErrorsOf(scope: Scope): RowErrors {
  return snapshots.get(scope) ?? NONE
}

export function resetRowErrors(scope?: Scope): void {
  if (scope === undefined) {
    failed.clear()
    snapshots = new Map()
    for (const l of listeners) l()
    return
  }
  failed.delete(scope)
  emit(scope)
}

export function useRowErrors(scope: Scope): RowErrors {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => rowErrorsOf(scope),
  )
}

/** A signature for an item: its kind (and a tool's name), never its content. */
export function rowShape(item: unknown): string {
  if (typeof item !== 'object' || item === null) return 'row:none'
  const { kind, name } = item as { kind?: unknown; name?: unknown }
  const k = typeof kind === 'string' ? kind : 'none'
  return k === 'tool' && typeof name === 'string' ? `row:tool:${name}` : `row:${k}`
}

function itemKey(item: unknown): string {
  if (typeof item !== 'object' || item === null) return 'none'
  const { kind, id } = item as { kind?: unknown; id?: unknown }
  return `${String(kind)}:${String(id)}`
}

export interface RowBoundaryProps {
  /** The item drawn: what the fallback shows raw, and what resets the
   *  boundary when it changes (an updated message may draw now). */
  item: unknown
  /** The conversation, for the footer's count. */
  scope?: string
  /** Told the shape of an item that failed to draw. */
  onRowError?: (shape: string) => void
  children: ReactNode
}

interface State {
  error: unknown
  item: unknown
}

export class RowBoundary extends Component<RowBoundaryProps, State> {
  state: State = { error: null, item: this.props.item }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    // A thrown null still counts as a failure.
    return { error: error ?? new Error('Unknown error') }
  }

  static getDerivedStateFromProps(props: RowBoundaryProps, state: State): Partial<State> | null {
    return props.item === state.item ? null : { item: props.item, error: null }
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    const shape = rowShape(this.props.item)
    reportRowError(this.props.scope ?? '', itemKey(this.props.item), shape)
    this.props.onRowError?.(shape)
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children
    return <RowFallback item={this.props.item} />
  }
}

/** The line that stands for a row that could not be drawn. */
export function RowFallback({ item }: { item: unknown }): React.JSX.Element {
  return (
    <div
      role="group"
      data-chat-row="error"
      className="flex flex-col items-start gap-0.5 text-sm text-muted-foreground"
    >
      <span className="flex items-center gap-1.5 px-1">
        <Icon icon={TriangleAlert} size="sm" />
        This part could not be shown
      </span>
      <RawDisclosure raw={() => safeJson(item)} label="Show what it was" />
    </div>
  )
}
