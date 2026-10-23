/**
 * A chat session as both sides of the chat plugin see it
 * (docs/features/chat.md).
 *
 * A chat session is Claude Code run on its structured channel
 * (`stream-json`). Main turns what Claude Code says into
 * **transcript items** with `applyChatEvent`; the renderer draws them. The
 * items are Holi's own record of what it showed, kept on this machine.
 *
 * The item shapes and the tool phrasing follow MonoCode's transcript
 * (MIT, Copyright (c) 2026 Nick; see NOTICE.md): a step per tool call, read
 * as a sentence, with the one in flight in the present tense.
 *
 * Pure and browser-safe: no Node, no Electron, no React.
 */

/** Claude Code's own permission modes Holi offers. Never `bypassPermissions`:
 *  every mode here still asks through Claude Code's rules. */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan'

export const PERMISSION_MODES: readonly { value: PermissionMode; label: string; hint: string }[] = [
  { value: 'default', label: 'Ask first', hint: 'Asks before edits and commands' },
  { value: 'acceptEdits', label: 'Accept edits', hint: 'Edits files without asking' },
  { value: 'plan', label: 'Plan only', hint: 'Reads and plans, changes nothing' },
]

/** Claude Code's effort levels (`--effort`). Absent is Claude Code's own default. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const EFFORTS: readonly { value: Effort; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
]

export const isEffort = (value: unknown): value is Effort => EFFORTS.some((e) => e.value === value)

/**
 * A model as a person reads it: `claude-opus-5-5` is "Opus 5.5", an alias
 * (`opus`) is "Opus", and anything else is shown as it is. The id is
 * Claude Code's, so no table of models is kept.
 */
export function modelLabel(id: string): string {
  const name = id.replace(/\[.*\]$/, '').trim()
  const family = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1)
  // claude-opus-5-5, claude-sonnet-4-5-20250929, claude-haiku-4
  const modern = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{6,})?$/.exec(name)
  if (modern !== null) {
    return `${family(modern[1]!)} ${modern[2]}${modern[3] === undefined ? '' : `.${modern[3]}`}`
  }
  // claude-3-5-sonnet-20241022
  const older = /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)(?:-\d{6,})?$/.exec(name)
  if (older !== null) {
    return `${family(older[3]!)} ${older[1]}${older[2] === undefined ? '' : `.${older[2]}`}`
  }
  if (/^[a-z]+$/.test(name)) return family(name)
  return name
}

/** What one finished turn cost in tokens, from Claude Code's `result`. After
 *  MonoCode's `TurnMetrics` (MIT, Copyright (c) 2026 Nick; see NOTICE.md). */
export interface TurnUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  /** Share of the input served from the prompt cache, 0 to 100. */
  cacheHitPercent?: number
}

/** One entry of the composer's `/` menu: what Claude Code runs as `/<name>`. */
export interface ChatCommand {
  name: string
  description?: string
  /** Built into Claude Code, a skill, or a command file. */
  kind: 'builtin' | 'skill' | 'command'
  /** Where it was found: the vault's `.claude/`, the vault's Claude Code
   *  config directory, or Claude Code itself. */
  scope: 'builtin' | 'vault' | 'user' | 'plugin'
}

/** Built-ins that do something in a chat (Claude Code's print mode), with
 *  their own words. The TUI-only ones (`/doctor`, `/color`) are not here.
 *  Main lists them before any session has said what it runs; the composer
 *  falls back to them when the vault's list cannot be read. */
export const BUILTIN_COMMANDS: readonly ChatCommand[] = [
  { name: 'compact', description: 'Summarise the conversation so far to free up context' },
  { name: 'context', description: 'Show what fills the context window' },
  { name: 'init', description: 'Write an AGENTS.md that describes this vault' },
  { name: 'review', description: 'Review a pull request' },
  { name: 'security-review', description: 'Review the pending changes for security issues' },
  { name: 'usage', description: 'Show plan usage and limits' },
  { name: 'cost', description: 'Show what this session has cost' },
].map((c) => ({ ...c, kind: 'builtin', scope: 'builtin' }) as const)

/** What a session is doing, as the sidebar groups it. */
export type ChatState = 'needs-you' | 'working' | 'idle'

/** A tool call's family: picks its icon and its verb. */
export type ToolKind =
  'read' | 'edit' | 'search' | 'execute' | 'fetch' | 'agent' | 'skill' | 'other'

export type ToolStatus = 'running' | 'done' | 'failed'

export type ApprovalStatus = 'pending' | 'allowed' | 'always' | 'denied' | 'cancelled'

export interface QuestionOption {
  label: string
  description?: string
}

export interface Question {
  question: string
  header?: string
  options: QuestionOption[]
  multiSelect: boolean
}

export type TranscriptItem =
  | { kind: 'user'; id: string; text: string; at: number }
  /** One turn's bracket: "Working…" while open, "Worked for 6s" once shut. */
  | {
      kind: 'turn'
      id: string
      startedAt: number
      endedAt?: number
      failed?: boolean
      /** The model that answered, as Claude Code names it. */
      model?: string
      usage?: TurnUsage
    }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean }
  | { kind: 'reasoning'; id: string; text: string; streaming: boolean }
  | {
      kind: 'tool'
      id: string
      tool: string
      toolKind: ToolKind
      /** Past tense, once done: "Read Meetings/Week kickoff.md". */
      title: string
      /** Present tense, while running: "Reading Meetings/Week kickoff.md". */
      active: string
      /** The operand, drawn as code: a path, a command, a pattern. */
      subject?: string
      status: ToolStatus
      /** The tool's result text, trimmed. */
      detail?: string
    }
  | {
      kind: 'approval'
      id: string
      /** Claude Code's request id, which the answer names. */
      requestId: string
      tool: string
      /** "Run `holi google draft`?" in parts: the verb and the operand. */
      verb: string
      subject?: string
      /** A longer look at what it will do (the command, the new text). */
      detail?: string
      status: ApprovalStatus
      /** Claude Code offered a rule to remember the answer by. */
      canAlways: boolean
    }
  | {
      kind: 'question'
      id: string
      requestId: string
      questions: Question[]
      status: 'pending' | 'answered' | 'skipped' | 'cancelled'
      answers?: Record<string, string>
    }
  | { kind: 'status'; id: string; text: string }
  | { kind: 'error'; id: string; text: string }

/** What a driver reports, as the transcript draws it. Paths are already vault-relative. */
export type ChatEvent =
  | { type: 'user'; id: string; text: string; at: number }
  | { type: 'turn-start'; id: string; at: number }
  | { type: 'turn-end'; at: number; failed?: boolean; model?: string; usage?: TurnUsage }
  | { type: 'text'; delta: string }
  | { type: 'text-done'; text?: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'reasoning-done' }
  | { type: 'tool-start'; callId: string; name: string; input: Record<string, unknown> }
  | { type: 'tool-input'; callId: string; name: string; input: Record<string, unknown> }
  | { type: 'tool-end'; callId: string; ok: boolean; detail?: string }
  | {
      type: 'approval'
      requestId: string
      name: string
      input: Record<string, unknown>
      canAlways: boolean
    }
  | { type: 'question'; requestId: string; questions: Question[] }
  | { type: 'resolved'; requestId: string; status: ApprovalStatus | 'answered' | 'skipped' }
  | { type: 'status'; text: string }
  | { type: 'error'; text: string }

/** One chat session, as the sidebar and the header show it. */
export interface ChatSummary {
  id: string
  title: string
  model?: string
  effort?: Effort
  mode: PermissionMode
  state: ChatState
  /** What it is doing now, in the present tense: the step in flight. */
  step?: string
  /** What it waits on while `needs-you`: "Run holi google draft?" */
  waitingFor?: string
  createdAt: number
  updatedAt: number
  /** When its last turn ended; absent before the first does. */
  endedAt?: number
  /** Out of the sidebar, still on disk. */
  archived: boolean
  /** The person has kept or reverted what the last turn changed. */
  reviewed: boolean
  /** Its process is running now. */
  alive: boolean
  contextPercent?: number
}

// ------------------------------------------------------------------ tools

const str = (input: Record<string, unknown>, ...keys: string[]): string | undefined => {
  for (const key of keys) {
    const v = input[key]
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
  }
  return undefined
}

/** A path as the person knows it: relative to the vault when inside it. */
export function relativeTo(root: string, path: string): string {
  const prefix = root.endsWith('/') ? root : `${root}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

/** The first line of a command, capped: a heredoc is not a title. */
function oneLine(text: string, max = 80): string {
  const line = text.split('\n')[0] ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function toolKind(name: string): ToolKind {
  const n = name.toLowerCase()
  if (n === 'read' || n === 'notebookread' || n === 'ls' || n === 'view') return 'read'
  if (['write', 'edit', 'multiedit', 'notebookedit', 'apply_patch'].includes(n)) return 'edit'
  if (['glob', 'grep', 'find', 'search', 'toolsearch'].includes(n)) return 'search'
  if (n === 'bash' || n === 'shell' || n === 'exec' || n === 'bashoutput') return 'execute'
  if (n === 'webfetch' || n === 'websearch' || n === 'fetch') return 'fetch'
  if (n === 'task' || n === 'agent') return 'agent'
  if (n === 'skill') return 'skill'
  return 'other'
}

/** How a tool call reads, done and in flight, from its name and input. */
export function describeTool(
  name: string,
  input: Record<string, unknown>,
  root = '',
): { title: string; active: string; subject?: string } {
  const path = str(input, 'file_path', 'path', 'notebook_path')
  const rel = path === undefined ? undefined : relativeTo(root, path)
  switch (name.toLowerCase()) {
    case 'read':
      return { title: 'Read', active: 'Reading', subject: rel }
    case 'write':
      return { title: 'Wrote', active: 'Writing', subject: rel }
    case 'edit':
    case 'multiedit':
    case 'notebookedit':
      return { title: 'Edited', active: 'Editing', subject: rel }
    case 'glob':
      return { title: 'Looked for', active: 'Looking for', subject: str(input, 'pattern') }
    case 'grep':
      return {
        title: 'Searched the vault for',
        active: 'Searching for',
        subject: str(input, 'pattern'),
      }
    case 'bash': {
      const description = str(input, 'description')
      const command = str(input, 'command')
      if (description !== undefined) {
        return { title: description, active: description, subject: undefined }
      }
      return { title: 'Ran', active: 'Running', subject: command && oneLine(command) }
    }
    case 'webfetch':
      return { title: 'Fetched', active: 'Fetching', subject: str(input, 'url') }
    case 'websearch':
      return {
        title: 'Searched the web for',
        active: 'Searching the web for',
        subject: str(input, 'query'),
      }
    case 'task':
    case 'agent':
      return {
        title: str(input, 'description') ?? 'Ran a subagent',
        active: str(input, 'description') ?? 'Running a subagent',
      }
    case 'skill':
      return {
        title: 'Used the skill',
        active: 'Using the skill',
        subject: str(input, 'skill', 'name'),
      }
    case 'todowrite':
      return { title: 'Updated its plan', active: 'Planning' }
    default: {
      const pretty = name.replace(/^mcp__[^_]+__/, '').replace(/_/g, ' ')
      return { title: `Used ${pretty}`, active: `Using ${pretty}`, subject: rel }
    }
  }
}

/** The approval card's question, in the shape of the mock: a verb and the
 *  thing it acts on, plus a longer look where there is one. */
export function describeApproval(
  name: string,
  input: Record<string, unknown>,
  root = '',
): { verb: string; subject?: string; detail?: string } {
  const lower = name.toLowerCase()
  if (lower === 'bash') {
    const command = str(input, 'command') ?? ''
    const description = str(input, 'description')
    return {
      verb: 'Run',
      subject: oneLine(command, 120),
      ...(description !== undefined
        ? { detail: description }
        : command.includes('\n')
          ? { detail: command }
          : {}),
    }
  }
  if (lower === 'write' || lower === 'edit' || lower === 'multiedit') {
    const path = str(input, 'file_path', 'path')
    const text = str(input, 'content', 'new_string')
    return {
      verb: lower === 'write' ? 'Write' : 'Edit',
      ...(path === undefined ? {} : { subject: relativeTo(root, path) }),
      ...(text === undefined
        ? {}
        : { detail: text.length > 600 ? `${text.slice(0, 599)}…` : text }),
    }
  }
  const d = describeTool(name, input, root)
  return { verb: `Use ${name}`, ...(d.subject === undefined ? {} : { subject: d.subject }) }
}

/** A result's text, trimmed to what a step can show. */
export function trimDetail(text: string | undefined, max = 2000): string | undefined {
  if (text === undefined) return undefined
  const t = text.trim()
  if (t === '') return undefined
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

// ---------------------------------------------------------------- reducer

let counter = 0
/** An id for an item that has none from Claude Code. Unique within a run of
 *  the process, which is all an item list needs. */
export const nextItemId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`

const lastOf = <K extends TranscriptItem['kind']>(
  items: readonly TranscriptItem[],
  kind: K,
): Extract<TranscriptItem, { kind: K }> | undefined => {
  const last = items.at(-1)
  return last?.kind === kind ? (last as Extract<TranscriptItem, { kind: K }>) : undefined
}

/**
 * One event applied to a transcript. Returns the new list and the items that
 * changed, so main sends only those. Never mutates `items`.
 *
 * `root` turns a tool's absolute paths into vault paths.
 */
export function applyChatEvent(
  items: readonly TranscriptItem[],
  event: ChatEvent,
  root = '',
): { items: TranscriptItem[]; changed: TranscriptItem[] } {
  const next = [...items]
  const changed: TranscriptItem[] = []
  const put = (item: TranscriptItem): void => {
    const at = next.findIndex((i) => i.id === item.id)
    if (at === -1) next.push(item)
    else next[at] = item
    changed.push(item)
  }
  const find = <K extends TranscriptItem['kind']>(
    kind: K,
    pred: (i: Extract<TranscriptItem, { kind: K }>) => boolean,
  ) =>
    next.find(
      (i): i is Extract<TranscriptItem, { kind: K }> =>
        i.kind === kind && pred(i as Extract<TranscriptItem, { kind: K }>),
    )

  switch (event.type) {
    case 'user':
      put({ kind: 'user', id: event.id, text: event.text, at: event.at })
      break
    case 'turn-start':
      put({ kind: 'turn', id: event.id, startedAt: event.at })
      break
    case 'turn-end': {
      // Whatever was still streaming has stopped with the turn.
      for (const item of next) {
        if ((item.kind === 'assistant' || item.kind === 'reasoning') && item.streaming) {
          put({ ...item, streaming: false })
        }
        if (item.kind === 'tool' && item.status === 'running') put({ ...item, status: 'done' })
        if (item.kind === 'approval' && item.status === 'pending')
          put({ ...item, status: 'cancelled' })
        if (item.kind === 'question' && item.status === 'pending')
          put({ ...item, status: 'cancelled' })
      }
      const turn = [...next].reverse().find((i) => i.kind === 'turn')
      if (turn?.kind === 'turn' && turn.endedAt === undefined) {
        put({
          ...turn,
          endedAt: event.at,
          ...(event.failed ? { failed: true } : {}),
          ...(event.model === undefined ? {} : { model: event.model }),
          ...(event.usage === undefined ? {} : { usage: event.usage }),
        })
      }
      break
    }
    case 'text': {
      const open = lastOf(next, 'assistant')
      if (open !== undefined && open.streaming) put({ ...open, text: open.text + event.delta })
      else put({ kind: 'assistant', id: nextItemId('a'), text: event.delta, streaming: true })
      break
    }
    case 'text-done': {
      const open = lastOf(next, 'assistant')
      if (open !== undefined && open.streaming) {
        put({ ...open, text: event.text ?? open.text, streaming: false })
      } else if (event.text !== undefined && event.text.trim() !== '') {
        // Claude Code sent the whole message without deltas.
        put({ kind: 'assistant', id: nextItemId('a'), text: event.text, streaming: false })
      }
      break
    }
    case 'reasoning': {
      const open = lastOf(next, 'reasoning')
      if (open !== undefined && open.streaming) put({ ...open, text: open.text + event.delta })
      else put({ kind: 'reasoning', id: nextItemId('r'), text: event.delta, streaming: true })
      break
    }
    case 'reasoning-done': {
      const open = lastOf(next, 'reasoning')
      if (open !== undefined && open.streaming) put({ ...open, streaming: false })
      break
    }
    case 'tool-start':
    case 'tool-input': {
      // Prose before a tool call is finished: the call starts its own row.
      const prose = lastOf(next, 'assistant')
      if (prose !== undefined && prose.streaming) put({ ...prose, streaming: false })
      const existing = find('tool', (i) => i.id === event.callId)
      const d = describeTool(event.name, event.input, root)
      put({
        kind: 'tool',
        id: event.callId,
        tool: event.name,
        toolKind: toolKind(event.name),
        title: d.title,
        active: d.active,
        ...(d.subject === undefined ? {} : { subject: d.subject }),
        status: existing?.status ?? 'running',
        ...(existing?.detail === undefined ? {} : { detail: existing.detail }),
      })
      break
    }
    case 'tool-end': {
      const tool = find('tool', (i) => i.id === event.callId)
      if (tool !== undefined) {
        const detail = trimDetail(event.detail)
        put({
          ...tool,
          status: event.ok ? 'done' : 'failed',
          ...(detail === undefined ? {} : { detail }),
        })
      }
      break
    }
    case 'approval': {
      const d = describeApproval(event.name, event.input, root)
      put({
        kind: 'approval',
        id: `approval-${event.requestId}`,
        requestId: event.requestId,
        tool: event.name,
        verb: d.verb,
        ...(d.subject === undefined ? {} : { subject: d.subject }),
        ...(d.detail === undefined ? {} : { detail: d.detail }),
        status: 'pending',
        canAlways: event.canAlways,
      })
      break
    }
    case 'question':
      put({
        kind: 'question',
        id: `question-${event.requestId}`,
        requestId: event.requestId,
        questions: event.questions,
        status: 'pending',
      })
      break
    case 'resolved': {
      const approval = find('approval', (i) => i.requestId === event.requestId)
      if (approval !== undefined && event.status !== 'answered' && event.status !== 'skipped') {
        put({ ...approval, status: event.status })
      }
      const question = find('question', (i) => i.requestId === event.requestId)
      if (question !== undefined) {
        const status =
          event.status === 'answered' || event.status === 'skipped' ? event.status : 'cancelled'
        put({ ...question, status })
      }
      break
    }
    case 'status':
      put({ kind: 'status', id: nextItemId('s'), text: event.text })
      break
    case 'error': {
      // Claude Code says a failed turn's reason as its reply too: once is enough.
      const said = [...next].reverse().find((i) => i.kind === 'assistant')
      if (said?.kind === 'assistant' && said.text.trim() === event.text.trim()) break
      put({ kind: 'error', id: nextItemId('e'), text: event.text })
      break
    }
  }
  return { items: next, changed }
}

/** What a transcript says the session is doing now: the pending question, the
 *  step in flight, or nothing. */
export function transcriptNow(items: readonly TranscriptItem[]): {
  waitingFor?: string
  step?: string
} {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.kind === 'approval' && item.status === 'pending') {
      return { waitingFor: `${item.verb}${item.subject === undefined ? '' : ` ${item.subject}`}?` }
    }
    if (item.kind === 'question' && item.status === 'pending') {
      return { waitingFor: item.questions[0]?.question ?? 'A question for you' }
    }
    if (item.kind === 'turn') break
  }
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.kind === 'tool' && item.status === 'running') {
      return { step: item.subject === undefined ? item.active : `${item.active} ${item.subject}` }
    }
    if (item.kind === 'assistant' && item.streaming) return { step: 'Writing' }
    if (item.kind === 'reasoning' && item.streaming) return { step: 'Thinking' }
    if (item.kind === 'turn') break
  }
  return {}
}

/** A session's title from its first message: its first line, capped. */
export function chatTitle(text: string): string {
  const line = (text.split('\n').find((l) => l.trim() !== '') ?? '').replace(/\s+/g, ' ').trim()
  if (line === '') return 'New session'
  return line.length > 60 ? `${line.slice(0, 59)}…` : line
}

/** Whether an error is Claude Code saying this vault's config directory has
 *  no sign-in yet: each vault signs in once (docs/features/agent-config.md). */
export const needsSignIn = (text: string): boolean => /not logged in|\/login\b/i.test(text)
