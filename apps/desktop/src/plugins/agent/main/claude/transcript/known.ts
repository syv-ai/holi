/**
 * What this reader knows of Claude Code's transcript: the tables of line
 * types, attachment types and system subtypes, each with the reason it is
 * hidden or the rule that draws it. Anything absent from a table is, by
 * definition, drift: `classify.ts` counts it (hidden lines) or shows it
 * (an `unknown` entry). A new Claude Code version is absorbed by adding a
 * line here, nowhere else.
 *
 * Tables are `Map`/`Set`, never object literals: a tool or type called
 * `constructor` or `__proto__` must not find an inherited member.
 */
import type { HiddenReason } from './entries'

/** The Claude Code versions whose transcripts this reader was checked
 *  against (a scan of real sessions). A version past `max` is not wrong, only
 *  unverified: the drift report is what tells. */
export const VERIFIED_CLAUDE_VERSIONS = { min: '2.1.286', max: '2.1.301' }

/** `a.b.c` as numbers, or null when `version` is not that shape. */
function parts(version: string): [number, number, number] | null {
  const m = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})/.exec(version)
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** Whether `version` lies inside the range this reader was verified on. A
 *  version that is not a version is not verified. */
export function isVerifiedVersion(version: string | undefined): boolean {
  if (version === undefined) return false
  const v = parts(version)
  const lo = parts(VERIFIED_CLAUDE_VERSIONS.min)
  const hi = parts(VERIFIED_CLAUDE_VERSIONS.max)
  if (v === null || lo === null || hi === null) return false
  for (let i = 0; i < 3; i += 1) {
    if (v[i]! < lo[i]!) return false
    if (v[i]! > lo[i]!) break
  }
  for (let i = 0; i < 3; i += 1) {
    if (v[i]! > hi[i]!) return false
    if (v[i]! < hi[i]!) break
  }
  return true
}

/** Top-level `type`s that are not conversation, each with why it is hidden.
 *  `user`, `assistant`, `attachment` and `system` are read, not listed here. */
export const HIDDEN_LINE_TYPES: ReadonlyMap<string, HiddenReason> = new Map<string, HiddenReason>([
  // Session chrome: titles, modes, resume pointers, links, cost.
  ['queue-operation', 'metadata'],
  ['last-prompt', 'metadata'],
  ['mode', 'metadata'],
  ['permission-mode', 'metadata'],
  ['custom-title', 'metadata'],
  ['ai-title', 'metadata'],
  ['agent-name', 'metadata'],
  ['pr-link', 'metadata'],
  ['cost-state', 'metadata'],
  ['worktree-state', 'metadata'],
  ['relocated', 'metadata'],
  ['frame-link', 'metadata'],
  ['artifact-autoreact-ledger', 'metadata'],
  ['artifact-comment-monitor', 'metadata'],
  // Rewind checkpoints.
  ['file-history-snapshot', 'machinery'],
  ['file-history-delta', 'machinery'],
  // Copies kept for debugging. `api-request-blob` carries a whole
  // `message.content` and is still not conversation.
  ['api-request', 'debug-copy'],
  ['api-request-blob', 'debug-copy'],
  ['api-request-shape', 'debug-copy'],
  ['atis-latch', 'debug-copy'],
  // The workflow journal's own grammar.
  ['started', 'metadata'],
  ['result', 'metadata'],
  ['launched', 'metadata'],
  ['failed', 'metadata'],
])

/** Attachment types that are only what the model was told. Hidden. The
 *  attachment types that are read (`queued_command`, `hook_non_blocking_error`,
 *  `hook_system_message`, `task_status`) are not here. */
export const MODEL_FACING_ATTACHMENTS: ReadonlySet<string> = new Set([
  'hook_success',
  'hook_additional_context',
  'structured_output',
  'edited_text_file',
  'task_reminder',
  'nested_memory',
  'instructions',
  'skill_listing',
  'agent_listing_delta',
  'deferred_tools_delta',
  'deferred_tools_record',
  'mcp_instructions_delta',
  'environment',
  'model',
  'date',
  'session_context',
  'credential_org',
  'remote_session_change',
  'total_tokens_reminder',
  'silent_turn_reminder',
  'prompt_snapshot',
  'auto_mode',
  'plan_mode',
  'plan_mode_exit',
  'plan_file_reference',
  'invoked_skills',
  'compact_file_reference',
  'file',
  'pdf_reference',
  'skill_mention',
  'read_truncation_notice',
  'thinking_drop',
  'command_permissions',
  'workflow_keyword_request',
])

/** Attachment types drawn as a notice or a message. */
export const READ_ATTACHMENTS: ReadonlySet<string> = new Set([
  'queued_command',
  'hook_non_blocking_error',
  'hook_system_message',
  'task_status',
])

/** `system` subtypes with a rule in `classify.ts`. */
export const READ_SYSTEM_SUBTYPES: ReadonlySet<string> = new Set([
  'away_summary',
  'model_refusal_fallback',
  'compact_boundary',
  'turn_duration',
  'local_command',
  'informational',
  'stop_hook_summary',
])

/** Block types inside a user message, and inside an assistant message. */
export const USER_BLOCKS: ReadonlySet<string> = new Set(['text', 'image', 'tool_result'])
export const ASSISTANT_BLOCKS: ReadonlySet<string> = new Set([
  'text',
  'thinking',
  'redacted_thinking',
  'tool_use',
])

/** The fixed bracketed headers Claude Code's own harness puts on a message it
 *  injects into a sub-agent's conversation, in full (what follows is the
 *  harness's payload). Matched whole, never by a loose prefix: a person may
 *  start a message `[structured logging]`. */
const HARNESS_TEXT_HEADERS: readonly string[] = [
  '[Workflow harness \u2014 computed task]',
  '[Workflow harness \u2014 user request]',
  '[structured-output-enforce]',
  '[handback-send-enforce]',
  '[SYSTEM NOTIFICATION - NOT USER INPUT]',
  '[Your previous response had no visible output. Please continue and produce a user-visible response.]',
]

/** `[Image: source: <path>]`, the whole text: the companion of a pasted image. */
const IMAGE_SOURCE_TEXT = /^\[Image: source: [^\]\n]{1,1000}\]$/

/**
 * Whether `text` is one of the harness's own injected messages. The caller
 * has already established that the line is not the person's (a sub-agent's
 * file or an `isMeta` line, and no human `origin`); this only checks the
 * exact format.
 */
export function isHarnessText(text: string): boolean {
  const trimmed = text.trim()
  return (
    HARNESS_TEXT_HEADERS.some((header) => trimmed.startsWith(header)) ||
    IMAGE_SOURCE_TEXT.test(trimmed)
  )
}

/** The text Claude Code writes when the person stops it. */
export const INTERRUPT_TEXT = '[Request interrupted by user'

/** The keys a tool call's one-line summary is taken from, in order. */
export const SUMMARY_KEYS: readonly string[] = [
  'description',
  'file_path',
  'path',
  'command',
  'pattern',
  'query',
  'url',
  'prompt',
  'skill',
  'name',
  'title',
]

/** Tools whose input carries a long text the chat shows whole (up to the
 *  larger limit): what is written, replaced or planned. */
export const LONG_INPUT_TOOLS: ReadonlySet<string> = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'ExitPlanMode',
])
export const LONG_INPUT_KEYS: ReadonlySet<string> = new Set([
  'content',
  'old_string',
  'new_string',
  'new_source',
  'plan',
])
