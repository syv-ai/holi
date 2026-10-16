/**
 * What the chat is given of a session's conversation (docs/features/agent-sessions.md,
 * The chat): Holi's own entries, never Claude Code's lines. Claude Code's
 * transcript is not a documented interface, so one module (`classify.ts`)
 * knows its shapes and maps them to this; everything past it, in main and in
 * the renderer, depends on this file only. A format change is patched there.
 *
 * Pure types: loads in the renderer (as types only) and under plain Node.
 */

/** A picture in a result or a message. Its bytes stay in the transcript: a
 *  screenshot is hundreds of kilobytes of base64, and the chat draws a chip. */
export interface ImageRef {
  mediaType: string
  /** The decoded size, in bytes (estimated from the base64 length). */
  bytes: number
}

/** A JSON-able value that went through `sanitise`: strings clipped, base64
 *  and huge arrays summarised. Tool inputs and structured results are this. */
export type Plain = Record<string, unknown>

export type NoticeSource =
  | 'compact-summary'
  | 'api-error'
  | 'refusal'
  | 'away'
  | 'hook'
  | 'local-command'
  | 'info'
  | 'task'
  | 'peer'

/** One thing in the conversation, in the order it happened (file order, never
 *  timestamp order). `id` is stable across reads: the chat keys rows by it. */
export type ChatEntry =
  /** A message the person wrote. `queued`: typed while the agent was busy. */
  | { kind: 'user'; id: string; text: string; images?: number; queued?: boolean }
  | { kind: 'assistant'; id: string; text: string }
  /** Visible reasoning only: the empty, signature-only blocks are hidden. */
  | { kind: 'thinking'; id: string; text: string }
  /** A tool the agent called. `id` is the call's, which its result names.
   *  `args` is the input, sanitised; `summary` the one line about it. */
  | { kind: 'tool'; id: string; name: string; summary: string; args: Plain; clipped?: boolean }
  /** What a call returned. `data` is the structured twin Claude Code keeps
   *  beside the text (`toolUseResult`), sanitised, and optional: sub-agent
   *  results mostly lack it. `ok` is false only when Claude Code said so or
   *  the text is a known failure. */
  | {
      kind: 'tool-result'
      id: string
      ok: boolean
      text: string
      images?: ImageRef[]
      data?: Plain
      clipped?: boolean
    }
  /** A slash command the person ran (`/compact`, `/model`, a skill). */
  | { kind: 'command'; id: string; name: string; args: string }
  /** A `!` shell command of the person's, or a local command's output. */
  | { kind: 'shell'; id: string; command?: string; stdout?: string; stderr?: string }
  /** The person stopped it. `forTool`: during a tool call, not a reply. */
  | { kind: 'interrupt'; id: string; forTool: boolean }
  /** Something the system said that is not the agent's or the person's. */
  | {
      kind: 'notice'
      id: string
      source: NoticeSource
      tone: 'info' | 'warn' | 'error'
      text: string
      /** Longer text behind a disclosure (a compaction summary, hook output). */
      detail?: string
    }
  /** The conversation was compacted here: the history above is still shown. */
  | {
      kind: 'compaction'
      id: string
      trigger?: string
      preTokens?: number
      postTokens?: number
    }
  /** A turn ended after this long. */
  | { kind: 'turn-end'; id: string; durationMs: number }
  /** A background task (sub-agent, workflow, monitor) reported. `toolUseId`
   *  names the call that started it, so its card can show the outcome. */
  | {
      kind: 'task-note'
      id: string
      taskId?: string
      toolUseId?: string
      status: string
      summary: string
    }
  /** A line of the conversation this reader has no rule for. Shown, never
   *  dropped: `shape` is its signature, `raw` its JSON, clipped. */
  | { kind: 'unknown'; id: string; shape: string; raw: string; version?: string }

/** Why a line is not drawn at all. Every hidden line names one, so "dropped"
 *  is always a decision in `known.ts`, never an accident. */
export type HiddenReason =
  | 'metadata' // titles, modes, last-prompt, cost, links: session chrome
  | 'model-facing' // attachments and reminders the model got, not the person
  | 'debug-copy' // api-request*, atis-latch: copies for debugging
  | 'machinery' // isMeta lines, wrappers with no content, snapshots
  | 'empty' // an empty or signature-only block
  | 'sidechain' // a sub-agent's line met in the main timeline

/** How a line was classified. A line may yield entries and still be
 *  `unknown` (some of its parts are); then the unknown part is an entry. */
export type Disposition =
  | { kind: 'rendered' }
  | { kind: 'hidden'; reason: HiddenReason }
  | { kind: 'unknown'; shape: string }

export interface LineResult {
  entries: ChatEntry[]
  disposition: Disposition
  /** Claude Code's version that wrote it, when the line says. */
  version?: string
}

/** What a read could not place, told to the chat and to the drift check. */
export interface DriftReport {
  /** Lines read this time. */
  lines: number
  /** Lines the reader has no rule for, by signature. */
  unknown: { shape: string; count: number }[]
  /** Lines too large to parse (kept as a placeholder), or not JSON. */
  oversize: number
  unparseable: number
}

export interface TranscriptChunk {
  /** The conversation these entries are from. A different one than the caller
   *  last had (a `/clear`) means its entries are stale. */
  sessionId: string
  entries: ChatEntry[]
  /** Where to read from next. */
  offset: number
  /** Where this read began in the file, a line start. 0: the file's start,
   *  so nothing earlier can be asked for. Only the first read sets it. */
  start?: number
  /** A digest of the file's first and last bytes up to `offset`. The caller
   *  hands it back with `offset`; a prefix that no longer matches means the
   *  file was replaced, not appended to. Opaque. */
  fingerprint?: string
  /** True when the file is not the one `offset` and `fingerprint` came from
   *  (it was rewritten): the entries are a fresh tail read, `start` says where
   *  it began, and the caller replaces what it holds instead of adding to it. */
  reset?: boolean
  drift?: DriftReport
}

/** An earlier part of the file, read backwards from a line start. */
export interface EarlierChunk {
  entries: ChatEntry[]
  /** Where this part began; 0 when it reached the file's start. */
  start: number
  drift?: DriftReport
}
