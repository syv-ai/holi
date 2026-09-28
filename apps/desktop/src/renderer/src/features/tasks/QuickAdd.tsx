/**
 * Quick add (⌘T, and the board dock's New): the card as it will look, filled
 * in place (docs/features/tasks.md). It shows in the board's dock, or centred
 * like the palette anywhere else (`QuickAddHost`).
 *
 * - **The card is the form.** A tall field grows with what you type: the
 *   first line is the title, any further lines the description. Under the
 *   card, a token bar: Lane, Column, Due, Priority, Tags. A token unfolds its
 *   choices beneath the bar.
 * - **Keys set everything.** Tab from the text walks the tokens and back;
 *   ←/→ step the open token's choices and the value follows; Space toggles a
 *   tag; Backspace clears Due or Priority; on Lane, typing finds a folder or
 *   names a new one. Enter adds from anywhere; Escape folds an open token.
 * - **Lane is any folder**, not only a board lane, as the full create allows.
 *   It defaults to the active note's folder.
 * - After an add the text clears and lane and column stay: the next task
 *   usually goes to the same place. On the board, the card flies from the
 *   dock to its cell (a shared `layoutId`, the path it will have).
 */
import type { Priority, Task, TaskStatus } from '@holi/shared'
import { taskFilePath, taskSlug } from '@holi/shared'
import { useAtomValue, useSetAtom } from 'jotai'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { CalendarDays, CircleDashed, CornerDownLeft, Flag, Folder, Hash } from 'lucide-react'
import { useId, useMemo, useRef, useState } from 'react'
import { duePresets, shortStamp } from '@/lib/date-presets'
import {
  Icon,
  PillGroup,
  TaskCheck,
  Textarea,
  Token,
  instant,
  settle,
  type IconGlyph,
  type PillOption,
} from '@/primitives'
import { nowAtom } from '@/state/clock'
import {
  ROOT_LANE,
  createTaskAtom,
  taskCreateFolders,
  taskTagsAtom,
  tasksAtom,
} from '@/state/tasks'
import { activeDocAtom, snapshotAtom } from '@/state/vaults'
import { TaskMeta } from './BoardCard'

const COLUMNS: PillOption<TaskStatus>[] = [
  { value: 'todo', label: 'Todo' },
  { value: 'doing', label: 'Doing' },
  { value: 'done', label: 'Done' },
]
const PRIORITIES: PillOption<Priority>[] = [
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
]
/** The folder options a strip shows at once; typing narrows the rest. */
const FOLDERS_SHOWN = 12

type TokenId = 'lane' | 'status' | 'due' | 'priority' | 'tags'

type Draft = {
  text: string
  folder: string
  status: TaskStatus
  due?: string
  priority?: Priority
  tags: string[]
}

/** First line → title, the rest → description. */
function split(text: string): { title: string; description: string } {
  const [first = '', ...rest] = text.trim().split('\n')
  return { title: first.trim(), description: rest.join('\n').trim() }
}

const folderOf = (path: string) =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ROOT_LANE
const cleanFolder = (folder: string) => folder.trim().replace(/^\/+|\/+$/g, '')
const folderName = (folder: string) => (folder === ROOT_LANE ? 'Vault root' : folder)

/** A step through `values` from `current`, wrapping. */
function stepIn<T>(values: readonly T[], current: T, step: number): T {
  const at = values.indexOf(current)
  const next = ((at === -1 ? (step > 0 ? -1 : 0) : at) + step + values.length) % values.length
  return values[next] as T
}

export function QuickAdd({ flight = false }: { flight?: boolean }): React.JSX.Element {
  const snapshot = useAtomValue(snapshotAtom)
  const activeDoc = useAtomValue(activeDocAtom)
  const tasks = useAtomValue(tasksAtom)
  const allTags = useAtomValue(taskTagsAtom)
  const now = useAtomValue(nowAtom)
  const create = useSetAtom(createTaskAtom)
  const reduced = useReducedMotion() ?? false

  const [draft, setDraft] = useState<Draft>(() => ({
    text: '',
    folder: activeDoc ? folderOf(activeDoc.path) : ROOT_LANE,
    status: 'todo',
    tags: [],
  }))
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))
  const [open, setOpen] = useState<TokenId | null>(null)
  const [laneQuery, setLaneQuery] = useState('')
  const [tagAt, setTagAt] = useState(0)
  /** The preview's layoutId: a draft's own, then, for one add, the path the
   *  new card will have, so the card takes over from the preview mid-air. */
  const draftId = useId()
  const [flightId, setFlightId] = useState(draftId)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const tokenRefs = useRef(new Map<TokenId, HTMLButtonElement>())

  const folders = useMemo(
    () => [
      ROOT_LANE,
      ...taskCreateFolders([
        ...snapshot.docs.map((d) => d.path),
        ...snapshot.tasks.map((t) => t.path),
        ...snapshot.files.map((f) => f.path),
        ...snapshot.broken.map((b) => b.path),
      ]),
    ],
    [snapshot],
  )
  /** Lane's choices: the folders the query matches, and the query itself as
   *  a new folder when nothing is named exactly that. */
  const query = cleanFolder(laneQuery)
  const laneChoices = useMemo(() => {
    const needle = query.toLowerCase()
    const matching = folders.filter((f) => folderName(f).toLowerCase().includes(needle))
    return query && !folders.includes(query) ? [...matching, query] : matching
  }, [folders, query])
  const dues = duePresets(now)

  const { title, description } = split(draft.text)
  const preview = {
    path: '',
    title: title || 'New task',
    status: draft.status,
    due: draft.due,
    priority: draft.priority,
    tags: draft.tags,
    description,
  } as Task

  const submit = async () => {
    if (!title) return
    const folder = cleanFolder(draft.folder)
    // The path the new file will have (main's `freeTaskPath`), so the card can
    // take over the preview's layoutId. A guess that misses costs the flight.
    const taken = new Set([...tasks.keys(), ...snapshot.broken.map((b) => b.path)])
    let predicted = taskFilePath(folder, taskSlug(title))
    for (let n = 2; taken.has(predicted); n++)
      predicted = taskFilePath(folder, `${taskSlug(title)}-${n}`)
    if (flight) setFlightId(predicted)
    const sent = draft
    set({ text: '', due: undefined, priority: undefined, tags: [] })
    setOpen(null)
    textRef.current?.focus()
    try {
      await create({
        title,
        status: sent.status,
        folder,
        ...(description ? { description } : {}),
        extra: {
          ...(sent.due ? { due: sent.due } : {}),
          ...(sent.priority ? { priority: sent.priority } : {}),
          ...(sent.tags.length ? { tags: sent.tags } : {}),
        },
      })
    } catch {
      // Refused (a folder that cannot be, a clash): the draft comes back
      // rather than vanishing with the task.
      setDraft(sent)
    }
    setFlightId(`${draftId}-${predicted}`)
  }

  /** ←/→ on a token: the value follows. */
  const step = (token: TokenId, by: 1 | -1) => {
    if (token === 'lane') set({ folder: stepIn(laneChoices, draft.folder, by) })
    if (token === 'status')
      set({
        status: stepIn(
          COLUMNS.map((c) => c.value),
          draft.status,
          by,
        ),
      })
    if (token === 'due')
      set({ due: stepIn([undefined, ...dues.map((d) => d.value)], draft.due, by) })
    if (token === 'priority')
      set({ priority: stepIn([undefined, ...PRIORITIES.map((p) => p.value)], draft.priority, by) })
    if (token === 'tags' && allTags.length > 0)
      setTagAt((at) => (at + by + allTags.length) % allTags.length)
  }

  const toggleTag = (tag: string) =>
    set({
      tags: draft.tags.includes(tag) ? draft.tags.filter((t) => t !== tag) : [...draft.tags, tag],
    })

  const onTokenKey = (token: TokenId) => (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const { key } = event
    if (key === 'ArrowRight' || key === 'ArrowLeft') {
      event.preventDefault()
      setOpen(token)
      step(token, key === 'ArrowRight' ? 1 : -1)
    } else if (key === 'Enter') {
      event.preventDefault()
      void submit()
    } else if (key === 'Escape' && open !== null) {
      event.preventDefault()
      event.stopPropagation()
      setOpen(null)
    } else if (key === 'Tab' && !event.shiftKey && token === 'tags') {
      // The last token hands back to the text.
      event.preventDefault()
      textRef.current?.focus()
    } else if (key === ' ' && token === 'tags') {
      event.preventDefault()
      const tag = allTags[tagAt]
      if (tag) toggleTag(tag)
    } else if (key === 'Backspace') {
      event.preventDefault()
      if (token === 'due') set({ due: undefined })
      if (token === 'priority') set({ priority: undefined })
      if (token === 'lane') {
        const next = laneQuery.slice(0, -1)
        setLaneQuery(next)
        if (next === '') set({ folder: ROOT_LANE })
      }
    } else if (
      token === 'lane' &&
      key.length === 1 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      // Typing on Lane finds a folder, or names a new one; the value follows
      // the first match.
      event.preventDefault()
      const next = cleanFolder(laneQuery + key)
      setLaneQuery(laneQuery + key)
      const needle = next.toLowerCase()
      const hit = folders.find((f) => folderName(f).toLowerCase().includes(needle))
      set({ folder: hit ?? next })
    }
  }

  const token = (id: TokenId, icon: IconGlyph, label: string, isSet: boolean) => (
    <Token
      key={id}
      ref={(element: HTMLButtonElement | null) => {
        if (element) tokenRefs.current.set(id, element)
        else tokenRefs.current.delete(id)
      }}
      icon={icon}
      label={label}
      set={isSet}
      open={open === id}
      data-token={id}
      onFocus={() => setOpen(id)}
      onClick={() => setOpen((o) => (o === id ? null : id))}
      onKeyDown={onTokenKey(id)}
    />
  )

  return (
    <div className="w-[26rem] max-w-[calc(100vw-2rem)]" data-quick-add="">
      <motion.div
        data-morph-row=""
        layoutId={flight && !reduced ? flightId : undefined}
        transition={reduced ? instant : settle}
        style={{ borderRadius: 12 }}
        className="bg-muted px-2.5 py-2 text-xs"
      >
        <div className="flex items-start gap-2">
          {/* What the card will look like: the check is a picture here. */}
          <span inert aria-hidden className="mt-0.5">
            <TaskCheck filled={false} label="" />
          </span>
          <div className="min-w-0 flex-1">
            <Textarea
              ref={textRef}
              variant="bare"
              autoFocus
              rows={4}
              value={draft.text}
              aria-label="New task"
              placeholder={
                'What needs doing?\nShift+Enter for a new line; lines after the first are the description.'
              }
              onFocus={() => setOpen(null)}
              onChange={(event) => set({ text: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void submit()
                }
                if (event.key === 'Tab' && event.shiftKey) {
                  event.preventDefault()
                  tokenRefs.current.get('tags')?.focus()
                }
              }}
              className="max-h-64 min-h-24 text-sm leading-5"
            />
            <TaskMeta task={preview} />
            <p className="mt-1 text-[10px] text-muted-foreground">
              {folderName(draft.folder)} · {COLUMNS.find((c) => c.value === draft.status)?.label}
            </p>
          </div>
        </div>
      </motion.div>

      <div
        data-morph-row=""
        role="toolbar"
        aria-label="Task fields"
        className="flex flex-wrap items-center gap-0.5 pt-1.5"
      >
        {token('lane', Folder, folderName(draft.folder), true)}
        {token(
          'status',
          CircleDashed,
          COLUMNS.find((c) => c.value === draft.status)!.label as string,
          true,
        )}
        {token('due', CalendarDays, draft.due ? shortStamp(draft.due) : 'Due', Boolean(draft.due))}
        {token(
          'priority',
          Flag,
          (PRIORITIES.find((p) => p.value === draft.priority)?.label as string | undefined) ??
            'Priority',
          Boolean(draft.priority),
        )}
        {token(
          'tags',
          Hash,
          draft.tags.length ? draft.tags.map((t) => `#${t}`).join(' ') : 'Tags',
          draft.tags.length > 0,
        )}
        <span className="ml-auto flex items-center gap-1 pr-1.5 text-[10px] text-muted-foreground">
          <Icon icon={CornerDownLeft} size="sm" /> adds
        </span>
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key={open}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={reduced ? instant : settle}
            className="overflow-hidden"
          >
            <div className="pt-1.5">
              {open === 'lane' && (
                <>
                  <p className="px-1 pb-1 text-[10px] text-muted-foreground">
                    {laneQuery ? `Folder: ${laneQuery}` : 'Type to find a folder or name a new one'}
                  </p>
                  <PillGroup
                    label="Lane"
                    tabbable={false}
                    options={laneChoices.slice(0, FOLDERS_SHOWN).map((f) => ({
                      value: f === ROOT_LANE ? '/' : f,
                      label: folders.includes(f) ? folderName(f) : `New: ${f}`,
                    }))}
                    isOn={(v) => (v === '/' ? ROOT_LANE : v) === draft.folder}
                    onPick={(v) => set({ folder: v === '/' ? ROOT_LANE : v })}
                  />
                </>
              )}
              {open === 'status' && (
                <PillGroup
                  label="Column"
                  tabbable={false}
                  options={COLUMNS}
                  isOn={(v) => v === draft.status}
                  onPick={(v) => set({ status: v })}
                />
              )}
              {open === 'due' && (
                <PillGroup
                  label="Due"
                  tabbable={false}
                  options={dues.map((d) => ({ value: d.value, label: d.label }))}
                  isOn={(v) => v === draft.due}
                  onPick={(v) => set({ due: draft.due === v ? undefined : v })}
                />
              )}
              {open === 'priority' && (
                <PillGroup
                  label="Priority"
                  tabbable={false}
                  options={PRIORITIES}
                  isOn={(v) => v === draft.priority}
                  onPick={(v) => set({ priority: draft.priority === v ? undefined : v })}
                />
              )}
              {open === 'tags' &&
                (allTags.length === 0 ? (
                  <p className="px-1 text-[10px] text-muted-foreground">
                    No tags in this vault yet
                  </p>
                ) : (
                  <PillGroup
                    label="Tags"
                    multiple
                    tabbable={false}
                    options={allTags.map((t) => ({ value: t, label: `#${t}` }))}
                    active={allTags[tagAt]}
                    isOn={(v) => draft.tags.includes(v)}
                    onPick={toggleTag}
                  />
                ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
