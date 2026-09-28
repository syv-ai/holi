/**
 * Quick add (⌘T, and the board dock's New): the card as it will look, filled
 * in place (docs/features/tasks.md). It rises out of the board's dock, or
 * opens centred like the palette anywhere else (`QuickAddHost`).
 *
 * - **The card is the form.** A small note editor (the notes stack:
 *   `@`-mentions, `[[wiki-links]]`, live preview): the first line is the
 *   title, set larger, and any further lines are the description.
 * - **Tab is a wizard.** Tab swaps the whole panel for the next field's step
 *   (Lane, Due, Priority, Tags) and wraps back to the text; Shift+Tab goes
 *   back. On a step ↑/↓ choose and the value follows; Space toggles a tag;
 *   Backspace clears Due or Priority; on Lane, typing finds a folder or names
 *   a new one. Escape on a step returns to the text. The bar at the foot names
 *   the steps with their values, the current one on the accent.
 * - **Enter adds** from anywhere; Shift+Enter is a new line. The editor's own
 *   Enter and Tab yield to these (`quickKeys`), except while a completion is
 *   open, whose Enter picks.
 * - Everything is created in Todo. **Lane is any folder**, not only a board
 *   lane, as the full create allows; it defaults to the active note's folder.
 * - After an add the text clears and the lane stays: the next task usually
 *   goes to the same place. On the board, the card flies from the dock to its
 *   cell (a shared `layoutId`, the path it will have).
 */
import type { Priority } from '@holi/shared'
import { taskFilePath, taskSlug } from '@holi/shared'
import { completionStatus } from '@codemirror/autocomplete'
import { insertNewlineAndIndent } from '@codemirror/commands'
import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown'
import { Prec } from '@codemirror/state'
import { Decoration, EditorView, keymap } from '@codemirror/view'
import { useAtomValue, useSetAtom } from 'jotai'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { CalendarDays, Check, Flag, Folder, Hash, PenLine } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { duePresets, shortStamp } from '@/lib/date-presets'
import { Icon, MorphRow, TaskCheck, Token, instant, settle, type IconGlyph } from '@/primitives'
import { nowAtom } from '@/state/clock'
import {
  ROOT_LANE,
  createTaskAtom,
  taskCreateFolders,
  taskTagsAtom,
  tasksAtom,
} from '@/state/tasks'
import { activeDocAtom, snapshotAtom } from '@/state/vaults'
import { TaskDescriptionEditor } from './TaskBodyEditor'

const PRIORITIES: { value: Priority; label: string }[] = [
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
]
/** The folders Lane lists at once; typing narrows the rest. */
const FOLDERS_SHOWN = 40

/** The body's heights, in px: the title's one line; the text once it has a
 *  description, and the most a step's list takes; a step's heading and a row. */
const TITLE_ONLY = 44
const FULL = 240
const STEP_HEADING = 38
const ROW = 32

type Step = 'text' | 'lane' | 'due' | 'priority' | 'tags'
const STEPS: readonly Step[] = ['text', 'lane', 'due', 'priority', 'tags']
const STEP_NAMES: Record<Step, string> = {
  text: 'Task',
  lane: 'Lane',
  due: 'Due',
  priority: 'Priority',
  tags: 'Tags',
}

type Draft = {
  text: string
  folder: string
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

/** What quick add asks of the editor's keys, read when a key is pressed. */
type QuickKeys = { add: () => void; tab: (by: 1 | -1) => void }

/**
 * Quick add's layer over the notes stack: Enter adds and Tab walks the wizard,
 * above the stack's own bindings (a list's Enter, `indentWithTab`). An open
 * completion keeps its Enter. Shift+Enter continues a list as Enter would in a
 * note. The first line is the title, drawn larger.
 */
function quickKeys(keys: React.RefObject<QuickKeys>) {
  return [
    Prec.highest(
      keymap.of([
        {
          key: 'Enter',
          run: (view) => {
            if (completionStatus(view.state) === 'active') return false
            keys.current.add()
            return true
          },
          shift: (view) => insertNewlineContinueMarkup(view) || insertNewlineAndIndent(view),
        },
        {
          key: 'Tab',
          run: () => (keys.current.tab(1), true),
          shift: () => (keys.current.tab(-1), true),
        },
      ]),
    ),
    EditorView.decorations.compute(['doc'], () =>
      Decoration.set([Decoration.line({ class: 'cm-quick-title' }).range(0)]),
    ),
    EditorView.theme({
      '&': { height: '100%', fontSize: '13px', '--editor-inset': '0px' },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': { lineHeight: '1.55' },
      '.cm-content': { padding: '0 0 8px' },
      '.cm-quick-title': { fontSize: '16px', fontWeight: '500', paddingBottom: '2px' },
    }),
  ]
}

export function QuickAdd({
  flight = false,
  open = true,
}: {
  flight?: boolean
  /** The dock keeps its panel mounted while folded; folding it resets the wizard. */
  open?: boolean
}): React.JSX.Element {
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
    tags: [],
  }))
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))
  const [step, setStep] = useState<Step>('text')
  /** Which way the last step went, so the panels slide the same way. */
  const [direction, setDirection] = useState<1 | -1>(1)
  const [laneQuery, setLaneQuery] = useState('')
  /** The row ↑/↓ have reached on a step; Space, → or a click picks it. */
  const [cursor, setCursor] = useState(0)
  /** The preview's layoutId: a draft's own, then, for one add, the path the
   *  new card will have, so the card takes over from the preview mid-air. */
  const draftId = useId()
  const [flightId, setFlightId] = useState(draftId)
  const viewRef = useRef<EditorView | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

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

  /** The editor owns the text; setting it from here goes through the view,
   *  so the undo history keeps it. */
  const setText = (text: string) => {
    const view = viewRef.current
    if (view) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
  }

  const go = (next: Step) => {
    setDirection(STEPS.indexOf(next) >= STEPS.indexOf(step) ? 1 : -1)
    setStep(next)
    setLaneQuery('')
  }
  const walk = (by: 1 | -1) => go(stepIn(STEPS, step, by))

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
    setText('')
    set({ due: undefined, priority: undefined, tags: [] })
    go('text')
    try {
      await create({
        title,
        status: 'todo',
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
      setText(sent.text)
    }
    setFlightId(`${draftId}-${predicted}`)
  }

  // The editor binds its keys once; they call whatever this render made.
  const keys = useRef<QuickKeys>({ add: () => {}, tab: () => {} })
  keys.current = { add: () => void submit(), tab: walk }
  const extensions = useMemo(() => quickKeys(keys), [])

  const toggleTag = (tag: string) =>
    set({
      tags: draft.tags.includes(tag) ? draft.tags.filter((t) => t !== tag) : [...draft.tags, tag],
    })

  /** The step's rows. Picking one of a single choice sets it and moves on;
   *  a tag toggles and stays. */
  type Choice = {
    key: string
    label: string
    icon?: IconGlyph
    value?: string
    on: boolean
    pick: () => void
  }
  const single = (patch: Partial<Draft>) => {
    set(patch)
    walk(1)
  }
  const choices: Choice[] =
    step === 'lane'
      ? laneChoices.slice(0, FOLDERS_SHOWN).map((f) => ({
          key: f || '/',
          icon: Folder,
          label: folders.includes(f) ? folderName(f) : `New: ${f}`,
          on: f === draft.folder,
          pick: () => single({ folder: f }),
        }))
      : step === 'due'
        ? [{ value: undefined, label: 'No due date' }, ...dues].map((d) => ({
            key: d.value ?? 'none',
            label: d.label,
            ...(d.value ? { value: shortStamp(d.value) } : {}),
            on: d.value === draft.due,
            pick: () => single({ due: d.value }),
          }))
        : step === 'priority'
          ? [{ value: undefined, label: 'No priority' }, ...PRIORITIES].map((p) => ({
              key: p.value ?? 'none',
              label: p.label,
              on: p.value === draft.priority,
              pick: () => single({ priority: p.value }),
            }))
          : step === 'tags'
            ? allTags.map((tag) => ({
                key: tag,
                label: `#${tag}`,
                on: draft.tags.includes(tag),
                pick: () => toggleTag(tag),
              }))
            : []
  const at = Math.min(cursor, Math.max(0, choices.length - 1))
  /** One line until Shift+Enter starts a description; a step as tall as its
   *  rows, to a point. */
  const bodyHeight =
    step === 'text'
      ? draft.text.includes('\n')
        ? FULL
        : TITLE_ONLY
      : Math.min(FULL, STEP_HEADING + Math.max(1, choices.length) * ROW)

  // Focus follows the step: the editor for the text, the list for a field,
  // whose cursor starts on the current value. Before paint, so the view that
  // is going never holds focus when it hides.
  const shownStep = useRef(step)
  useLayoutEffect(() => {
    if (shownStep.current === step) return
    shownStep.current = step
    setCursor(
      Math.max(
        0,
        choices.findIndex((c) => c.on),
      ),
    )
    if (step === 'text') viewRef.current?.focus()
    else listRef.current?.focus({ preventScroll: true })
    // `choices` is this render's, which is the step's own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  // Opening puts the caret in the text: centred, quick add mounts with its
  // opening; in the dock it stays mounted and `open` turns on. Folded away
  // mid-wizard, it opens on the text again.
  useEffect(() => {
    if (open) {
      viewRef.current?.focus()
      return
    }
    setStep('text')
    shownStep.current = 'text'
    setLaneQuery('')
  }, [open])

  // The row a key reached stays in sight.
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-active]')
      ?.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' })
  }, [step, at, reduced])

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const { key } = event
    if (key === 'Escape') {
      if (step !== 'text') {
        event.preventDefault()
        event.stopPropagation()
        go('text')
      } else if (event.defaultPrevented) {
        // The editor closed a completion: that Escape was spent.
        event.stopPropagation()
      }
      return
    }
    // The editor handled it (its own Enter and Tab included).
    if (event.defaultPrevented) return
    if (key === 'Tab') {
      event.preventDefault()
      walk(event.shiftKey ? -1 : 1)
      return
    }
    if (key === 'Enter' && !event.shiftKey) {
      // From the text it adds; from a step it goes back to the text.
      event.preventDefault()
      if (step === 'text') void submit()
      else go('text')
      return
    }
    if (step === 'text') return
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault()
      if (choices.length > 0)
        setCursor((at + (key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length)
    } else if (key === ' ' || key === 'ArrowRight') {
      event.preventDefault()
      choices[at]?.pick()
    } else if (key === 'Backspace') {
      event.preventDefault()
      if (step === 'due') set({ due: undefined })
      if (step === 'priority') set({ priority: undefined })
      if (step === 'lane') {
        setLaneQuery(laneQuery.slice(0, -1))
        setCursor(0)
      }
    } else if (
      step === 'lane' &&
      key.length === 1 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      // Typing on Lane narrows the folders, or names a new one.
      event.preventDefault()
      setLaneQuery(laneQuery + key)
      setCursor(0)
    }
  }

  /** A step in the bar at the foot: its icon, and its value once it has one. */
  const stepToken = (id: Step, icon: IconGlyph, value: string | undefined) => (
    <Token
      key={id}
      icon={icon}
      label={value}
      aria-label={value ? `${STEP_NAMES[id]}: ${value}` : STEP_NAMES[id]}
      set={value !== undefined}
      open={step === id}
      tabIndex={-1}
      data-step-token={id}
      onClick={() => go(id)}
    />
  )

  return (
    <div
      className="w-[30rem] max-w-[calc(100vw-2rem)]"
      data-quick-add=""
      data-step={step}
      onKeyDown={onKeyDown}
    >
      <motion.div
        data-morph-row=""
        initial={false}
        animate={{ height: bodyHeight }}
        transition={reduced ? instant : settle}
        className="relative overflow-hidden"
      >
        {/* The text stays mounted under the steps: its undo history and a
            half-typed mention survive a trip round the wizard. */}
        <motion.div
          inert={step !== 'text'}
          aria-hidden={step !== 'text'}
          animate={
            step === 'text'
              ? { opacity: 1, x: 0 }
              : { opacity: 0, x: reduced ? 0 : direction * -24 }
          }
          transition={reduced ? instant : settle}
          className="absolute inset-0"
        >
          <motion.div
            layoutId={flight && !reduced ? flightId : undefined}
            transition={reduced ? instant : settle}
            style={{ borderRadius: 12 }}
            className="flex h-full items-start gap-2.5 px-3 pt-2.5"
          >
            {/* What the card will look like: the check is a picture here. */}
            <span inert aria-hidden className="mt-0.5">
              <TaskCheck filled={false} label="" />
            </span>
            <div className="h-full min-w-0 flex-1">
              <TaskDescriptionEditor
                notePath=""
                initial=""
                placeholderText="What needs doing?"
                extensions={extensions}
                viewRef={viewRef}
                onChange={(text) => set({ text })}
                hostClassName="h-full overflow-hidden"
              />
            </div>
          </motion.div>
        </motion.div>

        <AnimatePresence initial={false} custom={direction}>
          {step !== 'text' && (
            <motion.div
              key={step}
              custom={direction}
              variants={{
                from: (d: number) => ({ opacity: 0, x: reduced ? 0 : d * 24 }),
                at: { opacity: 1, x: 0 },
                gone: (d: number) => ({ opacity: 0, x: reduced ? 0 : d * -24 }),
              }}
              initial="from"
              animate="at"
              exit="gone"
              transition={reduced ? instant : settle}
              className="absolute inset-0 flex flex-col px-1.5 pt-1.5"
            >
              <div className="flex items-baseline justify-between px-2.5 pb-1.5">
                <span className="text-sm font-medium">{STEP_NAMES[step]}</span>
                {step === 'lane' && laneQuery && (
                  <span className="truncate pl-3 text-xs text-muted-foreground">{laneQuery}</span>
                )}
              </div>
              <div
                ref={listRef}
                role="listbox"
                aria-label={STEP_NAMES[step]}
                aria-multiselectable={step === 'tags' || undefined}
                tabIndex={-1}
                className="min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none"
              >
                {step === 'tags' && allTags.length === 0 && (
                  <p className="px-2.5 py-1.5 text-sm text-muted-foreground">
                    No tags in this vault yet
                  </p>
                )}
                {choices.map((choice, index) => (
                  <MorphRow
                    key={choice.key}
                    role="option"
                    aria-selected={choice.on}
                    tabIndex={-1}
                    icon={choice.icon}
                    label={choice.label}
                    value={
                      choice.on ? (
                        <span className="flex items-center gap-2">
                          {choice.value}
                          <Icon icon={Check} />
                        </span>
                      ) : (
                        choice.value
                      )
                    }
                    active={index === at}
                    onClick={() => {
                      setCursor(index)
                      choice.pick()
                    }}
                  />
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      <div
        data-morph-row=""
        role="toolbar"
        aria-label="Task fields"
        className="flex flex-wrap items-center gap-0.5 pt-1.5"
      >
        {stepToken('text', PenLine, undefined)}
        {stepToken('lane', Folder, draft.folder === ROOT_LANE ? undefined : draft.folder)}
        {stepToken('due', CalendarDays, draft.due ? shortStamp(draft.due) : undefined)}
        {stepToken('priority', Flag, PRIORITIES.find((p) => p.value === draft.priority)?.label)}
        {stepToken(
          'tags',
          Hash,
          draft.tags.length ? draft.tags.map((t) => `#${t}`).join(' ') : undefined,
        )}
      </div>
    </div>
  )
}
