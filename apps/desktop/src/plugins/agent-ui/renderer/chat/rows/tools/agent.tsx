/**
 * Agent (and Task), SubagentHandback and SendMessage.
 *
 * A sub-agent call's result is mostly an acknowledgement that it started, so
 * whether it is running, finished or failed comes from the background task's
 * note (`item.note`) when there is one, then from the structured result, and
 * only then from the call's own state. Opening the card reads the sub-agent's
 * own conversation (`ctx.loadSubagent`) and draws it nested.
 */
import { Bot, MessageSquare, Reply } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/primitives'
import type { ChatContext, ChatItem, ToolItem } from '../../../../../agent/renderer/chat/items'
import { ItemRow } from '../ItemRow'
import type { ToolRenderer } from '../registry'
import {
  argsOf,
  arr,
  compactNumber,
  countLabel,
  dataOf,
  durationLabel,
  firstLine,
  firstStr,
  isRec,
  num,
  textOf,
  unwrap,
} from './coerce'
import { Caption, CodeBlock, Disclosure, ErrorPane, Markdown, Stack } from './parts'
import { stateOf, verb, type CardView } from './view'

export type AgentStatus = 'running' | 'completed' | 'failed' | 'declined' | 'spawned'

const ACK = /^\s*(Async agent launched|Spawned successfully|Fork started)/i

/** Where the sub-agent stands. */
export function agentStatus(item: ToolItem): AgentStatus {
  const state = stateOf(item)
  if (state === 'rejected') return 'declined'
  const note = typeof item.note?.status === 'string' ? item.note.status.toLowerCase() : ''
  if (/fail|error|kill|stop|cancel|timeout|timed/.test(note)) return 'failed'
  if (/complet|done|success|finish/.test(note)) return 'completed'
  if (state === 'error') return 'failed'
  if (state === 'pending') return 'running'
  const status = firstStr(dataOf(item), ['status'])
  if (status === 'async_launched') return 'running'
  if (status === 'teammate_spawned') return 'spawned'
  return 'completed'
}

function agentIdOf(item: ToolItem): string | undefined {
  const data = dataOf(item)
  const id = firstStr(data, ['agentId', 'agent_id'])
  if (id !== undefined) return id
  const m = /agentId:\s*([A-Za-z0-9_-]+)/.exec(textOf(item))
  return m?.[1]
}

function usageChips(item: ToolItem): string[] {
  const data = dataOf(item)
  const text = textOf(item)
  const tail = (key: string): number | undefined => {
    const m = new RegExp(`${key}:\\s*(\\d+)`).exec(text)
    return m === null ? undefined : Number(m[1])
  }
  const tools = num(data.totalToolUseCount) ?? tail('tool_uses')
  const tokens = num(data.totalTokens) ?? tail('subagent_tokens')
  const took = num(data.totalDurationMs) ?? tail('duration_ms')
  const chips: string[] = []
  if (tools !== undefined) chips.push(countLabel(tools, 'tool'))
  if (tokens !== undefined) chips.push(`${compactNumber(tokens)} tokens`)
  if (took !== undefined) chips.push(durationLabel(took))
  return chips
}

/** What the sub-agent answered, when the call carries it. */
function answerOf(item: ToolItem): string {
  const data = dataOf(item)
  const parts = arr(data.content)
    .map((c) => firstStr(c, ['text']))
    .filter((t): t is string => t !== undefined)
  if (parts.length > 0) return parts.join('\n\n')
  const note = typeof item.note?.summary === 'string' ? item.note.summary : ''
  if (note.trim() !== '') return note
  const text = unwrap(textOf(item))
    .replace(/<usage>[\s\S]*?<\/usage>/, '')
    .trim()
  return ACK.test(text) ? '' : text
}

const PAGE = 100

/** The sub-agent's conversation, read when the card is opened. */
function SubagentThread({
  agentId,
  ctx,
  refreshKey,
}: {
  agentId: string
  ctx: ChatContext
  refreshKey: string
}): React.JSX.Element {
  const [phase, setPhase] = useState<
    { kind: 'loading' } | { kind: 'ready'; items: ChatItem[] } | { kind: 'failed' }
  >({ kind: 'loading' })
  const [all, setAll] = useState(false)
  // The function may be a new one on every render of the chat: reading it
  // through a ref keeps the thread from reloading each time.
  const load = useRef(ctx?.loadSubagent)
  load.current = ctx?.loadSubagent
  useEffect(() => {
    let live = true
    const read = typeof load.current === 'function' ? load.current : undefined
    if (read === undefined) {
      setPhase({ kind: 'failed' })
      return
    }
    void Promise.resolve()
      .then(() => read(agentId))
      .then((items) => {
        if (!live) return
        setPhase(Array.isArray(items) ? { kind: 'ready', items } : { kind: 'failed' })
      })
      .catch(() => {
        if (live) setPhase({ kind: 'failed' })
      })
    return () => {
      live = false
    }
  }, [agentId, ctx?.sessionId, refreshKey])

  if (phase.kind === 'loading') {
    return (
      <p className="text-xs text-muted-foreground" data-chat-thread="loading">
        Reading its conversation…
      </p>
    )
  }
  if (phase.kind === 'failed') {
    return (
      <p className="text-xs text-muted-foreground" data-chat-thread="failed">
        Its conversation could not be read.
      </p>
    )
  }
  if (phase.items.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-chat-thread="empty">
        Nothing recorded of it yet.
      </p>
    )
  }
  const shown = all ? phase.items : phase.items.slice(0, PAGE)
  return (
    <div className="flex flex-col gap-1" data-chat-thread="ready">
      <Caption>Conversation</Caption>
      <div className="flex max-h-96 flex-col gap-2 overflow-y-auto rounded-lg bg-muted/30 p-2">
        {shown.map((child, i) => (
          <ItemRow
            key={`${i}:${isRec(child) ? String(child.id) : i}`}
            item={child}
            ctx={ctx}
            depth={1}
          />
        ))}
        {phase.items.length > PAGE && (
          <Button
            variant="ghost"
            size="xs"
            aria-expanded={all}
            className="w-fit text-muted-foreground"
            onClick={() => setAll((v) => !v)}
          >
            {all ? 'Show fewer' : `Show all (${phase.items.length - PAGE} more)`}
          </Button>
        )}
      </div>
    </div>
  )
}

export const agentRenderer: ToolRenderer = (item, ctx) => {
  const args = argsOf(item)
  const data = dataOf(item)
  const description = firstStr(args, ['description', 'name'])
  const prompt = firstStr(args, ['prompt'])
  if (description === undefined && prompt === undefined && item.summary === '') return null
  const state = stateOf(item)
  const status = agentStatus(item)
  const type = firstStr(args, ['subagent_type']) ?? firstStr(data, ['agentType', 'agent_type'])
  const model = firstStr(data, ['resolvedModel', 'model']) ?? firstStr(args, ['model'])
  const agentId = agentIdOf(item)
  const answer = state === 'done' ? answerOf(item) : ''

  const chips: string[] = []
  if (type !== undefined) chips.push(type)
  chips.push(status === 'spawned' ? 'teammate' : status)
  if (model !== undefined) chips.push(model)
  chips.push(...usageChips(item))

  const view: CardView = {
    label:
      status === 'running'
        ? 'Delegating'
        : status === 'failed'
          ? 'Agent failed'
          : status === 'declined'
            ? 'Declined agent'
            : 'Delegated',
    icon: Bot,
    summary: description ?? (prompt !== undefined ? firstLine(prompt) : item.summary),
    chips,
    busy: status === 'running',
    body: (
      <Stack>
        {prompt !== undefined && (
          <Disclosure label="Prompt">
            <CodeBlock text={prompt} lines={40} chars={3000} label="Prompt" />
          </Disclosure>
        )}
        {agentId !== undefined && status !== 'declined' && (
          <SubagentThread agentId={agentId} ctx={ctx} refreshKey={status} />
        )}
        {state === 'error' && <ErrorPane item={item} />}
        {status === 'running' && agentId === undefined && state !== 'pending' && (
          <Caption>Running in the background.</Caption>
        )}
        {answer !== '' && (
          <>
            <Caption>Result</Caption>
            <Markdown text={answer} lines={20} chars={2000} />
          </>
        )}
      </Stack>
    ),
  }
  return view
}

export const sendMessageRenderer: ToolRenderer = (item) => {
  const args = argsOf(item)
  const to = firstStr(args, ['to', 'recipient'])
  const message = firstStr(args, ['message', 'content', 'summary'])
  if (to === undefined && message === undefined) return null
  const state = stateOf(item)
  const gist = firstStr(args, ['summary'])
  const view: CardView = {
    label: verb(item, 'Messaging', 'Messaged'),
    icon: MessageSquare,
    summary: to === undefined ? firstLine(message ?? '') : to,
    chips: gist !== undefined && to !== undefined ? [gist.slice(0, 60)] : [],
    body: (
      <Stack>
        {message !== undefined && <Markdown text={message} lines={12} chars={1000} />}
        {state === 'error' && <ErrorPane item={item} />}
      </Stack>
    ),
  }
  return view
}

export const handbackRenderer: ToolRenderer = (item) => {
  const message = firstStr(argsOf(item), ['message'])
  if (message === undefined) return null
  const state = stateOf(item)
  const view: CardView = {
    label: verb(item, 'Handing back', 'Handed back'),
    icon: Reply,
    summary: firstLine(message),
    chips: [],
    body: (
      <Stack>
        <Markdown text={message} lines={40} chars={4000} />
        {state === 'error' && <ErrorPane item={item} />}
      </Stack>
    ),
  }
  return view
}
