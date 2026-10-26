/**
 * A Holi's settings, after MonoCode's `MonoSettingsDialog` and
 * `MonoFilePages` (MIT, Copyright (c) 2026 Nick; see NOTICE.md): a dialog with
 * three sections on its left. A new Holi is set up in the wizard first.
 *
 * - **General**: its face and name, its model, what it may do without asking,
 *   the documents it takes, and removing it. Each saves as it changes, into
 *   `holi.yaml` in place.
 * - **Soul**: `SOUL.md`, its standing instructions, saved on blur over the
 *   text it opened only; a run or a pull that wrote it since offers theirs or
 *   yours.
 * - **Memory**: `MEMORY.md` one fact a row, each editable or forgotten, a new
 *   one added at the top, and how much of it loads into a run.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { Pencil, Plus, Settings, Sparkles, StickyNote, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { activeRemoteAtom, appModeAtom, cn, openPathAtom } from '@/plugin-api'
import {
  HOLI_COLOURS,
  HOLI_MASCOTS,
  HOLI_MASCOT_LABELS,
  MEMORY_MAX_LINES,
  memoryDate,
  memoryEntry,
  memoryLines,
  withLineEdited,
  withoutLine,
  type HoliMascot,
} from '@holi/shared'
import type { HoliFiles } from './holis-cap'
import {
  failed,
  holiCap,
  holiSettingsAtom,
  holisAtom,
  holisEpochAtom,
  pendingApprovalAtom,
  updateHoliAtom,
  type HoliSummary,
  type SettingsSection,
} from './state'
import { PixelPersona } from '@/composites/pixel-persona/pixel-persona'
import { Button } from '@/components/ui/button'
import { Frame, FramePanel } from '@/components/reui/frame'
import { IconButton } from '@/composites/icon-button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DEFAULT_HOLI_COLOUR } from './parts'

const SECTIONS: { id: SettingsSection; label: string; icon: typeof Settings }[] = [
  { id: 'general', label: 'General', icon: Settings },
  { id: 'soul', label: 'Soul', icon: Sparkles },
  { id: 'memory', label: 'Memory', icon: StickyNote },
]

/** Claude Code's model aliases; anything else stays as the file says. */
const MODELS = [
  { value: 'default', label: 'Default' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
]

/** A group heading and its blurb, then its rows in one frame. */
function Group({
  title,
  blurb,
  children,
}: {
  title: string
  blurb?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5 px-1">
        <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
        {blurb !== undefined && <p className="text-xs text-muted-foreground">{blurb}</p>}
      </div>
      <Frame stacked spacing="sm">
        {children}
      </Frame>
    </section>
  )
}

/** One row of a group: its label and hint, its control on the right. */
function Row({
  label,
  hint,
  control,
  children,
}: {
  label: string
  hint?: string
  control?: React.ReactNode
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <FramePanel>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-sm font-medium">{label}</span>
            {hint !== undefined && <span className="text-xs text-muted-foreground">{hint}</span>}
          </div>
          {control}
        </div>
        {children}
      </div>
    </FramePanel>
  )
}

/** A list of rules or globs, one a line, saved when the field is left. */
function LinesField({
  label,
  value,
  placeholder,
  onSave,
}: {
  label: string
  value: readonly string[]
  placeholder: string
  onSave: (lines: string[]) => void
}): React.JSX.Element {
  const [text, setText] = useState(value.join('\n'))
  useEffect(() => setText(value.join('\n')), [value])
  return (
    <Textarea
      aria-label={label}
      className="min-h-20 font-mono text-xs"
      placeholder={placeholder}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const lines = text
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l !== '')
        if (lines.join('\n') !== value.join('\n')) onSave(lines)
      }}
    />
  )
}

function General({ holi, onError }: { holi: HoliSummary; onError: (m: string) => void }) {
  const update = useSetAtom(updateHoliAtom)
  const remote = useAtomValue(activeRemoteAtom)
  const close = useSetAtom(holiSettingsAtom)
  const approve = useSetAtom(pendingApprovalAtom)
  const setMode = useSetAtom(appModeAtom)
  const openPath = useSetAtom(openPathAtom)
  const [name, setName] = useState(holi.name)
  const [removing, setRemoving] = useState(false)
  useEffect(() => setName(holi.name), [holi.name])

  const save = (edits: Parameters<typeof update>[0]['edits']) =>
    void update({ holi: holi.id, edits }).then((res) => {
      if (!res.ok) onError(res.message)
    })

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-3 pt-2">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" className="h-auto" aria-label="Change its face and colour">
              <span className="py-2">
                <PixelPersona
                  name={holi.mascot ?? 'strategist'}
                  color={holi.color ?? DEFAULT_HOLI_COLOUR}
                  crop="full"
                  scale={2}
                />
              </span>
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-68">
            <ToggleGroup
              type="single"
              size="sm"
              spacing={1}
              aria-label="Face"
              className="grid grid-cols-5"
              value={holi.mascot ?? ''}
              onValueChange={(m) => m !== '' && save({ mascot: m as HoliMascot })}
            >
              {HOLI_MASCOTS.map((m) => (
                <ToggleGroupItem key={m} value={m} aria-label={HOLI_MASCOT_LABELS[m]}>
                  <PixelPersona name={m} color={holi.color ?? DEFAULT_HOLI_COLOUR} still />
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <div className="h-px bg-divider" />
            <ToggleGroup
              type="single"
              size="sm"
              spacing={1}
              aria-label="Colour"
              className="grid grid-cols-6"
              value={holi.color ?? ''}
              onValueChange={(c) => c !== '' && save({ color: c })}
            >
              {HOLI_COLOURS.map((c) => (
                <ToggleGroupItem key={c} value={c} aria-label={`Colour ${c}`}>
                  {/* The Holi's own colour: categorical identity, as data. */}
                  <span
                    className="size-4 rounded-full bg-(--swatch)"
                    style={{ '--swatch': c } as React.CSSProperties}
                  />
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </PopoverContent>
        </Popover>
        <Input
          aria-label="Name"
          className="max-w-60 text-center font-medium"
          maxLength={40}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            if (name.trim() !== '' && name.trim() !== holi.name) save({ name: name.trim() })
            else setName(holi.name)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
      </div>

      <Group title="Model">
        <Row
          label="Model"
          hint="What it thinks and replies with."
          control={
            <Select
              value={holi.model ?? 'default'}
              onValueChange={(v) => save({ model: v === 'default' ? null : v })}
            >
              <SelectTrigger size="sm" className="w-36" aria-label="Model">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[
                  ...MODELS,
                  ...(holi.model !== undefined && !MODELS.some((m) => m.value === holi.model)
                    ? [{ value: holi.model, label: holi.model }]
                    : []),
                ].map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <Row
          label="Permissions"
          hint="What it may do without asking, one Claude Code rule a line. Everything else asks you."
        >
          <LinesField
            label="Permissions"
            value={holi.allow ?? []}
            placeholder={'Edit(tilbud/**)\nBash(holi google read:*)'}
            onSave={(allow) => save({ allow })}
          />
        </Row>
      </Group>

      <Group title="Documents" blurb="What it can be sent from a document's Agent menu.">
        <Row
          label="Takes"
          hint="Vault paths, one a line, like kunder/**/*.md. Empty: any document."
        >
          <LinesField
            label="Documents it takes"
            value={holi.accepts ?? []}
            placeholder="kunder/**/*.md"
            onSave={(accepts) => save({ accepts })}
          />
        </Row>
      </Group>

      <Group title="On this machine">
        <Row
          label="Approval"
          hint={
            holi.status === 'approved'
              ? 'Approved here: sends run at once.'
              : holi.status === 'changed'
                ? 'Changed since you approved it here.'
                : 'Not approved here yet.'
          }
          control={
            holi.status === 'approved' || holi.status === 'invalid' ? undefined : (
              <Button size="xs" variant="secondary" onClick={() => approve({ holi })}>
                Review and approve
              </Button>
            )
          }
        />
        <Row
          label="Its file"
          hint={holi.path}
          control={
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                close(null)
                setMode('documents')
                void openPath(holi.path)
              }}
            >
              Open
            </Button>
          }
        />
      </Group>

      <Group title="Remove">
        <Row
          label={`Remove ${holi.name}`}
          hint="Its folder leaves the vault, soul and memory with it. Git keeps the history."
          control={
            removing ? (
              <div className="flex items-center gap-1">
                <Button size="xs" variant="ghost" onClick={() => setRemoving(false)}>
                  Cancel
                </Button>
                <Button
                  size="xs"
                  variant="destructive"
                  onClick={() => {
                    if (remote === null) return
                    void holiCap.remove(remote, { holi: holi.id }).then(
                      () => close(null),
                      (err: unknown) => onError(failed(err).message),
                    )
                  }}
                >
                  Remove
                </Button>
              </div>
            ) : (
              <Button size="xs" variant="ghost" onClick={() => setRemoving(true)}>
                Remove…
              </Button>
            )
          }
        />
      </Group>
    </div>
  )
}

/** Its soul and memory as read, and what is on disk when a save found a run
 *  had written since. */
function useFiles(holi: HoliSummary) {
  const remote = useAtomValue(activeRemoteAtom)
  const epoch = useAtomValue(holisEpochAtom)
  const [files, setFiles] = useState<HoliFiles | null>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (remote === null) return
    let gone = false
    void holiCap.files(remote, { holi: holi.id }).then(
      (f) => {
        if (!gone) {
          setFiles(f)
          setError(false)
        }
      },
      () => {
        if (!gone) setError(true)
      },
    )
    return () => {
      gone = true
    }
  }, [remote, holi.id, epoch, attempt])
  return { files, error, retry: () => setAttempt((n) => n + 1), remote }
}

function Loading(): React.JSX.Element {
  return (
    <div role="status" aria-label="Loading" className="flex flex-col gap-2">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-40" />
    </div>
  )
}

function ReadError({ retry }: { retry: () => void }): React.JSX.Element {
  return (
    <div role="alert" className="flex items-center gap-2 text-sm text-muted-foreground">
      Could not read its files.
      <Button size="xs" variant="secondary" onClick={retry}>
        Retry
      </Button>
    </div>
  )
}

function Soul({ holi, onError }: { holi: HoliSummary; onError: (m: string) => void }) {
  const { files, error, retry, remote } = useFiles(holi)
  const [text, setText] = useState<string | null>(null)
  const [conflict, setConflict] = useState<{ text: string; hash: string } | null>(null)
  const opened = useRef<string | null>(null)
  // A fresh read replaces the text only while nothing is typed over it.
  useEffect(() => {
    if (files === null) return
    if (text === null || text === files.soul) {
      setText(files.soul)
      opened.current = files.soulHash
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files])

  if (!holi.folder) {
    return (
      <p className="text-sm text-muted-foreground">
        {holi.name} is an older single-file Holi: its soul is the `instructions` in {holi.path}.
        Edit it there.
      </p>
    )
  }
  if (error) return <ReadError retry={retry} />
  if (files === null || text === null) return <Loading />

  const save = (body: string, expected: string) => {
    if (remote === null) return
    void holiCap.save(remote, { holi: holi.id, file: 'soul', text: body, expected }).then(
      (res) => {
        if (res.ok) {
          opened.current = res.hash
          setConflict(null)
        } else setConflict({ text: res.text, hash: res.hash })
      },
      (err: unknown) => onError(failed(err).message),
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Who it is, and what it should always keep in mind. A run reads it first; changing it asks
        for approval again on each machine.
      </p>
      {conflict !== null && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
          <span className="min-w-0 flex-1 text-muted-foreground">
            It changed while you were editing.
          </span>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              setText(conflict.text)
              opened.current = conflict.hash
              setConflict(null)
            }}
          >
            Use theirs
          </Button>
          <Button size="xs" variant="secondary" onClick={() => save(text, conflict.hash)}>
            Keep mine
          </Button>
        </div>
      )}
      <Textarea
        aria-label="Soul"
        className="min-h-72 flex-1 font-mono text-sm"
        placeholder="Who it is, and what it should always keep in mind"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (opened.current !== null && text !== files.soul && conflict === null) {
            save(text, opened.current)
          }
        }}
      />
    </div>
  )
}

function Memory({ holi, onError }: { holi: HoliSummary; onError: (m: string) => void }) {
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

export function HoliSettingsDialog(): React.JSX.Element | null {
  const open = useAtomValue(holiSettingsAtom)
  const setOpen = useSetAtom(holiSettingsAtom)
  const holis = useAtomValue(holisAtom)
  const [error, setError] = useState<string | null>(null)
  const holi = open === null ? undefined : holis.find((h) => h.id === open.id)
  if (open === null || holi === undefined) return null

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (next) return
        setError(null)
        setOpen(null)
      }}
    >
      <DialogContent className="sm:max-w-6xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{holi.name} settings</DialogTitle>
        </DialogHeader>
        <div className="flex h-170 min-h-0 gap-6">
          <nav aria-label="Settings" className="flex w-40 shrink-0 flex-col gap-0.5">
            {SECTIONS.map((s) => (
              <Button
                key={s.id}
                variant="ghost"
                className="justify-start text-nav font-medium text-muted-foreground hover:bg-foreground/5 hover:text-foreground aria-[current=page]:bg-foreground/10 aria-[current=page]:text-foreground"
                aria-current={open.section === s.id ? 'page' : undefined}
                onClick={() => setOpen({ id: holi.id, section: s.id })}
              >
                <s.icon className="size-3.5" />
                {s.label}
              </Button>
            ))}
          </nav>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain pe-1">
            {error !== null && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {open.section === 'general' ? (
              <General holi={holi} onError={setError} />
            ) : open.section === 'soul' ? (
              <Soul holi={holi} onError={setError} />
            ) : (
              <Memory holi={holi} onError={setError} />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
