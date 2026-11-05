/**
 * The minutes as the meeting's topics, stacked oldest first and folded to a
 * row each, so the meeting reads at a glance: above them a strip with one bar
 * per topic, as long as it ran, and the decisions and open questions of every
 * topic in one folded block; then each closed topic (`group-section.tsx`),
 * one open at a time (opening one folds the others, and a bar of the strip
 * scrolls smoothly to its topic) or all at once, and, while the meeting records,
 * the open one last as Now, with what is being said and Summarise now (the
 * next batch to the scribe at once, `meeting.summarise`). While it records the
 * header has Ask the assistant, which changes topics in words. A meeting saved
 * before topics shows the minutes its scribe wrote, as they are.
 */
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { ChevronRight, SendHorizontal, Sparkles } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  activeRemoteAtom,
  cn,
  openSettingsSectionAtom,
  prefersReducedMotion,
  showAgentSessionAtom,
  useNow,
} from '@/plugin-api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { MarkdownText } from '@/composites/markdown-text'
import { joinedSets } from '../shared/joins'
import type { MeetingState, Topic } from '../shared/meeting'
import { AskAssistant } from './ask-assistant'
import { clock } from '../shared/scribe-prompt'
import { GroupSection, Keywords } from './group-section'
import { meetingCap } from './meeting-cap'
import { SCRIBE_TITLE } from './names'
import { useScribeReadiness, type ScribeReadiness } from './scribe-ready'
import { SpeakerBadge } from './speaker-badge'
import { message, minutesAskedAtom, putTopicsAtom, sendPanelAtom } from './state'
import { topicName } from './topic-index'

/** How long the scribe is said to be on it, at most, if it writes nothing sooner. */
const ASKED_MS = 60_000
/** The open topic's last lines shown under it. */
const TAIL = 3

interface Gathered {
  text: string
  topic: string
}

/** Every topic's items of one kind, each with its topic's name: a joined
 *  group's under the name of the topic it joined. */
function gather(topics: readonly Topic[], pick: (t: Topic) => readonly string[]): Gathered[] {
  const byId = new Map(topics.map((t) => [t.id, t]))
  return topics.flatMap((t) =>
    pick(t).map((text) => ({
      text,
      topic: topicName(byId.get(t.joinedTo ?? t.id) ?? t),
    })),
  )
}

function GatheredList({
  title,
  items,
}: {
  title: string
  items: Gathered[]
}): React.JSX.Element | null {
  if (items.length === 0) return null
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      <ul aria-label={title} className="flex list-disc flex-col gap-0.5 ps-5 text-sm">
        {items.map((x, k) => (
          <li key={k}>
            {x.text} <span className="text-xs text-muted-foreground">({x.topic})</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Every topic's decisions and open questions in one block, folded on a click. */
function Rollup({ topics }: { topics: readonly Topic[] }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const decisions = gather(topics, (t) => t.decisions)
  const questions = gather(topics, (t) => t.questions)
  if (decisions.length === 0 && questions.length === 0) return null
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <section
        aria-label="Decisions and open questions"
        className="flex flex-col gap-2 rounded-md bg-muted p-2"
      >
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="row" className="w-full">
            <ChevronRight
              aria-hidden
              className={cn('icon-sm shrink-0 motion-respond', open && 'rotate-90')}
            />
            <span className="min-w-0 flex-1 truncate text-xs font-medium">
              {decisions.length === 1 ? '1 decision' : `${decisions.length} decisions`},{' '}
              {questions.length === 1 ? '1 open question' : `${questions.length} open questions`}
            </span>
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="flex flex-col gap-3 px-2 pb-1">
            <GatheredList title="Decisions" items={decisions} />
            <GatheredList title="Open questions" items={questions} />
          </div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  )
}

/**
 * The meeting at a glance: one bar per topic, as wide as it is long, the one
 * being talked about now in the primary colour. A bar opens its topic and
 * brings it into view.
 */
function TopicStrip({
  topics,
  openIds,
  onPick,
}: {
  topics: readonly Topic[]
  openIds: ReadonlySet<string>
  onPick: (topic: Topic) => void
}): React.JSX.Element {
  return (
    <ol aria-label="Topics at a glance" className="flex items-stretch gap-0.5">
      {topics.map((t, k) => (
        <li
          key={t.id}
          className="flex min-w-2 grow-(--grow) basis-0"
          style={{ '--grow': Math.max(1, t.end - t.start) } as React.CSSProperties}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="text"
                size="inline"
                aria-label={`${k + 1}. ${topicName(t)}, ${clock(t.start)}–${clock(t.end)}`}
                onClick={() => onPick(t)}
                className="group/bar w-full"
              >
                <span
                  className={cn(
                    'my-1.5 h-2 w-full rounded-full motion-respond',
                    t.open
                      ? 'bg-primary'
                      : openIds.has(t.joinedTo ?? t.id)
                        ? 'bg-foreground/50'
                        : 'bg-foreground/15 group-hover/bar:bg-foreground/35',
                  )}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {k + 1}. {topicName(t)} · {clock(t.start)}–{clock(t.end)}
            </TooltipContent>
          </Tooltip>
        </li>
      ))}
    </ol>
  )
}

/** Why Summarise now cannot go yet, and what gets the assistant going. */
function ScribeNotReady({
  meeting,
  readiness,
}: {
  meeting: MeetingState
  readiness: Extract<ScribeReadiness, { ready: false }>
}): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const showSession = useSetAtom(showAgentSessionAtom)
  const openSettings = useSetAtom(openSettingsSectionAtom)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const session = meeting.scribeSessionId

  const restart = async () => {
    if (remote === null) return
    setBusy(true)
    setError(null)
    try {
      await meetingCap['scribe.restart'](remote, { meetingId: meeting.id })
    } catch (e) {
      setError(`${SCRIBE_TITLE} didn’t start: ${message(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div role="status" aria-label="Assistant" className="flex flex-col gap-1">
      <p className="text-xs text-muted-foreground">{readiness.reason}</p>
      {readiness.fixes.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {readiness.fixes.includes('settings') && (
            <Button size="xs" variant="outline" onClick={() => openSettings('general')}>
              Agent settings
            </Button>
          )}
          {readiness.fixes.includes('restart') && (
            <Button size="xs" variant="outline" disabled={busy} onClick={() => void restart()}>
              {busy && <Spinner />}
              Start the assistant
            </Button>
          )}
          {readiness.fixes.includes('open-session') && session !== undefined && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => void showSession({ session, live: meeting.scribeState !== 'gone' })}
            >
              Open its session
            </Button>
          )}
        </div>
      )}
      {error !== null && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

/** The topic being talked about now: its last lines, Send and Summarise now. */
function NowGroup({ meeting, topic }: { meeting: MeetingState; topic: Topic }): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const send = useSetAtom(sendPanelAtom)
  const now = useNow(1000)
  const [asked, setAsked] = useState<{ at: number; minutesAt: number | undefined } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const readiness = useScribeReadiness(meeting)
  const summarising =
    asked !== null && meeting.minutesAt === asked.minutesAt && now - asked.at < ASKED_MS
  const lines = new Set(topic.lines.slice(-TAIL))
  const tail = meeting.segments.filter((s) => lines.has(s.i))

  const summarise = async () => {
    if (remote === null) return
    setError(null)
    try {
      await meetingCap.summarise(remote, { meetingId: meeting.id })
      setAsked({ at: Date.now(), minutesAt: meeting.minutesAt })
    } catch (e) {
      setError(`${SCRIBE_TITLE} didn’t get that: ${message(e)}`)
    }
  }

  return (
    <section aria-label="Now" data-topic={topic.id} className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <h3 className="flex min-w-0 flex-1 items-baseline gap-2 ps-2">
          <span className="min-w-0 truncate text-sm font-medium">
            Now{topic.title.trim() === '' ? '' : `: ${topic.title.trim()}`}
          </span>
          <span className="shrink-0 text-xs font-normal text-muted-foreground tabular-nums">
            from {clock(topic.start)}
          </span>
        </h3>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => send({ meetingId: meeting.id, topicId: topic.id })}
        >
          <SendHorizontal aria-hidden />
          Send
        </Button>
        <Button
          size="xs"
          variant="secondary"
          disabled={summarising || !readiness.ready}
          onClick={() => void summarise()}
        >
          <Sparkles aria-hidden />
          Summarise now
        </Button>
      </div>
      <div className="flex flex-col gap-2 ps-2">
        <Keywords topic={topic} />
        {topic.summary.length > 0 && (
          <ul className="flex list-disc flex-col gap-0.5 ps-5 text-sm">
            {topic.summary.map((b, k) => (
              <li key={k}>{b}</li>
            ))}
          </ul>
        )}
        {tail.length > 0 && (
          <ol aria-label="Said now" className="flex flex-col gap-0.5">
            {tail.map((s) => (
              <li
                key={s.i}
                className="flex min-w-0 items-baseline gap-2 text-sm text-muted-foreground"
              >
                <SpeakerBadge speaker={s.speaker} />
                <span className="min-w-0 truncate">{s.text}</span>
              </li>
            ))}
          </ol>
        )}
        {!readiness.ready && <ScribeNotReady meeting={meeting} readiness={readiness} />}
        {summarising && (
          <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner />
            {SCRIBE_TITLE} is summarising…
          </p>
        )}
        {error !== null && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    </section>
  )
}

export function GroupSections({
  meeting,
  live,
}: {
  meeting: MeetingState
  /** The meeting records: the open topic is Now, and the scribe can be asked. */
  live: boolean
}): React.JSX.Element {
  const now = useNow(1000)
  const [allAsked, setAllAsked] = useAtom(minutesAskedAtom)
  const [askError, setAskError] = useState<string | null>(null)
  const asked = allAsked[meeting.id] ?? null
  const updating =
    asked !== null && meeting.minutesAt === asked.minutesAt && now - asked.at < ASKED_MS
  const { topics } = meeting
  const open = live ? topics.find((t) => t.open) : undefined
  const closed = topics.filter((t) => t !== open)
  const sets = joinedSets(closed)
  const numberOf = new Map(closed.map((t, k) => [t.id, k + 1]))
  const legacy = topics.length === 0 && meeting.minutes.trim() !== ''
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set())
  const list = useRef<HTMLOListElement>(null)
  const allOpen = sets.length > 0 && sets.every(([t]) => openIds.has(t!.id))
  const remote = useAtomValue(activeRemoteAtom)
  const putTopics = useSetAtom(putTopicsAtom)
  const [dragging, setDragging] = useState<string | null>(null)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  )
  /** `id`'s topic joins `into`'s: one topic, opened where it now sits. */
  const join = async (id: string, into: string) => {
    if (remote === null || id === into) return
    try {
      const next = await meetingCap['group.join'](remote, {
        meetingId: meeting.id,
        groupId: id,
        into,
      })
      putTopics(meeting.id, next)
      const joined = next.find((t) => t.id === into)
      const head = joined?.joinedTo ?? into
      setOpenIds(new Set([head]))
      const name = topicName(next.find((t) => t.id === head) ?? next[0]!)
      toast(`Joined into “${name}”`, {
        action: {
          label: 'Separate',
          onClick: () =>
            void meetingCap['group.separate'](remote, { meetingId: meeting.id, groupId: head })
              .then((back) => putTopics(meeting.id, back))
              .catch((e: unknown) => toast(`The topics didn’t separate: ${message(e)}`)),
        },
      })
    } catch (e) {
      toast(`The topics didn’t join: ${message(e)}`)
    }
  }
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(null)
    if (over !== null && over.id !== active.id) void join(String(active.id), String(over.id))
  }
  /** Bring a topic into view once the topics it closed have folded. */
  const reveal = (selector: string, block: ScrollLogicalPosition) =>
    requestAnimationFrame(() =>
      list.current?.parentElement
        ?.querySelector(selector)
        ?.scrollIntoView?.({ block, behavior: prefersReducedMotion() ? 'auto' : 'smooth' }),
    )
  // One topic open at a time: opening one folds the rest (Expand all aside).
  const setOpen = (id: string, on: boolean) => {
    setOpenIds((ids) => {
      if (on) return new Set([id])
      const next = new Set(ids)
      next.delete(id)
      return next
    })
    if (on) reveal(`[data-topic="${id}"]`, 'nearest')
  }
  const pick = (t: Topic) => {
    if (t.open && live) return reveal('[aria-label="Now"]', 'start')
    const head = t.joinedTo ?? t.id
    setOpenIds(new Set([head]))
    reveal(`[data-topic="${head}"]`, 'start')
  }

  return (
    <section aria-label="Minutes" className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <h2 className="text-xs font-medium text-muted-foreground">Minutes</h2>
        {sets.length > 1 && (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setOpenIds(allOpen ? new Set() : new Set(sets.map(([t]) => t!.id)))}
          >
            {allOpen ? 'Collapse all' : 'Expand all'}
          </Button>
        )}
        {live && (
          <div className="ms-auto flex min-w-0 flex-1 items-center justify-end">
            <AskAssistant
              meetingId={meeting.id}
              onAsked={() =>
                setAllAsked((all) => ({
                  ...all,
                  [meeting.id]: { at: Date.now(), minutesAt: meeting.minutesAt },
                }))
              }
              onError={setAskError}
            />
          </div>
        )}
      </div>
      {updating && (
        <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner />
          {SCRIBE_TITLE} is updating the topics…
        </p>
      )}
      {askError !== null && (
        <p role="alert" className="text-xs text-destructive">
          {askError}
        </p>
      )}
      {legacy ? (
        <MarkdownText body={meeting.minutes} className="text-sm" />
      ) : topics.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {live
            ? `${SCRIBE_TITLE} groups the meeting into topics every few minutes, as it goes.`
            : 'This meeting has no topics.'}
        </p>
      ) : (
        <>
          {topics.length > 1 && <TopicStrip topics={topics} openIds={openIds} onPick={pick} />}
          <Rollup topics={topics} />
          {sets.length > 0 && (
            <DndContext
              sensors={sensors}
              onDragStart={({ active }) => setDragging(String(active.id))}
              onDragCancel={() => setDragging(null)}
              onDragEnd={onDragEnd}
            >
              <ol ref={list} aria-label="Topics" className="flex flex-col gap-1">
                {sets.map((parts, k) => {
                  const t = parts[0]!
                  return (
                    <GroupSection
                      key={t.id}
                      meeting={meeting}
                      parts={parts}
                      numbers={parts.map((p) => numberOf.get(p.id) ?? 0)}
                      first={k === 0}
                      open={openIds.has(t.id)}
                      onOpenChange={(on) => setOpen(t.id, on)}
                      targets={sets
                        .filter(([o]) => o!.id !== t.id)
                        .map((o) => ({
                          id: o[0]!.id,
                          label: `${o.map((p) => numberOf.get(p.id)).join(' + ')}. ${topicName(o[0]!)}`,
                        }))}
                      onJoin={(into) => void join(t.id, into)}
                    />
                  )
                })}
              </ol>
              <DragOverlay dropAnimation={null}>
                {dragging !== null && (
                  <Badge variant="secondary">
                    {topicName(closed.find((t) => t.id === dragging) ?? closed[0]!)}
                  </Badge>
                )}
              </DragOverlay>
            </DndContext>
          )}
          {open !== undefined && <NowGroup meeting={meeting} topic={open} />}
        </>
      )}
    </section>
  )
}
