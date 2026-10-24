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
import { CAP, mcpName, toolView, type ToolView } from './tool-views'

export type { DiffLine, FileDiff, PathMatch, ToolView } from './tool-views'

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
  'read' | 'edit' | 'search' | 'execute' | 'fetch' | 'agent' | 'skill' | 'mcp' | 'other'

/** `denied`: Claude Code's rules, a hook or the person said no. */
export type ToolStatus = 'running' | 'done' | 'failed' | 'denied'

/** One entry of a TodoWrite list. */
export interface TodoEntry {
  text: string
  /** The present tense, while in progress: "Running the tests". */
  active?: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** A file the person sent with a message, as the bubble names it. */
export interface Attachment {
  name: string
  kind: 'image' | 'file' | 'document'
  mediaType?: string
  size?: number
}

/** What a status line is about: picks its icon. */
export type StatusIcon =
  'plan' | 'compact' | 'retry' | 'limit' | 'hook' | 'stop' | 'denied' | 'command' | 'info'

/** What Claude Code said it runs with, from its `init`. */
export interface SessionInfo {
  tools: string[]
  mcpServers: { name: string; status: string }[]
  version?: string
  model?: string
}

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
  | { kind: 'user'; id: string; text: string; at: number; attachments?: Attachment[] }
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
      /** The person stopped it. */
      interrupted?: boolean
    }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean }
  /** Thinking, timed; its text is empty when Claude Code keeps it to itself. */
  | {
      kind: 'reasoning'
      id: string
      text: string
      streaming: boolean
      startedAt?: number
      endedAt?: number
    }
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
      /** What the step opens into: output, lines read, a diff. */
      view?: ToolView
      /** The call's input, capped: what its view is rebuilt from. */
      input?: Record<string, unknown>
      /** The subagent call (`Agent`/`Task`) this one ran inside. */
      parentId?: string
    }
  /** A TodoWrite list: one per turn, updated in place. */
  | { kind: 'todos'; id: string; todos: TodoEntry[] }
  /** ExitPlanMode's plan, and its approval while Claude Code asks for it. */
  | {
      kind: 'plan'
      id: string
      plan: string
      status: 'proposed' | 'pending' | 'approved' | 'rejected'
      requestId?: string
      /** Claude Code offered to accept edits from here on. */
      canAcceptEdits?: boolean
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
      /** The tool call it asks about. */
      callId?: string
    }
  | {
      kind: 'question'
      id: string
      requestId: string
      questions: Question[]
      status: 'pending' | 'answered' | 'skipped' | 'cancelled'
      answers?: Record<string, string>
    }
  | {
      kind: 'status'
      id: string
      text: string
      icon?: StatusIcon
      tone?: 'warning' | 'destructive'
      /** A longer look, behind the line. */
      detail?: string
    }
  | { kind: 'error'; id: string; text: string }

/** What a driver reports, as the transcript draws it. Paths are already vault-relative. */
export type ChatEvent =
  | { type: 'user'; id: string; text: string; at: number; attachments?: Attachment[] }
  | { type: 'turn-start'; id: string; at: number }
  | {
      type: 'turn-end'
      at: number
      failed?: boolean
      interrupted?: boolean
      model?: string
      usage?: TurnUsage
    }
  | { type: 'text'; delta: string }
  | { type: 'text-done'; text?: string }
  | { type: 'reasoning'; delta: string; at?: number }
  | { type: 'reasoning-done'; at?: number }
  | {
      type: 'tool-start'
      callId: string
      name: string
      input: Record<string, unknown>
      parentId?: string
    }
  | {
      type: 'tool-input'
      callId: string
      name: string
      input: Record<string, unknown>
      parentId?: string
    }
  | {
      type: 'tool-end'
      callId: string
      ok: boolean
      detail?: string
      /** Claude Code's structured result (`tool_use_result`). */
      result?: unknown
    }
  /** Claude Code's rules, a hook or the person refused the call. */
  | { type: 'tool-denied'; callId: string }
  | {
      type: 'approval'
      requestId: string
      name: string
      input: Record<string, unknown>
      canAlways: boolean
      callId?: string
      /** The modes Claude Code offered to switch to (`setMode`). */
      modes?: string[]
    }
  | { type: 'question'; requestId: string; questions: Question[] }
  | { type: 'resolved'; requestId: string; status: ApprovalStatus | 'answered' | 'skipped' }
  /** Claude Code's permission mode changed; `from` is the one before. */
  | { type: 'mode'; mode: string; from?: string }
  | {
      type: 'status'
      text: string
      icon?: StatusIcon
      tone?: 'warning' | 'destructive'
      detail?: string
    }
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
  /** Kept above the day groups in the session list. */
  pinned: boolean
  /** Claude Code's own conversation id (what `--resume` takes), once the
   *  first turn has started one. */
  conversationId?: string
  /** The person has kept or reverted what the last turn changed. */
  reviewed: boolean
  /** Its process is running now. */
  alive: boolean
  contextPercent?: number
  /** What its last process said it runs with. */
  info?: SessionInfo
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
  if (mcpName(name) !== null) return 'mcp'
  return 'other'
}

/** "Get forecast": a tool's own name, as words. */
const words = (name: string): string => {
  const spaced = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
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
    case 'notebookread':
      return { title: 'Read', active: 'Reading', subject: rel }
    case 'ls':
      return { title: 'Listed', active: 'Listing', subject: rel }
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
      return { title: 'Updated the todo list', active: 'Updating the todo list' }
    case 'exitplanmode':
      return { title: 'Proposed a plan', active: 'Writing a plan' }
    case 'enterplanmode':
      return { title: 'Entered plan mode', active: 'Entering plan mode' }
    case 'toolsearch':
      return { title: 'Loaded tools', active: 'Loading tools', subject: str(input, 'query') }
    case 'askuserquestion':
      return { title: 'Asked you', active: 'Asking you' }
    case 'bashoutput':
      return {
        title: 'Read the output of',
        active: 'Reading the output of',
        subject: str(input, 'bash_id', 'shell_id'),
      }
    case 'killshell':
    case 'killbash':
    case 'taskstop':
      return { title: 'Stopped a background task', active: 'Stopping a background task' }
    case 'slashcommand':
      return { title: 'Ran', active: 'Running', subject: str(input, 'command') }
    case 'monitor':
      return { title: 'Watched', active: 'Watching', subject: str(input, 'description', 'command') }
    case 'enterworktree':
      return { title: 'Moved to a worktree', active: 'Moving to a worktree' }
    case 'exitworktree':
      return { title: 'Left the worktree', active: 'Leaving the worktree' }
    case 'croncreate':
      return { title: 'Scheduled', active: 'Scheduling', subject: str(input, 'prompt', 'schedule') }
    case 'crondelete':
      return { title: 'Removed a schedule', active: 'Removing a schedule' }
    case 'cronlist':
      return { title: 'Listed schedules', active: 'Listing schedules' }
    case 'schedulewakeup':
      return { title: 'Set a wake-up', active: 'Setting a wake-up' }
    case 'sendmessage':
      return { title: 'Sent a message', active: 'Sending a message' }
    case 'listagents':
      return { title: 'Listed agents', active: 'Listing agents' }
    case 'pushnotification':
      return { title: 'Sent a notification', active: 'Sending a notification' }
    default: {
      const mcp = mcpName(name)
      const pretty = words(mcp === null ? name : mcp.tool)
      const lower = pretty.charAt(0).toLowerCase() + pretty.slice(1)
      if (mcp !== null && rel === undefined) {
        return { title: `Used ${lower} from`, active: `Using ${lower} from`, subject: mcp.server }
      }
      return { title: `Used ${lower}`, active: `Using ${lower}`, subject: rel }
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
  const mcp = mcpName(name)
  if (mcp !== null) {
    const tool = words(mcp.tool)
    return { verb: `Use ${tool.charAt(0).toLowerCase()}${tool.slice(1)} from`, subject: mcp.server }
  }
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

/** TodoWrite's list, read defensively; null when it has none. */
export function todosOf(input: Record<string, unknown>): TodoEntry[] | null {
  const raw = input['todos']
  if (!Array.isArray(raw)) return null
  const out: TodoEntry[] = []
  for (const t of raw) {
    if (t === null || typeof t !== 'object') continue
    const r = t as Record<string, unknown>
    const text = [r['content'], r['text'], r['activeForm']].find(
      (v): v is string => typeof v === 'string' && v.trim() !== '',
    )
    if (text === undefined) continue
    const s = String(r['status'] ?? 'pending')
      .toLowerCase()
      .replace(/[\s_-]+/g, '')
    const status: TodoEntry['status'] =
      s === 'completed' || s === 'done' || s === 'complete'
        ? 'completed'
        : s === 'inprogress' || s === 'active'
          ? 'in_progress'
          : 'pending'
    const active =
      typeof r['activeForm'] === 'string' && r['activeForm'] !== text ? r['activeForm'] : undefined
    out.push({ text: text.trim(), status, ...(active === undefined ? {} : { active }) })
  }
  return out
}

/** A tool's input as the transcript keeps it: long text cut, so a written
 *  file is not kept twice. */
export function capInput(input: Record<string, unknown>): Record<string, unknown> {
  const cut = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return v.length > CAP.textChars ? `${v.slice(0, CAP.textChars)}…` : v
    if (Array.isArray(v)) return depth > 4 ? [] : v.slice(0, 100).map((x) => cut(x, depth + 1))
    if (v !== null && typeof v === 'object') {
      if (depth > 4) return {}
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v)) out[k] = cut(x, depth + 1)
      return out
    }
    return v
  }
  return cut(input, 0) as Record<string, unknown>
}

const hasPatch = (result: unknown): boolean => {
  if (result === null || typeof result !== 'object') return false
  const r = result as Record<string, unknown>
  return (
    (Array.isArray(r['structuredPatch']) && r['structuredPatch'].length > 0) ||
    r['type'] === 'create' ||
    typeof r['old_source'] === 'string' ||
    typeof r['originalFile'] === 'string'
  )
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

  /** The turn the transcript is in now: what a todo list is kept per. */
  const currentTurn = (): string => {
    for (let i = next.length - 1; i >= 0; i--) {
      const item = next[i]!
      if (item.kind === 'turn') return item.id
      if (item.kind === 'user') break
    }
    return 'lead'
  }
  /** Prose before a tool call is finished: the call starts its own row. */
  const closeProse = (): void => {
    const prose = lastOf(next, 'assistant')
    if (prose !== undefined && prose.streaming) put({ ...prose, streaming: false })
  }

  switch (event.type) {
    case 'user':
      put({
        kind: 'user',
        id: event.id,
        text: event.text,
        at: event.at,
        ...(event.attachments === undefined || event.attachments.length === 0
          ? {}
          : { attachments: event.attachments }),
      })
      break
    case 'turn-start':
      put({ kind: 'turn', id: event.id, startedAt: event.at })
      break
    case 'turn-end': {
      // Whatever was still streaming has stopped with the turn.
      for (const item of next) {
        if (item.kind === 'assistant' && item.streaming) put({ ...item, streaming: false })
        if (item.kind === 'reasoning' && item.streaming) {
          put({ ...item, streaming: false, endedAt: item.endedAt ?? event.at })
        }
        if (item.kind === 'tool' && item.status === 'running') put({ ...item, status: 'done' })
        if (item.kind === 'approval' && item.status === 'pending')
          put({ ...item, status: 'cancelled' })
        if (item.kind === 'question' && item.status === 'pending')
          put({ ...item, status: 'cancelled' })
        if (item.kind === 'plan' && item.status === 'pending') put({ ...item, status: 'proposed' })
      }
      const turn = [...next].reverse().find((i) => i.kind === 'turn')
      if (turn?.kind === 'turn' && turn.endedAt === undefined) {
        put({
          ...turn,
          endedAt: event.at,
          ...(event.failed ? { failed: true } : {}),
          ...(event.interrupted ? { interrupted: true } : {}),
          ...(event.model === undefined ? {} : { model: event.model }),
          ...(event.usage === undefined ? {} : { usage: event.usage }),
        })
        if (event.interrupted)
          put({ kind: 'status', id: nextItemId('s'), text: 'Stopped', icon: 'stop' })
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
      else {
        put({
          kind: 'reasoning',
          id: nextItemId('r'),
          text: event.delta,
          streaming: true,
          ...(event.at === undefined ? {} : { startedAt: event.at }),
        })
      }
      break
    }
    case 'reasoning-done': {
      const open = lastOf(next, 'reasoning')
      if (open !== undefined && open.streaming) {
        put({ ...open, streaming: false, ...(event.at === undefined ? {} : { endedAt: event.at }) })
      }
      break
    }
    case 'tool-start':
    case 'tool-input': {
      closeProse()
      const lower = event.name.toLowerCase()
      if (lower === 'todowrite') {
        // One list per turn, redrawn in place as Claude Code ticks it off.
        const todos = todosOf(event.input)
        if (todos !== null) {
          const id = `todos-${currentTurn()}`
          put({ kind: 'todos', id, todos })
        }
        break
      }
      if (lower === 'exitplanmode') {
        const plan = typeof event.input['plan'] === 'string' ? event.input['plan'] : ''
        const existing = find('plan', (i) => i.id === event.callId)
        put({
          kind: 'plan',
          id: event.callId,
          plan: plan === '' ? (existing?.plan ?? '') : plan,
          status: existing?.status ?? 'proposed',
          ...(existing?.requestId === undefined ? {} : { requestId: existing.requestId }),
          ...(existing?.canAcceptEdits === undefined
            ? {}
            : { canAcceptEdits: existing.canAcceptEdits }),
        })
        break
      }
      // Plan mode is drawn from Claude Code's own mode change (`mode`).
      if (lower === 'enterplanmode') break
      const existing = find('tool', (i) => i.id === event.callId)
      const d = describeTool(event.name, event.input, root)
      const view = toolView(event.name, event.input, root)
      const parentId = event.parentId ?? existing?.parentId
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
        ...(existing?.status !== undefined &&
        existing.status !== 'running' &&
        existing.view !== undefined
          ? { view: existing.view }
          : view === undefined
            ? {}
            : { view }),
        input: capInput(event.input),
        ...(parentId === undefined ? {} : { parentId }),
      })
      break
    }
    case 'tool-end': {
      const plan = find('plan', (i) => i.id === event.callId)
      if (plan !== undefined) {
        if (plan.status !== 'approved' && plan.status !== 'rejected') {
          put({ ...plan, status: event.ok ? 'approved' : 'rejected' })
        }
        break
      }
      const tool = find('tool', (i) => i.id === event.callId)
      if (tool !== undefined) {
        const detail = trimDetail(event.detail)
        const fresh = toolView(tool.tool, tool.input ?? {}, root, {
          ok: event.ok,
          ...(event.detail === undefined ? {} : { output: event.detail }),
          ...(event.result === undefined ? {} : { result: event.result }),
        })
        // An edit's diff from its input stands unless the result brings the
        // real hunks: the kept input is capped, the call's own was whole.
        const keep =
          tool.view !== undefined &&
          (fresh === undefined || (fresh.type === 'diff' && !hasPatch(event.result)))
        const view = keep ? tool.view : fresh
        put({
          ...tool,
          status: tool.status === 'denied' ? 'denied' : event.ok ? 'done' : 'failed',
          ...(detail === undefined ? {} : { detail }),
          ...(view === undefined ? {} : { view }),
        })
      }
      break
    }
    case 'tool-denied': {
      const tool = find('tool', (i) => i.id === event.callId)
      if (tool !== undefined) put({ ...tool, status: 'denied' })
      break
    }
    case 'approval': {
      if (event.name === 'ExitPlanMode') {
        // The plan's own card asks: Approve, or Keep planning.
        const plan =
          (event.callId === undefined ? undefined : find('plan', (i) => i.id === event.callId)) ??
          [...next]
            .reverse()
            .find((i): i is Extract<TranscriptItem, { kind: 'plan' }> => i.kind === 'plan')
        const text = typeof event.input['plan'] === 'string' ? event.input['plan'] : ''
        put({
          kind: 'plan',
          id: plan?.id ?? event.callId ?? `plan-${event.requestId}`,
          plan: text === '' ? (plan?.plan ?? '') : text,
          status: 'pending',
          requestId: event.requestId,
          ...((event.modes ?? []).includes('acceptEdits') ? { canAcceptEdits: true } : {}),
        })
        break
      }
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
        ...(event.callId === undefined ? {} : { callId: event.callId }),
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
      const plan = find('plan', (i) => i.requestId === event.requestId)
      if (plan !== undefined) {
        const status =
          event.status === 'allowed' || event.status === 'always'
            ? 'approved'
            : event.status === 'denied'
              ? 'rejected'
              : 'proposed'
        put({ ...plan, status })
        break
      }
      const approval = find('approval', (i) => i.requestId === event.requestId)
      if (approval !== undefined && event.status !== 'answered' && event.status !== 'skipped') {
        put({ ...approval, status: event.status })
        if (event.status === 'denied' && approval.callId !== undefined) {
          const tool = find('tool', (i) => i.id === approval.callId)
          if (tool !== undefined) put({ ...tool, status: 'denied' })
        }
      }
      const question = find('question', (i) => i.requestId === event.requestId)
      if (question !== undefined) {
        const status =
          event.status === 'answered' || event.status === 'skipped' ? event.status : 'cancelled'
        put({ ...question, status })
      }
      break
    }
    case 'mode': {
      if (event.from === undefined || event.from === event.mode) break
      if (event.mode === 'plan') {
        put({ kind: 'status', id: nextItemId('s'), text: 'Entered plan mode', icon: 'plan' })
      } else if (event.from === 'plan') {
        put({
          kind: 'status',
          id: nextItemId('s'),
          text:
            event.mode === 'acceptEdits' ? 'Exited plan mode, accepting edits' : 'Exited plan mode',
          icon: 'plan',
        })
      }
      break
    }
    case 'status':
      put({
        kind: 'status',
        id: nextItemId('s'),
        text: event.text,
        ...(event.icon === undefined ? {} : { icon: event.icon }),
        ...(event.tone === undefined ? {} : { tone: event.tone }),
        ...(event.detail === undefined ? {} : { detail: event.detail }),
      })
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
