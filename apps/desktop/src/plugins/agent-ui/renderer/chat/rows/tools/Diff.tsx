/**
 * A unified diff for an Edit or a Write, in about eighty lines of our own: Claude
 * Code already gives hunks (`structuredPatch`), and when a call has no
 * structured result the diff is built from `old_string` and `new_string`. No
 * diff library, no highlighter: line gutters, added and removed lines by
 * background, and a clip at 150 lines with "Show all".
 */
import { useState } from 'react'
import { Button } from '@/primitives'
import { cn } from '@/plugin-api'
import { arr, isRec, num } from './coerce'

export type DiffLine =
  { kind: 'add' | 'del' | 'ctx'; text: string; oldNo?: number; newNo?: number } | { kind: 'gap' }

export interface DiffModel {
  lines: DiffLine[]
  added: number
  removed: number
  /** Lines have numbers in the file (hunks), not just a sign. */
  numbered: boolean
}

/** Past this many rows even "Show all" stops: the rest is a count. */
const HARD_CAP = 2000

function tally(lines: DiffLine[], numbered: boolean): DiffModel {
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.kind === 'add') added++
    else if (line.kind === 'del') removed++
  }
  return { lines, added, removed, numbered }
}

/** Hunks as Claude Code writes them: `{oldStart, newStart, lines: [' x', '+y', '-z']}`.
 *  Null when the value is not that shape (the caller then diffs the strings). */
export function diffFromPatch(patch: unknown): DiffModel | null {
  const hunks = arr(patch).filter(isRec)
  if (hunks.length === 0) return null
  const lines: DiffLine[] = []
  for (const [i, hunk] of hunks.entries()) {
    const rows = arr(hunk.lines)
    if (rows.length === 0 || rows.some((r) => typeof r !== 'string')) return null
    if (i > 0) lines.push({ kind: 'gap' })
    let oldNo = num(hunk.oldStart) ?? 1
    let newNo = num(hunk.newStart) ?? 1
    for (const row of rows as string[]) {
      const sign = row.charAt(0)
      const text = row.slice(1)
      if (sign === '+') lines.push({ kind: 'add', text, newNo: newNo++ })
      else if (sign === '-') lines.push({ kind: 'del', text, oldNo: oldNo++ })
      else if (sign === '\\') continue
      else lines.push({ kind: 'ctx', text, oldNo: oldNo++, newNo: newNo++ })
    }
  }
  return tally(lines, true)
}

/** What changed between two strings that are the changed region itself: the
 *  common head and tail lines are context, the rest removed then added. */
export function diffFromStrings(before: string, after: string): DiffModel {
  const a = before === '' ? [] : before.split('\n')
  const b = after === '' ? [] : after.split('\n')
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++
  }
  const lines: DiffLine[] = []
  const context = (from: number, to: number): void => {
    for (let i = from; i < to; i++) lines.push({ kind: 'ctx', text: a[i] ?? '' })
  }
  // At most two lines of the untouched head and tail, so the change has a place.
  context(Math.max(0, head - 2), head)
  for (let i = head; i < a.length - tail; i++) lines.push({ kind: 'del', text: a[i] ?? '' })
  for (let i = head; i < b.length - tail; i++) lines.push({ kind: 'add', text: b[i] ?? '' })
  context(a.length - tail, Math.min(a.length, a.length - tail + 2))
  return tally(lines, false)
}

/** A new file: every line added. */
export function diffFromContent(content: string): DiffModel {
  const rows = content === '' ? [] : content.split('\n')
  return tally(
    rows.map((text, i) => ({ kind: 'add' as const, text, newNo: i + 1 })),
    true,
  )
}

const ROW: Record<'add' | 'del' | 'ctx', string> = {
  add: 'bg-(--diff-added)/15',
  del: 'bg-(--diff-removed)/15',
  ctx: '',
}
const SIGN = { add: '+', del: '−', ctx: ' ' } as const

export function Diff({
  model,
  clipAt = 150,
}: {
  model: DiffModel
  clipAt?: number
}): React.JSX.Element {
  const [all, setAll] = useState(false)
  const total = model.lines.length
  const limit = all ? HARD_CAP : clipAt
  const shown = model.lines.slice(0, limit)
  const width = Math.max(
    2,
    ...shown.map((l) => (l.kind === 'gap' ? 0 : String(l.newNo ?? l.oldNo ?? '').length)),
  )
  return (
    <div className="flex flex-col gap-1" data-chat-diff="">
      <div
        className="max-h-[32rem] overflow-auto rounded-lg bg-muted/40 py-1 font-mono text-xs [content-visibility:auto] [contain-intrinsic-size:auto_8rem]"
        role="group"
        aria-label="Changes"
      >
        <div className="w-max min-w-full">
          {shown.map((line, i) =>
            line.kind === 'gap' ? (
              <div
                key={i}
                data-diff-line="gap"
                className="bg-muted/60 px-2 text-muted-foreground select-none"
              >
                ⋯
              </div>
            ) : (
              <div key={i} data-diff-line={line.kind} className={cn('flex', ROW[line.kind])}>
                {model.numbered && (
                  <>
                    <span
                      aria-hidden
                      className="shrink-0 pr-2 pl-2 text-right text-muted-foreground/60 select-none"
                      style={{ minWidth: `${width + 2}ch` }}
                    >
                      {line.kind === 'add' ? '' : (line.oldNo ?? '')}
                    </span>
                    <span
                      aria-hidden
                      className="shrink-0 pr-2 text-right text-muted-foreground/60 select-none"
                      style={{ minWidth: `${width + 1}ch` }}
                    >
                      {line.kind === 'del' ? '' : (line.newNo ?? '')}
                    </span>
                  </>
                )}
                <span aria-hidden className="shrink-0 px-1.5 text-muted-foreground select-none">
                  {SIGN[line.kind]}
                </span>
                <span className="pr-3 whitespace-pre">{line.text === '' ? ' ' : line.text}</span>
              </div>
            ),
          )}
        </div>
      </div>
      {total > clipAt && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Button
            variant="ghost"
            size="xs"
            aria-expanded={all}
            className="text-muted-foreground"
            onClick={() => setAll((v) => !v)}
          >
            {all ? 'Show less' : `Show all (${total - clipAt} more lines)`}
          </Button>
          {all && total > HARD_CAP && <span>{`${total - HARD_CAP} more lines not shown`}</span>}
        </div>
      )}
    </div>
  )
}
