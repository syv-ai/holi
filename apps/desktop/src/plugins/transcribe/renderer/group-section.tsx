/**
 * One topic of the minutes: a closed group as the scribe wrote it, or as the
 * person corrected it. Folded, it is one row to scan: its number, title,
 * gist (the first summary bullet) and its time. Open, it has two tabs: the
 * summary, decisions, open questions, the scribe's suggestions as compact rows,
 * each with Send (or, once sent, its run), and its keywords; and its
 * transcript, the topic's own lines word for word. Its actions show on
 * hover, focus or when open: Send (the whole topic, `send-panel.tsx`), and
 * under its menu Edit (every field in place, `meeting.group.edit`; what a
 * person edits is theirs, and the scribe leaves it) and Merge with the previous
 * (`meeting.group.merge`). A topic the scribe has still to write, after a split
 * or a merge, says so. A joined topic reads as one: each list across all
 * its groups, and its menu edits one group at a time (Edit part).
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useDraggable, useDroppable } from '@dnd-kit/core'
import {
  ChevronRight,
  Combine,
  Copy,
  Ellipsis,
  GripVertical,
  Merge,
  Pencil,
  SendHorizontal,
  Split,
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { activeRemoteAtom, cn } from '@/plugin-api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { IconButton } from '@/composites/icon-button'
import { merged } from '../shared/joins'
import type { MeetingState, Suggestion, Topic, TopicField } from '../shared/meeting'
import { CaptionLine } from './caption-line'
import { ListField } from './card-fields'
import { clock } from '../shared/scribe-prompt'
import { meetingCap } from './meeting-cap'
import { SCRIBE_TITLE } from './names'
import { RunState, useRun } from './run-state'
import { message, putTopicAtom, putTopicsAtom, sendPanelAtom } from './state'
import { KindIcon, OpenSession } from './task-row'
import { topicName } from './topic-index'
import { transcriptText } from './transcript-text'

export function Keywords({ topic }: { topic: Topic }): React.JSX.Element | null {
  if (topic.keywords.length === 0) return null
  return (
    <ul aria-label="Keywords" className="flex flex-wrap items-center gap-1">
      {topic.keywords.map((k) => (
        <li key={k}>
          <Badge variant="secondary" size="sm">
            {k}
          </Badge>
        </li>
      ))}
    </ul>
  )
}

/** Bullets under a quiet heading; nothing when there are none. */
function Items({
  title,
  items,
}: {
  title?: string
  items: readonly string[]
}): React.JSX.Element | null {
  if (items.length === 0) return null
  return (
    <div className="flex flex-col gap-1">
      {title !== undefined && (
        <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
      )}
      <ul aria-label={title} className="flex list-disc flex-col gap-0.5 ps-5 text-sm">
        {items.map((x, k) => (
          <li key={k}>{x}</li>
        ))}
      </ul>
    </div>
  )
}

/** One suggestion: its kind and title, and Send, or the run it was sent to. */
function SuggestionRow({
  meeting,
  topic,
  suggestion: s,
}: {
  meeting: MeetingState
  topic: Topic
  suggestion: Suggestion
}): React.JSX.Element {
  const open = useSetAtom(sendPanelAtom)
  const card = meeting.cards
    .filter((c) => c.from?.suggestionId === s.id && c.status !== 'dismissed')
    .at(-1)
  const { sent, run } = useRun(card)
  return (
    <div
      role="group"
      aria-label={s.title}
      data-suggestion={s.id}
      className="flex items-center gap-2"
    >
      <KindIcon kind={s.kind} />
      <span className="min-w-0 flex-1 truncate text-sm">{s.title}</span>
      {sent && card !== undefined ? (
        <>
          <RunState row={run} sentAt={card.updatedAt} />
          <OpenSession card={card} />
        </>
      ) : (
        <Button
          size="xs"
          variant="ghost"
          onClick={() => open({ meetingId: meeting.id, topicId: topic.id, suggestionId: s.id })}
        >
          <SendHorizontal aria-hidden />
          Send
        </Button>
      )}
    </div>
  )
}

/** The fields a person edits of a topic. */
type Draft = Pick<Topic, TopicField>

const draftOf = (t: Topic): Draft => ({
  title: t.title,
  summary: t.summary,
  keywords: t.keywords,
  decisions: t.decisions,
  questions: t.questions,
})

const tidy = (items: readonly string[]): string[] =>
  items.map((x) => x.trim()).filter((x) => x !== '')

/** The fields of `draft` that differ from `topic`, as main takes them. */
function patchOf(topic: Topic, draft: Draft): Partial<Draft> {
  const patch: Partial<Draft> = {}
  if (draft.title.trim() !== topic.title) patch.title = draft.title.trim()
  for (const key of ['summary', 'keywords', 'decisions', 'questions'] as const) {
    const items = tidy(draft[key])
    if (JSON.stringify(items) !== JSON.stringify(topic[key])) patch[key] = items
  }
  return patch
}

/** A topic's fields open for editing, saved together. */
function TopicEditor({
  meeting,
  topic,
  onDone,
}: {
  meeting: MeetingState
  topic: Topic
  onDone: () => void
}): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const put = useSetAtom(putTopicAtom)
  const [draft, setDraft] = useState<Draft>(() => draftOf(topic))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set =
    <K extends TopicField>(key: K) =>
    (value: Draft[K]) =>
      setDraft({ ...draft, [key]: value })

  const save = async () => {
    if (remote === null) return
    if (draft.title.trim() === '') {
      setError('A topic needs a title.')
      return
    }
    const patch = patchOf(topic, draft)
    if (Object.keys(patch).length === 0) return onDone()
    setBusy(true)
    setError(null)
    try {
      put(
        meeting.id,
        await meetingCap['group.edit'](remote, { meetingId: meeting.id, groupId: topic.id, patch }),
      )
      onDone()
    } catch (e) {
      setError(`The topic didn’t save: ${message(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Input
        aria-label="Topic title"
        value={draft.title}
        onChange={(e) => set('title')(e.target.value)}
      />
      <ListField
        title="Summary"
        item="Bullet"
        add="Add bullet"
        items={draft.summary}
        onChange={set('summary')}
      />
      <ListField
        title="Keywords"
        item="Keyword"
        add="Add keyword"
        items={draft.keywords}
        onChange={set('keywords')}
      />
      <ListField
        title="Decisions"
        item="Decision"
        add="Add decision"
        items={draft.decisions}
        onChange={set('decisions')}
      />
      <ListField
        title="Open questions"
        item="Question"
        add="Add question"
        items={draft.questions}
        onChange={set('questions')}
      />
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={busy} onClick={() => void save()}>
          Save topic
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {error !== null && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

/**
 * A topic's own lines, word for word: each correctable in place and able to
 * start a new topic, as in the whole transcript, and Copy for the lot. A
 * joined topic's stretches each under their own heading.
 */
function TopicTranscript({
  meeting,
  parts,
}: {
  meeting: MeetingState
  parts: readonly Topic[]
}): React.JSX.Element {
  const lines = new Set(parts.flatMap((t) => t.lines))
  const all = meeting.segments.filter((s) => lines.has(s.i))
  if (all.length === 0) {
    return <p className="text-sm text-muted-foreground">No lines in this topic yet.</p>
  }
  return (
    <div className="flex flex-col gap-2">
      {parts.map((part) => {
        const own = new Set(part.lines)
        const segments = all.filter((s) => own.has(s.i))
        return (
          <div key={part.id} className="flex flex-col gap-1">
            {parts.length > 1 && (
              <h4 className="flex items-baseline gap-2 px-2 text-xs font-medium text-muted-foreground">
                {topicName(part)}
                <span className="font-normal tabular-nums">
                  {clock(part.start)}–{clock(part.end)}
                </span>
              </h4>
            )}
            <ol aria-label={`Transcript of ${topicName(part)}`} className="flex flex-col">
              {segments.map((s, k) => (
                <CaptionLine
                  key={s.i}
                  meetingId={meeting.id}
                  segment={s}
                  turn={k === 0 || segments[k - 1]!.speaker !== s.speaker}
                  marked={false}
                  split={k > 0}
                />
              ))}
            </ol>
          </div>
        )
      })}
      <div>
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            void navigator.clipboard
              ?.writeText(transcriptText(all))
              .then(() => toast('Topic transcript copied'))
          }
        >
          <Copy aria-hidden />
          Copy
        </Button>
      </div>
    </div>
  )
}

/** An open topic's words: its bullets, decisions, open questions,
 *  suggestions and keywords, each one list across a joined topic's groups,
 *  in meeting order. */
function TopicBody({
  meeting,
  parts,
}: {
  meeting: MeetingState
  parts: readonly Topic[]
}): React.JSX.Element {
  const one = merged(parts)
  const edited = [...new Set(parts.flatMap((t) => t.edited ?? []))]
  const stale = parts.some((t) => t.stale === true)
  return (
    <div className="flex flex-col gap-3">
      {stale && (
        <p className="text-xs text-muted-foreground">
          {SCRIBE_TITLE} will rewrite {parts.length > 1 ? 'part of this topic' : 'this topic'} in
          its next pass.
        </p>
      )}
      <Items items={one.summary} />
      <Items title="Decisions" items={one.decisions} />
      <Items title="Open questions" items={one.questions} />
      {parts.some((t) => t.suggestions.length > 0) && (
        <div className="flex flex-col gap-1">
          <h4 className="text-xs font-medium text-muted-foreground">Suggestions</h4>
          <ul aria-label="Suggestions" className="flex flex-col gap-0.5">
            {parts.flatMap((t) =>
              t.suggestions.map((s) => (
                <li key={s.id}>
                  <SuggestionRow meeting={meeting} topic={t} suggestion={s} />
                </li>
              )),
            )}
          </ul>
        </div>
      )}
      <Keywords topic={one} />
      {edited.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Edited by you: {edited.join(', ')}. {SCRIBE_TITLE} keeps your words.
        </p>
      )}
    </div>
  )
}

/** Another topic this one can join, as the menu offers it. */
export interface JoinTarget {
  id: string
  label: string
}

export function GroupSection({
  meeting,
  parts,
  numbers,
  first,
  open,
  onOpenChange,
  targets,
  onJoin,
}: {
  meeting: MeetingState
  /** The topic's groups: one, or several a person joined, the head first. */
  parts: readonly Topic[]
  /** Each group's place in the meeting, counted from 1, as the strip numbers it. */
  numbers: readonly number[]
  /** The meeting's first topic: none before it to merge with. */
  first: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The other topics it can join. */
  targets: readonly JoinTarget[]
  onJoin: (into: string) => void
}): React.JSX.Element {
  const topic = parts[0]!
  const joined = parts.length > 1
  const remote = useAtomValue(activeRemoteAtom)
  const putTopics = useSetAtom(putTopicsAtom)
  const send = useSetAtom(sendPanelAtom)
  const [editing, setEditing] = useState<string | null>(null)
  const editingPart = parts.find((p) => p.id === editing)
  const name = topicName(topic)
  const gist =
    topic.summary[0] ??
    (topic.stale === true ? `${SCRIBE_TITLE} will rewrite this topic in its next pass.` : null)
  const drag = useDraggable({ id: topic.id })
  const drop = useDroppable({ id: topic.id })
  const target = drop.isOver && drop.active !== null && drop.active.id !== topic.id

  const reshape = async (what: 'merge' | 'separate') => {
    if (remote === null) return
    try {
      const args = { meetingId: meeting.id, groupId: topic.id }
      putTopics(
        meeting.id,
        what === 'merge'
          ? await meetingCap['group.merge'](remote, args)
          : await meetingCap['group.separate'](remote, args),
      )
    } catch (e) {
      toast(
        what === 'merge'
          ? `The topics didn’t merge: ${message(e)}`
          : `The topics didn’t separate: ${message(e)}`,
      )
    }
  }

  return (
    <li
      ref={(el) => {
        drag.setNodeRef(el)
        drop.setNodeRef(el)
      }}
      aria-label={name}
      data-topic={topic.id}
      className={cn(
        'group/topic scroll-mt-4 rounded-md motion-respond',
        target && 'bg-accent',
        drag.isDragging && 'opacity-50',
      )}
    >
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <div className="flex flex-col gap-2">
          <div className="flex items-start gap-1">
            <span className="shrink-0 pt-1 opacity-0 motion-respond group-focus-within/topic:opacity-100 group-hover/topic:opacity-100">
              <IconButton
                ref={drag.setActivatorNodeRef}
                label="Drag onto another topic to join them"
                size="icon-xs"
                {...drag.attributes}
                {...drag.listeners}
              >
                <GripVertical aria-hidden />
              </IconButton>
            </span>
            <h3 className="min-w-0 flex-1">
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="row" className="w-full">
                  <ChevronRight
                    aria-hidden
                    className={cn(
                      'icon-sm shrink-0 self-start mt-1 motion-respond',
                      open && 'rotate-90',
                    )}
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="shrink-0 text-xs font-normal text-muted-foreground tabular-nums">
                        {numbers.join(' + ')}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
                      <span className="shrink-0 text-xs font-normal text-muted-foreground tabular-nums">
                        {parts.map((p) => `${clock(p.start)}–${clock(p.end)}`).join(', ')}
                      </span>
                    </span>
                    {target ? (
                      <span className="ps-6 text-sm font-normal text-foreground">
                        Drop to join with this topic
                      </span>
                    ) : (
                      !open &&
                      gist !== null && (
                        <span className="truncate ps-6 text-sm font-normal text-muted-foreground">
                          {gist}
                        </span>
                      )
                    )}
                  </span>
                </Button>
              </CollapsibleTrigger>
            </h3>
            <span
              className={cn(
                'flex shrink-0 items-center gap-1 pt-1 motion-respond',
                !open &&
                  'opacity-0 group-focus-within/topic:opacity-100 group-hover/topic:opacity-100 has-data-[state=open]:opacity-100',
              )}
            >
              <Button
                size="xs"
                variant="ghost"
                onClick={() => send({ meetingId: meeting.id, topicId: topic.id })}
              >
                <SendHorizontal aria-hidden />
                Send topic
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton label="Topic actions" size="icon-xs">
                    <Ellipsis aria-hidden />
                  </IconButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {joined ? (
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>
                        <Pencil aria-hidden />
                        Edit part
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        {parts.map((p, k) => (
                          <DropdownMenuItem
                            key={p.id}
                            onSelect={() => {
                              onOpenChange(true)
                              setEditing(p.id)
                            }}
                          >
                            {numbers[k]}. {topicName(p)}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  ) : (
                    <DropdownMenuItem
                      onSelect={() => {
                        onOpenChange(true)
                        setEditing(topic.id)
                      }}
                    >
                      <Pencil aria-hidden />
                      Edit topic
                    </DropdownMenuItem>
                  )}
                  {targets.length > 0 && (
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>
                        <Combine aria-hidden />
                        Join with
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        {targets.map((t) => (
                          <DropdownMenuItem key={t.id} onSelect={() => onJoin(t.id)}>
                            {t.label}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  )}
                  {joined ? (
                    <DropdownMenuItem onSelect={() => void reshape('separate')}>
                      <Split aria-hidden />
                      Separate topics
                    </DropdownMenuItem>
                  ) : (
                    !first && (
                      <DropdownMenuItem onSelect={() => void reshape('merge')}>
                        <Merge aria-hidden />
                        Merge with the previous
                      </DropdownMenuItem>
                    )
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          </div>
          <CollapsibleContent>
            <div className="flex flex-col gap-3 ps-20 pb-2 motion-in-fade">
              {editingPart !== undefined ? (
                <div className="flex flex-col gap-3">
                  {joined && (
                    <h4 className="flex items-baseline gap-2 text-xs font-medium text-muted-foreground">
                      Editing {topicName(editingPart)}
                      <span className="font-normal tabular-nums">
                        {clock(editingPart.start)}–{clock(editingPart.end)}
                      </span>
                    </h4>
                  )}
                  <TopicEditor
                    meeting={meeting}
                    topic={editingPart}
                    onDone={() => setEditing(null)}
                  />
                </div>
              ) : (
                <Tabs defaultValue="summary">
                  <TabsList variant="line">
                    <TabsTrigger value="summary">Summary</TabsTrigger>
                    <TabsTrigger value="transcript">Transcript</TabsTrigger>
                  </TabsList>
                  <TabsContent value="summary">
                    <TopicBody meeting={meeting} parts={parts} />
                  </TabsContent>
                  <TabsContent value="transcript">
                    <TopicTranscript meeting={meeting} parts={parts} />
                  </TabsContent>
                </Tabs>
              )}
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    </li>
  )
}
