/** The Memory section of a Holi's settings: `MEMORY.md`, a fact a row. */
import { Pencil, Plus, StickyNote, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/plugin-api'
import {
  MEMORY_MAX_LINES,
  memoryDate,
  memoryEntry,
  memoryLines,
  withLineEdited,
  withoutLine,
} from '@holi/shared'
import { holiCap } from './holis-cap'
import { failed, type HoliSummary } from './state'
import { IconButton } from '@/composites/icon-button'
import { Input } from '@/components/ui/input'
import { useFiles } from './use-holi-files'
import { Loading, ReadError } from './holi-settings-parts'

export function Memory({ holi, onError }: { holi: HoliSummary; onError: (m: string) => void }) {
  const { files, error, retry, remote } = useFiles(holi)
  const [adding, setAdding] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ index: number; text: string } | null>(null)

  if (error) return <ReadError retry={retry} />
  if (files === null) return <Loading />
  const lines = memoryLines(files.memory)
  const count = files.memory.split('\n').filter((l) => l.trim() !== '').length
  const dropped = Math.max(0, count - MEMORY_MAX_LINES)

  const write = (next: string) => {
    if (remote === null) return
    void holiCap
      .save(remote, { holi: holi.id, file: 'memory', text: next, expected: files.memoryHash })
      .then(
        (res) => {
          if (!res.ok) onError('Its memory changed meanwhile: look again and redo that.')
          retry()
        },
        (err: unknown) => onError(failed(err).message),
      )
  }
  const tryWrite = (f: () => string) => {
    try {
      write(f())
    } catch (err) {
      onError(failed(err).message)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          What it has learned, one fact a line. Its runs add to it; nothing here is an instruction.
        </p>
        <IconButton label="Remember something" size="icon-xs" onClick={() => setAdding('')}>
          <Plus />
        </IconButton>
      </div>
      {adding !== null && (
        <Input
          autoFocus
          aria-label="Something it should remember"
          placeholder="Something it should remember"
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setAdding(null)
            if (e.key === 'Enter' && adding.trim() !== '') {
              const fact = adding
              setAdding('')
              tryWrite(() => {
                const entry = memoryEntry(fact, memoryDate())
                return `${files.memory.replace(/\s*$/, '')}${files.memory.trim() === '' ? '' : '\n'}${entry}\n`
              })
            }
          }}
          onBlur={() => {
            if (adding.trim() === '') setAdding(null)
          }}
        />
      )}
      {lines.length === 0 && adding === null ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Nothing remembered yet</p>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain">
          {lines.map((line) => (
            <li
              key={line.index}
              className="group/fact flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-foreground/[0.04]"
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-foreground/[0.06]">
                <StickyNote className="size-3.5 text-muted-foreground" />
              </span>
              {editing?.index === line.index ? (
                <Input
                  autoFocus
                  aria-label="Edit fact"
                  value={editing.text}
                  onChange={(e) => setEditing({ index: line.index, text: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setEditing(null)
                    if (e.key === 'Enter') e.currentTarget.blur()
                  }}
                  onBlur={() => {
                    const next = editing.text
                    setEditing(null)
                    if (next.trim() !== '' && next !== line.text) {
                      tryWrite(() => withLineEdited(files.memory, line.index, next, memoryDate()))
                    }
                  }}
                />
              ) : (
                <span className="flex min-w-0 flex-1 flex-col">
                  <span
                    className={cn(
                      'truncate text-sm',
                      line.struck ? 'text-muted-foreground line-through' : 'text-foreground/90',
                    )}
                  >
                    {line.text}
                  </span>
                  {line.date !== undefined && (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {line.date}
                      {line.until === undefined ? '' : ` · until ${line.until}`}
                    </span>
                  )}
                </span>
              )}
              {editing?.index !== line.index && (
                <span className="flex shrink-0 gap-0.5 opacity-0 group-focus-within/fact:opacity-100 group-hover/fact:opacity-100">
                  <IconButton
                    label="Edit"
                    size="icon-xs"
                    onClick={() => setEditing({ index: line.index, text: line.text })}
                  >
                    <Pencil />
                  </IconButton>
                  <IconButton
                    label="Forget"
                    size="icon-xs"
                    onClick={() => tryWrite(() => withoutLine(files.memory, line.index))}
                  >
                    <Trash2 />
                  </IconButton>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-col gap-1">
        <div className="h-px overflow-hidden rounded-full bg-foreground/[0.08]">
          <div
            className={cn(
              'h-full w-(--fill)',
              dropped > 0
                ? 'bg-destructive'
                : count >= MEMORY_MAX_LINES * 0.8
                  ? 'bg-amber-500 dark:bg-amber-400'
                  : 'bg-foreground/40',
            )}
            style={
              {
                '--fill': `${Math.min(100, (count / MEMORY_MAX_LINES) * 100)}%`,
              } as React.CSSProperties
            }
          />
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">
          {dropped > 0 ? `${dropped} lines not loading` : `${count} / ${MEMORY_MAX_LINES} lines`}
          {files.topics.length > 0 && ` · topics: ${files.topics.join(', ')}`}
        </span>
      </div>
    </div>
  )
}
