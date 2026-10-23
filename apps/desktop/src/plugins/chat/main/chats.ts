/**
 * Chat sessions: Claude Code run on its structured channel, drawn as a
 * conversation in the Agents view (docs/features/chat.md).
 *
 * **One process per live session**, in the vault clone, with the environment
 * the agent plugin gives every session (`agent.target`: the vault's config
 * directory, Holi's commands on `PATH`), so it reads the same `.claude/`,
 * `AGENTS.md`, memory and hooks a background session does. It stays up
 * between turns and is let go after a while idle; the next message resumes
 * the conversation (`--resume`), which is Claude Code's.
 *
 * **Permissions are Claude Code's.** The process runs with
 * `--permission-prompt-tool stdio`: when Claude Code's own rules decide to
 * ask, the question arrives here as a `can_use_tool` request, becomes an
 * inline card, and the person's answer goes back as Claude Code's
 * `control_response`. Nothing here allows a call Claude Code would have
 * asked about.
 *
 * **Turns share the vault's bracket**: a turn starts when Holi writes the
 * message and ends at Claude Code's `result`, and both go to the agent's turn
 * coordinator (`agent.turn`), so sync pauses and the turn is recorded as a
 * commit range like any other.
 *
 * **What is kept is this machine's**: an index and each transcript, as Holi
 * showed it, under `userData/agent-chats/<vault>/`. Nothing goes in the clone.
 *
 * No Electron import: this loads under plain Node in the tests.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { jsonFileStore, type JsonFileStore } from '../../../main/plugin-api'
import {
  applyChatEvent,
  chatTitle,
  nextItemId,
  transcriptNow,
  type ChatEvent,
  type ChatSummary,
  type Effort,
  type PermissionMode,
  type TranscriptItem,
  type TurnUsage,
} from '../shared/chat'
import {
  claudeChatArgs,
  controlResponse,
  interruptRequest,
  newClaudeReader,
  parseLine,
  permissionResult,
  readClaudeRecord,
  userMessage,
  type ClaudeReader,
  type PendingPermission,
  type PermissionAnswer,
} from './claude-stream'

/** Where and how Claude Code runs in the open vault (`agent.target`). */
export interface CommandTarget {
  root: string
  env: Record<string, string>
  /** The binary, null when it is not on this machine. */
  claude: string | null
}

/** A vault's folder name under `agent-chats/`: readable, and unique by a
 *  hash of the remote. */
export function chatDirSlug(remote: string): string {
  const readable = remote
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const hash = createHash('sha1').update(remote).digest('hex').slice(0, 8)
  return readable === '' ? hash : `${readable}-${hash}`
}

/** A live process idle this long is let go; the next message resumes it. */
const IDLE_EXIT_MS = 15 * 60_000
/** Transcript writes are batched: a streamed reply changes its item per token. */
const SAVE_DEBOUNCE_MS = 800

/** What Holi keeps about one chat session in the index. */
export interface ChatRecord {
  id: string
  title: string
  model?: string
  effort?: Effort
  mode: PermissionMode
  createdAt: number
  updatedAt: number
  endedAt?: number
  archived: boolean
  /** Kept above the day groups; absent is not. */
  pinned?: boolean
  reviewed: boolean
  /** Claude Code's own conversation id, which `--resume` takes. */
  conversationId?: string
  contextPercent?: number
}

interface ChatIndex {
  chats: ChatRecord[]
  /** The `/` commands the vault's last session reported (`init`). */
  commands?: SessionCommands
}

/** What a session's `init` said it offers as `/` commands. */
export interface SessionCommands {
  names: string[]
  skills: string[]
}

function parseCommands(raw: unknown): SessionCommands | undefined {
  const r = raw as { names?: unknown; skills?: unknown } | null | undefined
  if (r === null || typeof r !== 'object' || !Array.isArray(r.names)) return undefined
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  return { names: strings(r.names), skills: strings(r.skills) }
}

function parseIndex(raw: unknown): ChatIndex {
  const list = (raw as { chats?: unknown } | null)?.chats
  if (!Array.isArray(list)) return { chats: [] }
  const commands = parseCommands((raw as { commands?: unknown }).commands)
  return {
    ...(commands === undefined ? {} : { commands }),
    chats: list.filter(
      (c): c is ChatRecord =>
        c !== null &&
        typeof c === 'object' &&
        typeof (c as ChatRecord).id === 'string' &&
        typeof (c as ChatRecord).title === 'string',
    ),
  }
}

/** Options a turn can carry. */
export interface TurnOptions {
  model?: string | null
  /** Null clears it to Claude Code's default. */
  effort?: Effort | null
  mode?: PermissionMode
}

export interface StartArgs extends TurnOptions {
  text: string
  /** Fix the id (the tests). */
  id?: string
  title?: string
}

export type ChatResult = { ok: true; id: string } | { ok: false; message: string }

export interface ChatsDeps {
  /** Where `agent-chats/` lives. */
  userData: string
  emit(remote: string, name: string, payload: unknown): void
  /** How Claude Code runs in the open vault, or null with none open. */
  target(): Promise<CommandTarget | null>
  /** A turn edge, for the vault's working set. */
  turn(id: string, active: boolean): void
  /** A process died mid-turn. */
  gone(id: string): void
  /** Injected so tests never start a real Claude Code. */
  spawnProcess?: (
    bin: string,
    args: string[],
    opts: { cwd: string; env: Record<string, string> },
  ) => ChildProcessWithoutNullStreams
  now?: () => number
  idleExitMs?: number
  log?: (msg: string) => void
}

interface Live {
  child: ChildProcessWithoutNullStreams
  reader: ClaudeReader
  buffer: string
  /** Requests waiting on the person, by request id. */
  pending: Map<string, PendingPermission>
  turnOpen: boolean
  idleTimer: ReturnType<typeof setTimeout> | null
  /** Options it was started with: a change needs a new process. */
  launchKey: string
  controlSeq: number
}

export interface Chats {
  /** Bind to the open vault's records. */
  attach(remote: string): Promise<void>
  list(): ChatSummary[]
  transcript(id: string): Promise<TranscriptItem[]>
  start(args: StartArgs): Promise<ChatResult>
  send(id: string, text: string, opts?: TurnOptions): Promise<ChatResult>
  answer(id: string, requestId: string, answer: PermissionAnswer): Promise<ChatResult>
  interrupt(id: string): Promise<ChatResult>
  update(
    id: string,
    change: {
      archived?: boolean
      pinned?: boolean
      reviewed?: boolean
      title?: string
      model?: string | null
      effort?: Effort | null
      mode?: PermissionMode
    },
  ): Promise<ChatResult>
  /**
   * Forget a chat on this machine: stop its process, drop it from the index
   * and delete Holi's transcript of it. Claude Code's own transcript, under
   * the vault's config directory, is Claude Code's and stays.
   */
  remove(id: string): Promise<ChatResult>
  /** The `/` commands the vault's last session reported, if one has run. */
  sessionCommands(): SessionCommands | null
  /** The conversation id Claude Code keeps, for "open in a terminal". */
  conversationOf(id: string): string | null
  /** Whether any session is working or waiting: what leaving costs. */
  busy(): ChatSummary[]
  /** Hear each turn end, by session id. Returns the undo. */
  onTurnEnd(listener: (id: string, failed: boolean) => void): () => void
  /** Stop every process and let go of the vault. */
  leave(): Promise<void>
}

export function createChats(deps: ChatsDeps): Chats {
  const log = deps.log ?? ((msg: string) => console.log(`[agent-chats] ${msg}`))
  const now = deps.now ?? Date.now
  const spawnProcess =
    deps.spawnProcess ??
    ((bin, args, opts) =>
      spawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] }))

  let remote: string | null = null
  let dir: string | null = null
  let store: JsonFileStore<ChatIndex> | null = null
  let records: ChatRecord[] = []
  let commands: SessionCommands | null = null
  const transcripts = new Map<string, TranscriptItem[]>()
  const dirty = new Set<string>()
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  const live = new Map<string, Live>()
  /** Items changed since the last push, per session. */
  const outbox = new Map<string, Map<string, TranscriptItem>>()
  let pushTimer: ReturnType<typeof setTimeout> | null = null
  let lastSummaries = ''
  let root = ''
  const turnEnds = new Set<(id: string, failed: boolean) => void>()

  const record = (id: string): ChatRecord | undefined => records.find((r) => r.id === id)

  function summary(r: ChatRecord): ChatSummary {
    const l = live.get(r.id)
    const items = transcripts.get(r.id) ?? []
    const nowState = transcriptNow(items)
    const state = (l?.pending.size ?? 0) > 0 ? 'needs-you' : l?.turnOpen ? 'working' : 'idle'
    return {
      id: r.id,
      title: r.title,
      ...(r.model === undefined ? {} : { model: r.model }),
      ...(r.effort === undefined ? {} : { effort: r.effort }),
      mode: r.mode,
      state,
      ...(state === 'working' && nowState.step !== undefined ? { step: nowState.step } : {}),
      ...(state === 'needs-you' && nowState.waitingFor !== undefined
        ? { waitingFor: nowState.waitingFor }
        : {}),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      ...(r.endedAt === undefined ? {} : { endedAt: r.endedAt }),
      archived: r.archived,
      pinned: r.pinned === true,
      ...(r.conversationId === undefined ? {} : { conversationId: r.conversationId }),
      reviewed: r.reviewed,
      alive: l !== undefined,
      ...(r.contextPercent === undefined ? {} : { contextPercent: r.contextPercent }),
    }
  }

  const list = (): ChatSummary[] =>
    [...records].sort((a, b) => b.updatedAt - a.updatedAt).map(summary)

  function pushList(): void {
    if (remote === null) return
    const next = list()
    const encoded = JSON.stringify(next)
    if (encoded === lastSummaries) return
    lastSummaries = encoded
    deps.emit(remote, 'chats', next)
  }

  /** Items go out on the next tick, batched: a streamed reply is many events. */
  function pushItems(id: string, items: TranscriptItem[]): void {
    let box = outbox.get(id)
    if (box === undefined) outbox.set(id, (box = new Map()))
    for (const item of items) box.set(item.id, item)
    if (pushTimer !== null) return
    pushTimer = setTimeout(() => {
      pushTimer = null
      if (remote === null) return
      for (const [chat, changed] of outbox) {
        deps.emit(remote, 'chat-items', { id: chat, items: [...changed.values()] })
      }
      outbox.clear()
      pushList()
    }, 16)
  }

  function scheduleSave(id: string): void {
    dirty.add(id)
    if (saveTimer !== null) return
    saveTimer = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS)
  }

  async function flush(): Promise<void> {
    if (saveTimer !== null) clearTimeout(saveTimer)
    saveTimer = null
    if (dir === null) return
    const ids = [...dirty]
    dirty.clear()
    await mkdir(dir, { recursive: true }).catch(() => {})
    for (const id of ids) {
      const items = transcripts.get(id)
      if (items === undefined) continue
      const file = join(dir, `${id}.json`)
      const tmp = `${file}.tmp`
      await writeFile(tmp, JSON.stringify(items))
        .then(() => rename(tmp, file))
        .catch((err: unknown) => log(`save ${id} failed: ${String(err)}`))
    }
  }

  async function saveRecord(id: string, change: (r: ChatRecord) => ChatRecord): Promise<void> {
    const at = records.findIndex((r) => r.id === id)
    if (at === -1) return
    records[at] = change(records[at]!)
    await saveIndex()
  }

  async function saveIndex(): Promise<void> {
    const snapshot = records
    const said = commands
    await store
      ?.update(() => ({ chats: snapshot, ...(said === null ? {} : { commands: said }) }))
      .catch((err: unknown) => log(`index failed: ${String(err)}`))
  }

  async function loadTranscript(id: string): Promise<TranscriptItem[]> {
    const have = transcripts.get(id)
    if (have !== undefined) return have
    if (dir === null) return []
    const text = await readFile(join(dir, `${id}.json`), 'utf8').catch(() => null)
    let items: TranscriptItem[] = []
    if (text !== null) {
      try {
        const parsed = JSON.parse(text) as unknown
        if (Array.isArray(parsed)) items = parsed as TranscriptItem[]
      } catch {
        items = []
      }
    }
    // A transcript read back after a restart has nothing in flight any more.
    const settled = applyChatEvent(items, { type: 'turn-end', at: now() }, root).items
    transcripts.set(id, settled)
    return settled
  }

  function apply(id: string, event: ChatEvent): void {
    // A chat deleted while its process wound down keeps nothing it said.
    if (record(id) === undefined) return
    const items = transcripts.get(id) ?? []
    const { items: next, changed } = applyChatEvent(items, event, root)
    transcripts.set(id, next)
    if (changed.length > 0) {
      pushItems(id, changed)
      scheduleSave(id)
    }
  }

  function write(l: Live, line: string): void {
    if (!l.child.stdin.destroyed) l.child.stdin.write(`${line}\n`)
  }

  function armIdle(id: string, l: Live): void {
    if (l.idleTimer !== null) clearTimeout(l.idleTimer)
    l.idleTimer = setTimeout(() => {
      if (!l.turnOpen && l.pending.size === 0) stopProcess(id)
    }, deps.idleExitMs ?? IDLE_EXIT_MS)
  }

  function stopProcess(id: string): void {
    const l = live.get(id)
    if (l === undefined) return
    live.delete(id)
    if (l.idleTimer !== null) clearTimeout(l.idleTimer)
    l.child.stdin.end()
    l.child.kill('SIGTERM')
  }

  function endTurn(
    id: string,
    failed: boolean,
    how: { model?: string; usage?: TurnUsage } = {},
  ): void {
    const l = live.get(id)
    if (l !== undefined) {
      l.turnOpen = false
      l.pending.clear()
      armIdle(id, l)
    }
    apply(id, {
      type: 'turn-end',
      at: now(),
      ...(failed ? { failed: true } : {}),
      ...(how.model === undefined ? {} : { model: how.model }),
      ...(how.usage === undefined ? {} : { usage: how.usage }),
    })
    const at = now()
    void saveRecord(id, (r) => ({ ...r, endedAt: at, updatedAt: at, reviewed: false })).then(
      pushList,
    )
    deps.turn(id, false)
    for (const listener of turnEnds) listener(id, failed)
  }

  function onLine(id: string, l: Live, line: string): void {
    const r = parseLine(line)
    if (r === null) return
    const res = readClaudeRecord(l.reader, r)
    if (res.sessionId !== undefined && record(id)?.conversationId !== res.sessionId) {
      void saveRecord(id, (x) => ({ ...x, conversationId: res.sessionId }))
    }
    if (res.ackRequestId !== undefined) write(l, controlResponse(res.ackRequestId, {}))
    if (res.permission !== undefined) l.pending.set(res.permission.requestId, res.permission)
    if (res.cancelRequestId !== undefined) l.pending.delete(res.cancelRequestId)
    for (const event of res.events) apply(id, event)
    if (res.contextPercent !== undefined) {
      const percent = res.contextPercent
      void saveRecord(id, (x) => ({ ...x, contextPercent: percent }))
    }
    if (res.commands !== undefined && JSON.stringify(res.commands) !== JSON.stringify(commands)) {
      commands = res.commands
      void saveIndex()
    }
    if (res.turnEnded !== undefined && l.turnOpen) {
      const { failed, model, usage } = res.turnEnded
      endTurn(id, failed, {
        ...(model === undefined ? {} : { model }),
        ...(usage === undefined ? {} : { usage }),
      })
    }
    pushList()
  }

  const launchKey = (r: ChatRecord): string =>
    JSON.stringify([r.model ?? null, r.effort ?? null, r.mode])

  async function ensureProcess(r: ChatRecord): Promise<Live | string> {
    const key = launchKey(r)
    const existing = live.get(r.id)
    if (existing !== undefined && existing.launchKey === key) return existing
    // A changed model or mode needs a new process; the conversation
    // carries over through `--resume`.
    if (existing !== undefined) {
      if (existing.turnOpen) return 'Wait for the turn to finish before changing how it runs.'
      stopProcess(r.id)
    }
    const target = await deps.target().catch(() => null)
    if (target === null) return 'No vault is open.'
    if (target.claude === null) return 'Claude Code is not installed on this machine.'
    const resume = r.conversationId
    const args = claudeChatArgs({
      mode: r.mode,
      ...(r.model === undefined ? {} : { model: r.model }),
      ...(r.effort === undefined ? {} : { effort: r.effort }),
      ...(resume === undefined ? { sessionId: r.id } : { resume }),
    })
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawnProcess(target.claude, args, { cwd: target.root, env: target.env })
    } catch (err) {
      return `Could not start Claude Code: ${String(err)}`
    }
    const l: Live = {
      child,
      reader: newClaudeReader(),
      buffer: '',
      pending: new Map(),
      turnOpen: false,
      idleTimer: null,
      launchKey: key,
      controlSeq: 0,
    }
    live.set(r.id, l)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      l.buffer += chunk
      let at: number
      while ((at = l.buffer.indexOf('\n')) !== -1) {
        const line = l.buffer.slice(0, at)
        l.buffer = l.buffer.slice(at + 1)
        try {
          onLine(r.id, l, line)
        } catch (err) {
          log(`line failed: ${String(err)}`)
        }
      }
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000)
    })
    child.on('error', (err) => log(`${r.id}: ${String(err)}`))
    child.on('exit', (code) => {
      if (live.get(r.id) === l) live.delete(r.id)
      if (l.idleTimer !== null) clearTimeout(l.idleTimer)
      if (l.turnOpen) {
        l.turnOpen = false
        deps.gone(r.id)
        const why = stderr.trim().split('\n').at(-1)
        apply(r.id, {
          type: 'error',
          text: `The session stopped${code === null ? '' : ` (exit ${code})`}${why ? `: ${why}` : '.'}`,
        })
        apply(r.id, { type: 'turn-end', at: now(), failed: true })
        for (const listener of turnEnds) listener(r.id, true)
      }
      pushList()
    })
    return l
  }

  async function turn(r: ChatRecord, text: string): Promise<ChatResult> {
    const l = await ensureProcess(r)
    if (typeof l === 'string') {
      apply(r.id, { type: 'error', text: l })
      pushList()
      return { ok: false, message: l }
    }
    if (l.turnOpen) return { ok: false, message: 'It is still working on the last message.' }
    const at = now()
    apply(r.id, { type: 'user', id: nextItemId('u'), text, at })
    apply(r.id, { type: 'turn-start', id: nextItemId('t'), at })
    l.turnOpen = true
    if (l.idleTimer !== null) clearTimeout(l.idleTimer)
    deps.turn(r.id, true)
    write(l, userMessage(text))
    await saveRecord(r.id, (x) => ({ ...x, updatedAt: at, archived: false }))
    pushList()
    return { ok: true, id: r.id }
  }

  const noVault = { ok: false as const, message: 'No vault is open.' }

  return {
    async attach(next) {
      if (remote === next) return
      await this.leave()
      remote = next
      dir = join(deps.userData, 'agent-chats', chatDirSlug(next))
      store = jsonFileStore(join(dir, 'index.json'), parseIndex)
      const index = await store.read()
      records = index.chats
      commands = index.commands ?? null
      root = (await deps.target())?.root ?? ''
      lastSummaries = ''
      pushList()
    },

    list,

    transcript: (id) => loadTranscript(id),

    async start(args) {
      if (remote === null) return noVault
      const id = args.id ?? randomUUID()
      const at = now()
      let r = record(id)
      if (r === undefined) {
        r = {
          id,
          title: args.title ?? chatTitle(args.text),
          ...(args.model ? { model: args.model } : {}),
          ...(args.effort ? { effort: args.effort } : {}),
          mode: args.mode ?? 'default',
          createdAt: at,
          updatedAt: at,
          archived: false,
          reviewed: true,
        }
        records.push(r)
        await saveIndex()
        transcripts.set(id, [])
      }
      await loadTranscript(id)
      return turn(r, args.text)
    },

    async send(id, text, opts = {}) {
      const r = record(id)
      if (r === undefined) return { ok: false, message: 'That session is gone.' }
      await loadTranscript(id)
      if (opts.model !== undefined || opts.effort !== undefined || opts.mode !== undefined) {
        await saveRecord(id, (x) => {
          const { model: _m, effort: _e, ...rest } = x
          const model = opts.model === undefined ? x.model : (opts.model ?? undefined)
          const effort = opts.effort === undefined ? x.effort : (opts.effort ?? undefined)
          return {
            ...rest,
            ...(model === undefined ? {} : { model }),
            ...(effort === undefined ? {} : { effort }),
            mode: opts.mode ?? x.mode,
          }
        })
      }
      return turn(record(id)!, text)
    },

    async answer(id, requestId, answer) {
      const l = live.get(id)
      const pending = l?.pending.get(requestId)
      if (l === undefined || pending === undefined) {
        return { ok: false, message: 'That question has already been answered or withdrawn.' }
      }
      l.pending.delete(requestId)
      write(l, controlResponse(requestId, permissionResult(pending, answer)))
      apply(id, {
        type: 'resolved',
        requestId,
        status:
          answer.kind === 'answer'
            ? 'answered'
            : answer.kind === 'deny'
              ? 'denied'
              : answer.always === true
                ? 'always'
                : 'allowed',
      })
      pushList()
      return { ok: true, id }
    },

    async interrupt(id) {
      const l = live.get(id)
      if (l === undefined || !l.turnOpen) return { ok: true, id }
      l.controlSeq += 1
      write(l, interruptRequest(`holi-interrupt-${l.controlSeq}`))
      return { ok: true, id }
    },

    async update(id, change) {
      if (record(id) === undefined) return { ok: false, message: 'That session is gone.' }
      await saveRecord(id, (r) => {
        const next: ChatRecord = { ...r }
        if (change.archived !== undefined) next.archived = change.archived
        if (change.pinned !== undefined) {
          if (change.pinned) next.pinned = true
          else delete next.pinned
        }
        if (change.reviewed !== undefined) next.reviewed = change.reviewed
        if (change.title !== undefined && change.title.trim() !== '')
          next.title = change.title.trim()
        if (change.mode !== undefined) next.mode = change.mode
        if (change.model !== undefined) {
          if (change.model === null) delete next.model
          else next.model = change.model
        }
        if (change.effort !== undefined) {
          if (change.effort === null) delete next.effort
          else next.effort = change.effort
        }
        return next
      })
      if (change.archived === true) stopProcess(id)
      pushList()
      return { ok: true, id }
    },

    async remove(id) {
      if (record(id) === undefined) return { ok: false, message: 'That session is gone.' }
      // Its process may still print or exit: nothing it says lands after this.
      const l = live.get(id)
      if (l?.turnOpen) {
        l.turnOpen = false
        deps.gone(id)
      }
      records = records.filter((r) => r.id !== id)
      stopProcess(id)
      transcripts.delete(id)
      dirty.delete(id)
      outbox.delete(id)
      await saveIndex()
      if (dir !== null) {
        await rm(join(dir, `${id}.json`), { force: true }).catch((err: unknown) =>
          log(`delete ${id} failed: ${String(err)}`),
        )
      }
      pushList()
      return { ok: true, id }
    },

    conversationOf: (id) => record(id)?.conversationId ?? null,

    sessionCommands: () => commands,

    busy: () => list().filter((s) => s.state !== 'idle'),

    onTurnEnd(listener) {
      turnEnds.add(listener)
      return () => turnEnds.delete(listener)
    },

    async leave() {
      for (const [id, l] of live) {
        if (l.turnOpen) deps.gone(id)
        stopProcess(id)
      }
      await flush()
      if (pushTimer !== null) clearTimeout(pushTimer)
      pushTimer = null
      outbox.clear()
      const left = remote
      remote = null
      dir = null
      store = null
      records = []
      commands = null
      transcripts.clear()
      if (left !== null) deps.emit(left, 'chats', [])
    },
  }
}
