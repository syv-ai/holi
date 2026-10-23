/**
 * Turns real Claude Code transcripts into committable fixtures: the STRUCTURE
 * of every distinct line shape, none of the content (docs/features/agent-sessions.md,
 * The chat, "Drift"). The transcript format is private and moves with every
 * release; these fixtures are what `transcript-corpus.test.ts` replays through
 * the reader, and `pnpm chat:fixtures` is how they are refreshed after a
 * Claude Code update.
 *
 *   pnpm --filter @holi/desktop run chat:fixtures [paths...] [--out DIR]
 *       [--per-shape N] [--max-string N] [--max-files N]
 *
 * With no path it reads `~/.claude/projects` and the Holi agent-config
 * `projects` directories. Nothing here touches the network.
 *
 * PRIVACY is the point, so scrubbing is an allowlist, not a blocklist:
 *  - Keys, JSON types, booleans, numbers and array lengths (long arrays are
 *    clipped) are kept. Object keys that could carry a name (MCP results, tool
 *    schemas) are replaced.
 *  - A string survives only if it is an enum-like value under a known key
 *    (`type`, `subtype`, `role`, `stop_reason`, `media_type`, a Claude Code
 *    version, a model id, a built-in tool name...) or a fixed phrase Claude Code
 *    itself writes ("[Request interrupted by user]", "(Bash completed with no
 *    output)"...). Every other string becomes `xxxx` words of the same
 *    whitespace layout, the same size class, and nothing else.
 *  - Wrapper tags in user text (`<command-name>`, `<task-notification>`,
 *    `<system-reminder>`...) survive with their inner text scrubbed: the reader's
 *    rules depend on them.
 *  - Ids are replaced by a one-way hash of the same shape, so every link
 *    (`parentUuid`, `tool_use_id`) stays valid. Timestamps move to a fixed epoch.
 *    Paths become `/p1a2b/p3c4d/p5e6f.ts`, URLs `https://example.test/...`,
 *    base64 a tiny valid string, MCP servers `mcp__serverN__toolN`.
 *
 * The scrubbed output is audited by the corpus test (no addresses, paths,
 * tokens, base64 runs or the author's names). Skim the files before committing.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

// ---------------------------------------------------------------- tables

/** Where every scrubbed timestamp starts. */
const EPOCH_MS = Date.UTC(2030, 0, 1)
/** The one conversation id every fixture line carries. */
const FIXED_SESSION = '00000000-0000-4000-8000-000000000001'

const DEFAULT_PER_SHAPE = 2
const DEFAULT_MAX_STRING = 160
const MAX_ARRAY = 3
const MAX_OBJECT_KEYS = 8
/** Candidates kept per shape while scanning (distinct files), the smallest win. */
const CANDIDATES = 3
const MAX_LINE_BYTES = 400_000
/** A scrubbed line larger than this is redone with shorter strings. */
const LINE_BUDGET = 2_000

const BUILTIN_TOOLS = new Set([
  'Agent',
  'AskUserQuestion',
  'Bash',
  'BashOutput',
  'CronCreate',
  'CronDelete',
  'CronList',
  'Edit',
  'EnterPlanMode',
  'EnterWorktree',
  'ExitPlanMode',
  'ExitWorktree',
  'Glob',
  'Grep',
  'KillShell',
  'ListMcpResourcesTool',
  'MultiEdit',
  'Monitor',
  'NotebookEdit',
  'PushNotification',
  'Read',
  'ReadMcpResourceTool',
  'ScheduleWakeup',
  'Skill',
  'StructuredOutput',
  'SubagentHandback',
  'SendMessage',
  'Task',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TaskUpdate',
  'TodoWrite',
  'ToolSearch',
  'WebFetch',
  'WebSearch',
  'Workflow',
  'Write',
])

/** MCP servers that ship with Claude Code or its desktop app: public names. */
const PUBLIC_MCP_SERVERS = new Set([
  'claude-in-chrome',
  'computer-use',
  'Claude_Browser',
  'Claude_Code_iOS_Simulator',
  'ccd_session',
  'ccd_session_mgmt',
  'ccd_directory',
  'ccd_host',
  'ccd_settings',
  'ccd_sidebar',
  'ccd_view',
  'ccd_window',
  'ccd_pr',
  'ccd_connectors',
  'mcp-registry',
  'scheduled-tasks',
  'terminal',
  'visualize',
])

const AGENT_TYPES = new Set([
  'general-purpose',
  'Explore',
  'Plan',
  'fork',
  'workflow-subagent',
  'statusline-setup',
  'claude-code-guide',
  'claude',
])

const SLASH_BUILTINS = new Set([
  'compact',
  'clear',
  'model',
  'help',
  'config',
  'status',
  'cost',
  'context',
  'resume',
  'login',
  'logout',
  'init',
  'review',
  'memory',
  'mcp',
  'permissions',
  'agents',
  'hooks',
  'ide',
  'doctor',
  'bug',
  'vim',
  'usage',
  'effort',
  'fast',
  'plan',
  'rewind',
  'export',
  'copy',
  'theme',
  'skills',
  'plugin',
  'tasks',
  'loop',
  'schedule',
  'security-review',
  'simplify',
  'run',
  'exit',
])

/** Tags whose structure the reader depends on. Any other tag is plain text. */
const KEEP_TAGS = new Set([
  'command-name',
  'command-message',
  'command-args',
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
  'bash-input',
  'bash-stdout',
  'bash-stderr',
  'system-reminder',
  'task-notification',
  'task-id',
  'tool-use-id',
  'output-file',
  'status',
  'summary',
  'result',
  'usage',
  'tool_uses',
  'subagent_tokens',
  'duration_ms',
  'note',
  'event',
  'teammate-message',
  'agent-message',
  'pasted_content',
  'fork-boilerplate',
  'tool_use_error',
  'skill-format',
  'user-prompt-submit-hook',
  'ide_opened_file',
  'ide_selection',
])

/** Fixed phrases Claude Code writes itself: kept whole. */
const EXACT_PHRASES = new Set([
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
  '(Bash completed with no output)',
  'Structured output provided successfully',
  'No response requested.',
  'Wasted call',
])

/** Fixed openers of Claude Code's own messages: kept, the rest scrubbed. */
const PHRASE_PREFIXES = [
  // The harness's injected headers, whole: the reader matches their exact wording.
  '[Workflow harness \u2014 computed task]',
  '[Workflow harness \u2014 user request]',
  '[structured-output-enforce]',
  '[handback-send-enforce]',
  '[SYSTEM NOTIFICATION - NOT USER INPUT]',
  '[Your previous response had no visible output. Please continue and produce a user-visible response.]',
  '[Request interrupted by user',
  '[Image: source',
  '[Image: original',
  '[Image #',
  '[Workflow harness',
  '[structured',
  '[SYSTEM NOTIFICATION',
  '[handback',
  '[Your previous response had no visible output',
  "The user doesn't want to proceed with this tool use. The tool use was rejected",
  'File created successfully at:',
  'Command did not complete within its',
  'Async agent launched successfully.',
  'Wasted call',
  'File does not exist.',
  'Warning: the file exists but the contents are empty.',
  'Exit code',
  'Error:',
  'Caveat: The messages below were generated by the user while running local commands.',
]

/** Keys whose value is an id: kept in shape, replaced in content. */
const ID_KEYS = new Set([
  'uuid',
  'parentUuid',
  'leafUuid',
  'sessionId',
  'session_id',
  'requestId',
  'promptId',
  'agentId',
  'parentAgentId',
  'taskId',
  'task_id',
  'runId',
  'toolUseID',
  'toolUseId',
  'tool_use_id',
  'source_uuid',
  'delivery_id',
  'interruptedMessageId',
  'sourceToolAssistantUUID',
  'sourceToolUseID',
  'senderTaskId',
  'messageId',
  'id',
  'accountUuid',
  'organizationUuid',
])

/** Keys under which object keys and strings are free-form: nothing survives. */
const FREE_KEYS = new Set([
  'mcpMeta',
  'structuredContent',
  'wireToolInputs',
  'serverClassifierContext',
  'serverClassifierRequest',
  'wireIngestContext',
  'input_schema',
  'definition',
  'params',
  'shape',
  'requestRef',
])

/** Object keys kept even inside a free-form zone. */
const GENERIC_KEYS = new Set([
  'type',
  'text',
  'content',
  'id',
  'name',
  'data',
  'message',
  'error',
  'status',
  'result',
  'results',
  'items',
  'kind',
  'value',
  'title',
  'description',
  'url',
  'path',
  'role',
  'input',
  'output',
  'properties',
  'required',
  'source',
  'nodes',
  'edges',
])

const SAFE_EXTENSIONS = new Set([
  'md',
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'css',
  'html',
  'py',
  'sh',
  'txt',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'pdf',
  'svg',
  'csv',
  'toml',
  'lock',
  'rs',
  'go',
  'xlsx',
  'docx',
  'log',
])

const SAFE_SEGMENTS = new Set([
  'node_modules',
  'src',
  'lib',
  'test',
  'tests',
  'docs',
  'dist',
  'build',
  'out',
  'app',
  'apps',
  'packages',
  'bin',
  'scripts',
  'public',
  '.claude',
  '.git',
  '.github',
  'projects',
  'skills',
  'subagents',
  'workflows',
  'tool-results',
  'tmp',
  'private',
  'worktrees',
  'agents',
  'hooks',
  'settings',
  'memory',
])

const WORD = (set: string[]): RegExp => new RegExp(`^(${set.join('|')})$`)
const LOWER = /^[a-z][a-z0-9_.-]{0,48}$/
const LOWER_WORD = /^[a-z][a-z_-]{0,30}$/

/** Strings kept as they are, by key, outside free-form zones. */
const KEEP_BY_KEY: Record<string, RegExp> = {
  type: LOWER,
  subtype: LOWER,
  kind: LOWER_WORD,
  role: WORD(['user', 'assistant', 'system']),
  stop_reason: WORD([
    'tool_use',
    'end_turn',
    'stop_sequence',
    'max_tokens',
    'refusal',
    'pause_turn',
  ]),
  media_type: /^(image|application|text)\/[a-z0-9.+-]{1,20}$/,
  level: WORD(['info', 'warning', 'error', 'suggestion', 'notice', 'debug']),
  status: LOWER_WORD,
  permissionMode: LOWER_WORD,
  mode: LOWER_WORD,
  entrypoint: LOWER_WORD,
  userType: LOWER_WORD,
  model: /^(claude-[a-z0-9.-]{1,40}(\[[0-9a-z]+\])?|<synthetic>)$/,
  requestedModel: /^claude-[a-z0-9.-]{1,40}(\[[0-9a-z]+\])?$/,
  advisorModel: /^claude-[a-z0-9.-]{1,40}(\[[0-9a-z]+\])?$/,
  effort: LOWER_WORD,
  perTurnEffort: LOWER_WORD,
  service_tier: LOWER_WORD,
  speed: LOWER_WORD,
  inference_geo: LOWER,
  commandMode: LOWER_WORD,
  renderedRole: LOWER_WORD,
  reasonType: LOWER_WORD,
  decision: LOWER_WORD,
  source: /^[a-z][A-Za-z_]{0,30}$/,
  toolDenialKind: LOWER_WORD,
  promptSource: LOWER_WORD,
  turnOrigin: LOWER_WORD,
  trigger: LOWER_WORD,
  direction: LOWER_WORD,
  operation: LOWER_WORD,
  taskType: LOWER_WORD,
  thinkingDisplay: LOWER_WORD,
  sessionKind: LOWER_WORD,
  producer: /^[a-z][a-z_-]{0,30}$/,
  reason: LOWER,
  error: LOWER,
  stopReason: LOWER,
  scope: LOWER_WORD,
  version: /^\d{1,4}\.\d{1,4}\.\d{1,5}$/,
  attributionAgent: new RegExp(`^(${[...AGENT_TYPES].join('|')})$`),
  subagent_type: new RegExp(`^(${[...AGENT_TYPES].join('|')})$`),
  agentType: new RegExp(`^(${[...AGENT_TYPES].join('|')})$`),
  hookEvent:
    /^(PreToolUse|PostToolUse|UserPromptSubmit|Stop|SessionStart|SessionEnd|Notification|SubagentStop|PreCompact)$/,
  hookName:
    /^(PreToolUse|PostToolUse|UserPromptSubmit|Stop|SessionStart|SessionEnd|Notification|SubagentStop|PreCompact)(:[A-Za-z*]{1,24})?$/,
}

// ---------------------------------------------------------------- hashing

function digest(text: string): string {
  return createHash('sha256').update(`holi-fixture:${text}`).digest('hex')
}

/** `n` characters drawn from `alphabet`, deterministic in `text`. */
function derive(text: string, n: number, alphabet: string): string {
  let out = ''
  for (let round = 0; out.length < n; round += 1) {
    const h = digest(`${round}:${text}`)
    for (let i = 0; i + 2 <= h.length && out.length < n; i += 2) {
      out += alphabet[Number.parseInt(h.slice(i, i + 2), 16) % alphabet.length]
    }
  }
  return out
}

const HEX = '0123456789abcdef'
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ID_PREFIXES = ['toolu_', 'srvtoolu_', 'msg_', 'req_', 'agent-', 'wf_', 'task_', 'call_']

/** Replace an id by one of the same shape; the same id always maps the same. */
export function mapId(id: string): string {
  if (UUID.test(id)) {
    const h = derive(id, 32, HEX)
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
  }
  const prefix = ID_PREFIXES.find((p) => id.startsWith(p)) ?? ''
  const body = id.slice(prefix.length)
  const hexLike = /^[0-9a-f]+$/i.test(body)
  return prefix + derive(id, Math.min(body.length, 40), hexLike ? HEX : BASE62)
}

function looksLikeId(text: string): boolean {
  return (
    UUID.test(text) ||
    /^(toolu_|srvtoolu_|msg_|req_)[A-Za-z0-9_-]{16,}$/.test(text) ||
    /^(wf_|task_|call_)(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{8,}$/.test(text) ||
    /^agent-[0-9a-z]{8,}$/.test(text)
  )
}

// ---------------------------------------------------------------- scrubbing

/** Per-source-file state: timestamps move relative to the file's first. */
export interface ScrubEnv {
  firstTimestampMs?: number
  /** The built-in or MCP tool a tool_result's line answers, when known. */
  toolName?: string
}

interface Ctx {
  free: boolean
  /** How deep inside a free-form zone: deep subtrees are emptied. */
  fd: number
  env: ScrubEnv
  /** Distinct mcp server -> n, so `mcp__server1__...` is stable inside a run. */
  mcp: McpNames
}

export class McpNames {
  private readonly servers = new Map<string, number>()
  private readonly tools = new Map<string, number>()
  normalise(name: string): string {
    const m = /^mcp__(.+?)__(.+)$/.exec(name)
    if (m === null) return 'mcp__server0__tool0'
    const [, server, tool] = m as unknown as [string, string, string]
    if (PUBLIC_MCP_SERVERS.has(server)) return name
    if (!this.servers.has(server)) this.servers.set(server, this.servers.size + 1)
    if (!this.tools.has(name)) this.tools.set(name, this.tools.size + 1)
    return `mcp__server${this.servers.get(server)}__tool${this.tools.get(name)}`
  }
}

const SAFE_PUNCT = new Set([...'"\'`()[]{}<>*_#:;,.!?-|~+=%$&'])

function isEpochMs(n: number): boolean {
  return Number.isInteger(n) && n > 1.4e12 && n < 2.2e12
}

function shiftMs(ms: number, env: ScrubEnv): number {
  env.firstTimestampMs ??= ms
  const delta = Math.min(Math.max(ms - env.firstTimestampMs, 0), 30 * 86_400_000)
  return EPOCH_MS + delta
}

function shiftIso(text: string, env: ScrubEnv): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return '2030-01-01'
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.test(text)) return null
  const ms = Date.parse(text)
  if (Number.isNaN(ms)) return null
  return new Date(shiftMs(ms, env)).toISOString()
}

/** A tiny valid base64 stand-in. */
function tinyBase64(mediaType: string | undefined): string {
  return mediaType === 'image/png'
    ? 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
    : 'AAAA'
}

function scrubSegment(seg: string, last: boolean): string {
  if (seg === '' || seg === '.' || seg === '..' || seg === '~') return seg
  if (SAFE_SEGMENTS.has(seg)) return seg
  const dot = seg.lastIndexOf('.')
  if (last && dot > 0 && SAFE_EXTENSIONS.has(seg.slice(dot + 1).toLowerCase())) {
    return `p${derive(seg.slice(0, dot), 4, HEX)}.${seg.slice(dot + 1).toLowerCase()}`
  }
  return `p${derive(seg, 4, HEX)}`
}

function scrubPath(path: string): string {
  const segments = path.split('/')
  return segments.map((s, i) => scrubSegment(s, i === segments.length - 1)).join('/')
}

/** One whitespace-free word of text. */
function scrubToken(token: string): string {
  const m = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/su.exec(token)
  const lead = (m?.[1] ?? '')
    .split('')
    .filter((c) => SAFE_PUNCT.has(c))
    .join('')
    .slice(0, 6)
  const body = m?.[2] ?? token
  const trail = (m?.[3] ?? '')
    .split('')
    .filter((c) => SAFE_PUNCT.has(c))
    .join('')
    .slice(0, 6)
  if (body === '') return lead + trail
  // URLs keep their scheme and nothing else.
  const url = /^[("'`<[]*https?:\/\/[^/\s]*(\/[^\s?#]*)?/i.exec(token)
  if (url !== null) {
    return `${lead}https://example.test${scrubPath((url[1] ?? '').slice(0, 80))}${trail}`
  }
  // Paths keep their depth and a plain extension.
  const core = token.replace(/^[^\p{L}\p{N}./~]+/u, '').replace(/[^\p{L}\p{N}/]+$/u, '')
  if (
    core.includes('/') &&
    !/[<>@\s]/.test(core) &&
    /^(\/|\.\.?\/|~\/|[\p{L}\p{N}_.-]+\/)/u.test(core)
  ) {
    const line = /(:\d+){1,2}$/.exec(core)
    const bare = line === null ? core : core.slice(0, -line[0].length)
    const quote = /^[("'`<[]/.exec(token)?.[0] ?? ''
    return `${quote}${scrubPath(bare)}${line?.[0] ?? ''}${trail.replace(/[^)"'`>\],.:;]/g, '')}`
  }
  if (/^\d{1,5}$/.test(body)) return lead + body + trail
  return lead + 'x'.repeat(Math.min([...body].length, 24)) + trail
}

/** Whitespace layout kept; every word becomes `x`s. */
function scrubWords(text: string): string {
  return text.replace(/\S+/g, scrubToken)
}

const TAG = /(<\/?[A-Za-z][\w-]*(?:\s[^<>]*)?\/?>)/

function scrubTag(tag: string): { text: string; name: string; open: boolean } | null {
  const m = /^<(\/?)([A-Za-z][\w-]*)((?:\s[^<>]*)?)(\/?)>$/.exec(tag)
  if (m === null) return null
  const [, slash, name, attrs, selfClose] = m as unknown as [string, string, string, string, string]
  if (!KEEP_TAGS.has(name)) return null
  const scrubbedAttrs = attrs.replace(/([\w-]+)="[^"]*"/g, (_, key: string) => ` ${key}="xxxx"`)
  const attrText = attrs.trim() === '' ? '' : scrubbedAttrs.replace(/\s+/g, ' ').replace(/^ ?/, ' ')
  return {
    text: `<${slash}${name}${attrText}${selfClose}>`,
    name,
    open: slash === '' && selfClose === '',
  }
}

/** Inner text of these tags is a value the reader compares, not prose. */
function scrubTagValue(tag: string, inner: string): string | null {
  const t = inner.trim()
  if (tag === 'command-name') {
    const name = t.replace(/^\//, '')
    return SLASH_BUILTINS.has(name) ? inner : null
  }
  if (tag === 'status' && /^[a-z_-]{1,20}$/.test(t)) return inner
  if (/^(tool_uses|subagent_tokens|duration_ms)$/.test(tag) && /^\d{1,9}$/.test(t)) return inner
  return null
}

/** A string of prose or code: structure of tags and lines, none of the words. */
export function scrubText(text: string, maxString: number): string {
  if (text === '') return ''
  if (EXACT_PHRASES.has(text)) return text
  const json = scrubJsonText(text, maxString)
  if (json !== null) return json
  for (const prefix of PHRASE_PREFIXES) {
    if (text.startsWith(prefix)) {
      return prefix + scrubText(text.slice(prefix.length), maxString)
    }
  }
  // Text is cut to a budget; tags are not, so a wrapper stays closed.
  const parts = text.slice(0, 100_000).split(TAG)
  let out = ''
  let openTag = ''
  let budget = maxString
  let tags = 0
  for (const part of parts) {
    if (part === '') continue
    const tag = TAG.test(part) ? scrubTag(part) : null
    if (tag !== null) {
      if ((tags += 1) <= 60) out += tag.text
      openTag = tag.open ? tag.name : ''
      continue
    }
    const value = openTag === '' ? null : scrubTagValue(openTag, part)
    const piece = (value ?? scrubWords(part.slice(0, budget * 2))).slice(0, budget)
    out += piece
    budget -= piece.length
    openTag = ''
  }
  return out
}

/** A string that is itself JSON keeps its shape. */
function scrubJsonText(text: string, maxString: number): string | null {
  const t = text.trim()
  if (!(t.startsWith('{') && t.endsWith('}')) && !(t.startsWith('[') && t.endsWith(']')))
    return null
  if (t.length > 200_000) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(t)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const clean = scrubValue(
    parsed,
    '',
    {
      free: true,
      fd: 0,
      env: {},
      mcp: new McpNames(),
    },
    maxString,
  )
  return JSON.stringify(clean, null, text.includes('\n') ? 2 : undefined)
}

function scrubString(value: string, key: string, ctx: Ctx, maxString: number): string {
  if (value === '') return ''
  const keep = ctx.free ? undefined : KEEP_BY_KEY[key]
  if (keep?.test(value) === true) return value
  if (looksLikeId(value) || (ID_KEYS.has(key) && /^[A-Za-z0-9_-]{8,}$/.test(value))) {
    return mapId(value)
  }
  const iso = shiftIso(value, ctx.env)
  if (iso !== null) return iso
  if (/^data:[\w/+.-]+;base64,/.test(value)) {
    return `${value.slice(0, value.indexOf(',') + 1)}AAAA`
  }
  if (value.length >= 100 && !value.startsWith('/') && /^[A-Za-z0-9+/=_-]+$/.test(value)) {
    return tinyBase64(undefined)
  }
  return scrubText(value, maxString)
}

function scrubKey(key: string, index: number, free: boolean): string {
  if (looksLikeId(key) || /^[0-9a-f]{12,}$/i.test(key)) return mapId(key)
  if (free) return GENERIC_KEYS.has(key) ? key : `k${index}`
  if (/^[A-Za-z_$][\w$-]{0,39}$/.test(key)) return key
  return `k${index}`
}

function toolNameOf(block: Record<string, unknown>, ctx: Ctx): string {
  const name = typeof block['name'] === 'string' ? block['name'] : ''
  if (name.startsWith('mcp__')) return ctx.mcp.normalise(name)
  if (BUILTIN_TOOLS.has(name)) return name
  return /^[A-Z][A-Za-z]{2,30}$/.test(name) ? name : 'Tool'
}

function isFreeTool(name: string | undefined): boolean {
  return name === undefined || !BUILTIN_TOOLS.has(name)
}

export function scrubValue(value: unknown, key: string, ctx: Ctx, maxString: number): unknown {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return isEpochMs(value) ? shiftMs(value, ctx.env) : value
  if (typeof value === 'string') return scrubString(value, key, ctx, maxString)
  if (ctx.free && ctx.fd > 3 && typeof value === 'object') return Array.isArray(value) ? [] : {}
  if (Array.isArray(value)) {
    const inner = ctx.free ? { ...ctx, fd: ctx.fd + 1 } : ctx
    return value.slice(0, MAX_ARRAY).map((x) => scrubValue(x, key, inner, maxString))
  }
  if (typeof value !== 'object') return null
  const obj = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  const type = typeof obj['type'] === 'string' ? obj['type'] : ''

  // Base64 payloads of images and documents.
  if (type === 'base64' && typeof obj['data'] === 'string') {
    const media = typeof obj['media_type'] === 'string' ? obj['media_type'] : undefined
    return { ...scrubObject(obj, ctx, maxString, new Set(['data'])), data: tinyBase64(media) }
  }
  // A tool call: name normalised, input free-form unless the tool is built in.
  if (type === 'tool_use' && typeof obj['name'] === 'string') {
    const name = toolNameOf(obj, ctx)
    const inputCtx: Ctx = { ...ctx, free: ctx.free || isFreeTool(name) }
    let index = 0
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'name') out['name'] = name
      else if (k === 'input') out['input'] = scrubValue(v, 'input', inputCtx, maxString)
      else out[scrubKey(k, index, ctx.free)] = scrubValue(v, k, ctx, maxString)
      index += 1
    }
    return out
  }
  if (type === 'tool_reference' && typeof obj['tool_name'] === 'string') {
    const name = obj['tool_name']
    return {
      ...scrubObject(obj, ctx, maxString, new Set(['tool_name'])),
      tool_name: name.startsWith('mcp__')
        ? ctx.mcp.normalise(name)
        : BUILTIN_TOOLS.has(name)
          ? name
          : 'Tool',
    }
  }
  return scrubObject(obj, ctx, maxString)
}

function scrubObject(
  obj: Record<string, unknown>,
  ctx: Ctx,
  maxString: number,
  skip: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  let index = 0
  const isStructuredOutput = obj['type'] === 'structured_output'
  for (const [k, v] of Object.entries(obj)) {
    if (index >= (ctx.free ? MAX_OBJECT_KEYS : 80)) break
    if (!skip.has(k)) {
      const childFree = ctx.free || FREE_KEYS.has(k) || (isStructuredOutput && k === 'data')
      const childCtx: Ctx = childFree ? { ...ctx, free: true, fd: ctx.free ? ctx.fd + 1 : 1 } : ctx
      let child = v
      if (k === 'toolUseResult' && isFreeTool(ctx.env.toolName)) {
        child = scrubValue(v, k, { ...ctx, free: true, fd: 1 }, maxString)
        out[scrubKey(k, index, ctx.free)] = child
      } else {
        out[scrubKey(k, index, ctx.free)] = scrubValue(child, k, childCtx, maxString)
      }
    }
    index += 1
  }
  return out
}

/** One transcript line, scrubbed. `null` if it is not a JSON object. */
export function scrubLine(
  raw: string,
  env: ScrubEnv,
  mcp: McpNames,
  maxString = DEFAULT_MAX_STRING,
): string | null {
  let row: unknown
  try {
    row = JSON.parse(raw)
  } catch {
    return null
  }
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return null
  // A line over budget is scrubbed again with shorter strings.
  let text = ''
  for (const limit of [maxString, 100, 48, 24]) {
    if (limit > maxString) continue
    const clean = scrubValue(row, '', { free: false, fd: 0, env, mcp }, limit) as Record<
      string,
      unknown
    >
    // One conversation per fixture file.
    if ('sessionId' in clean) clean['sessionId'] = FIXED_SESSION
    if ('session_id' in clean) clean['session_id'] = FIXED_SESSION
    text = JSON.stringify(clean)
    if (text.length <= LINE_BUDGET) break
  }
  return text
}

// ---------------------------------------------------------------- shapes

const FLAGS = [
  'isMeta',
  'isSidechain',
  'isCompactSummary',
  'isApiErrorMessage',
  'isVisibleInTranscriptOnly',
]

type Row = Record<string, unknown>
const asRow = (v: unknown): Row | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : undefined

/** `type|subtype|attachment.type|flags`: the census's shape key. */
export function shapeKeyOf(o: Row): string {
  const t = o['type']
  const st = typeof o['subtype'] === 'string' ? o['subtype'] : null
  const at = t === 'attachment' ? asRow(o['attachment'])?.['type'] : null
  const fl = FLAGS.filter((f) => o[f] === true)
  return [String(t), st ?? '-', typeof at === 'string' ? at : '-', fl.join(',') || '-'].join('|')
}

function contentOf(o: Row): unknown {
  return asRow(o['message'])?.['content']
}

function contentVariant(c: unknown): string {
  if (typeof c === 'string') return 'str'
  if (!Array.isArray(c)) return c === undefined ? 'none' : typeof c
  const sig: string[] = []
  for (const b of c) {
    const t = typeof asRow(b)?.['type'] === 'string' ? String(asRow(b)?.['type']) : '?'
    if (sig[sig.length - 1] !== t) sig.push(t)
  }
  return `arr[${sig.join('+')}]`
}

function toolFamily(name: unknown): string {
  if (typeof name !== 'string') return '?'
  if (name.startsWith('mcp__')) return 'mcp'
  return BUILTIN_TOOLS.has(name) ? name : 'other'
}

/** What a user text opens with: a wrapper tag, a bracket marker, or nothing. */
export function wrapperClass(text: string): string {
  const tags: string[] = []
  let rest = text.trimStart()
  for (;;) {
    const m = /^<([A-Za-z][\w-]*)[^>]*>/.exec(rest)
    if (m === null) break
    const name = m[1] ?? ''
    if (!tags.includes(name)) tags.push(name)
    const close = rest.indexOf(`</${name}>`)
    if (close === -1 || tags.length >= 4) break
    rest = rest.slice(close + name.length + 3).trimStart()
  }
  if (tags.length > 0) return `tags:${tags.join('+')}`
  const bracket = /^\[([A-Za-z#-]+)/.exec(text)
  return bracket === null ? 'plain' : `bracket:${bracket[1]}`
}

function textsOf(c: unknown): string[] {
  if (typeof c === 'string') return [c]
  if (!Array.isArray(c)) return []
  return c.flatMap((b) => {
    const r = asRow(b)
    return r !== undefined && r['type'] === 'text' && typeof r['text'] === 'string'
      ? [r['text']]
      : []
  })
}

interface Classified {
  /** The distinctness key: two lines with the same one are the same shape. */
  signature: string
  area: Area
  sidechain: boolean
}

type Area =
  | 'messages'
  | 'wrappers'
  | 'tools'
  | 'attachments'
  | 'system'
  | 'metadata'
  | 'compaction'
  | 'subagent'

const AREAS: Area[] = [
  'messages',
  'wrappers',
  'tools',
  'attachments',
  'system',
  'metadata',
  'compaction',
  'subagent',
]

/** A line's shape: coarse key, plus the facets the reader branches on. */
export function classifyShape(o: Row, toolName: string | undefined): Classified {
  const base = shapeKeyOf(o)
  const sidechain = o['isSidechain'] === true
  const parts = [base]
  const type = o['type']
  const c = contentOf(o)
  let area: Area = 'metadata'

  if (type === 'user' || type === 'assistant') {
    parts.push(contentVariant(c))
    const blocks = Array.isArray(c) ? c.map(asRow).filter((b): b is Row => b !== undefined) : []
    const hasToolUse = blocks.some((b) => b['type'] === 'tool_use')
    const hasToolResult = blocks.some((b) => b['type'] === 'tool_result')
    if (type === 'assistant') {
      if (!sidechain) {
        parts.push(
          `tools:${[...new Set(blocks.filter((b) => b['type'] === 'tool_use').map((b) => toolFamily(b['name'])))].sort().join(',')}`,
        )
      }
      const thinking = blocks.find((b) => b['type'] === 'thinking')
      if (thinking !== undefined)
        parts.push(`thinking:${thinking['thinking'] === '' ? 'empty' : 'text'}`)
      if (o['isAbortedMidStream'] === true) parts.push('aborted')
      if (o['truncatedAfterOutput'] === true) parts.push('truncated')
      if (typeof o['error'] === 'string') parts.push('error')
    } else {
      const origin = asRow(o['origin'])?.['kind']
      parts.push(`origin:${typeof origin === 'string' ? origin : 'none'}`)
      const tur = o['toolUseResult']
      if (hasToolResult) {
        parts.push(
          `tur:${tur === undefined ? 'absent' : Array.isArray(tur) ? 'array' : typeof tur}`,
        )
        if (!sidechain) parts.push(`result:${toolFamily(toolName)}`)
        const first = blocks.find((b) => b['type'] === 'tool_result')
        parts.push(
          `rc:${contentVariant(first?.['content'])}`,
          `err:${String(first?.['is_error'] ?? 'absent')}`,
        )
        if (typeof o['toolDenialKind'] === 'string') parts.push('denied')
        if (o['mcpMeta'] !== undefined) parts.push('mcpMeta')
      } else {
        const first = textsOf(c)[0]
        if (first !== undefined) parts.push(wrapperClass(first))
        if (typeof o['promptSource'] === 'string') parts.push(`ps:${o['promptSource']}`)
      }
    }
    area = sidechain
      ? 'subagent'
      : o['isCompactSummary'] === true
        ? 'compaction'
        : hasToolUse || hasToolResult
          ? 'tools'
          : parts.some((p) => p.startsWith('tags:') || p.startsWith('bracket:'))
            ? 'wrappers'
            : 'messages'
  } else if (type === 'attachment') {
    const a = asRow(o['attachment']) ?? {}
    const origin = asRow(a['origin'])?.['kind']
    parts.push(
      typeof origin === 'string' ? `origin:${origin}` : 'origin:none',
      typeof a['commandMode'] === 'string' ? `mode:${a['commandMode']}` : 'mode:none',
      typeof a['reason'] === 'string' ? `reason:${a['reason']}` : 'reason:none',
      Array.isArray(a['rendered']) ? 'rendered' : 'bare',
    )
    area = sidechain ? 'subagent' : 'attachments'
  } else if (type === 'system') {
    const hooks = o['hookErrors']
    parts.push(Array.isArray(hooks) && hooks.length > 0 ? 'hookErrors' : 'plain')
    area = o['subtype'] === 'compact_boundary' ? 'compaction' : 'system'
  } else if (type === 'queue-operation') {
    parts.push(`op:${String(o['operation'])}`)
    const content = o['content']
    parts.push(typeof content === 'string' ? wrapperClass(content) : 'nocontent')
    area = 'wrappers'
  }
  return { signature: parts.join(' | '), area: sidechain ? 'subagent' : area, sidechain }
}

// ---------------------------------------------------------------- driving

interface Candidate {
  signature: string
  area: Area
  sidechain: boolean
  file: string
  fileIndex: number
  lineNo: number
  raw: string
  /** The assistant line that holds the call this result answers. */
  pairRaw?: string
  pairLineNo?: number
  toolName?: string
}

export async function* jsonlFiles(root: string): AsyncGenerator<string> {
  let info
  try {
    info = await stat(root)
  } catch {
    return
  }
  if (info.isFile()) {
    if (root.endsWith('.jsonl')) yield root
    return
  }
  const entries = (await readdir(root, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )
  for (const e of entries) {
    if (e.name === 'tool-results') continue
    const p = join(root, e.name)
    if (e.isDirectory()) yield* jsonlFiles(p)
    else if (e.name.endsWith('.jsonl')) yield p
  }
}

/** The default places Claude Code transcripts live on this machine. */
export async function defaultRoots(): Promise<string[]> {
  const roots = [join(homedir(), '.claude', 'projects')]
  const support = join(
    homedir(),
    'Library',
    'Application Support',
    '@holi',
    'desktop',
    'agent-config',
  )
  try {
    for (const dir of await readdir(support)) roots.push(join(support, dir, 'projects'))
  } catch {
    /* no Holi agent-config here */
  }
  return roots
}

interface Options {
  out: string
  perShape: number
  maxString: number
  maxFiles: number
  roots: string[]
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    out: resolve(
      dirname(new URL(import.meta.url).pathname),
      '../src/plugins/agent/test/fixtures/transcripts',
    ),
    perShape: DEFAULT_PER_SHAPE,
    maxString: DEFAULT_MAX_STRING,
    maxFiles: Number.POSITIVE_INFINITY,
    roots: [],
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? ''
    if (a === '--out') options.out = resolve(argv[(i += 1)] ?? options.out)
    else if (a === '--per-shape') options.perShape = Number(argv[(i += 1)])
    else if (a === '--max-string') options.maxString = Number(argv[(i += 1)])
    else if (a === '--max-files') options.maxFiles = Number(argv[(i += 1)])
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`)
    else options.roots.push(resolve(a))
  }
  return options
}

/** Scan the files, remembering the best few lines of each distinct shape. */
async function scan(files: string[]): Promise<Map<string, Candidate[]>> {
  const found = new Map<string, Candidate[]>()
  for (const [fileIndex, file] of files.entries()) {
    const calls = new Map<string, { raw: string; lineNo: number; name: string }>()
    const seenHere = new Set<string>()
    const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
    let lineNo = 0
    for await (const raw of rl) {
      lineNo += 1
      if (raw === '' || raw.length > MAX_LINE_BYTES * 4) continue
      let row: Row | undefined
      try {
        row = asRow(JSON.parse(raw))
      } catch {
        continue
      }
      if (row === undefined) continue
      const content = contentOf(row)
      const blocks = Array.isArray(content) ? content.map(asRow) : []
      for (const b of blocks) {
        if (b?.['type'] === 'tool_use' && typeof b['id'] === 'string') {
          calls.set(b['id'], { raw, lineNo, name: String(b['name']) })
        }
      }
      const result = blocks.find((b) => b?.['type'] === 'tool_result')
      const call =
        typeof result?.['tool_use_id'] === 'string' ? calls.get(result['tool_use_id']) : undefined
      const shape = classifyShape(row, call?.name)
      if (seenHere.has(shape.signature) || raw.length > MAX_LINE_BYTES) continue
      const list = found.get(shape.signature) ?? []
      if (list.length >= CANDIDATES) continue
      seenHere.add(shape.signature)
      list.push({
        ...shape,
        file,
        fileIndex,
        lineNo,
        raw,
        pairRaw: call?.raw,
        pairLineNo: call?.lineNo,
        toolName: call?.name,
      })
      found.set(shape.signature, list)
    }
  }
  return found
}

export async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv)
  const roots = options.roots.length > 0 ? options.roots : await defaultRoots()
  const files: string[] = []
  for (const root of roots) {
    for await (const f of jsonlFiles(root)) {
      files.push(f)
      if (files.length >= options.maxFiles) break
    }
  }
  if (files.length === 0) {
    console.error('chat:fixtures: no transcripts found under', roots.join(', '))
    return 2
  }
  console.error(`chat:fixtures: scanning ${files.length} files`)
  const found = await scan(files)

  // Pick the smallest few of each shape (sidechain shapes: one).
  interface Picked {
    area: Area
    fileIndex: number
    lineNo: number
    raw: string
    toolName?: string
    pair?: { raw: string; lineNo: number }
    file: string
  }
  const picked: Picked[] = []
  for (const list of found.values()) {
    const first = list[0]
    const want =
      first === undefined || first.sidechain || first.area === 'tools' ? 1 : options.perShape
    for (const c of [...list].sort((a, b) => a.raw.length - b.raw.length).slice(0, want)) {
      if (c.pairRaw !== undefined && c.pairLineNo !== undefined) {
        picked.push({
          area: c.sidechain ? 'subagent' : 'tools',
          fileIndex: c.fileIndex,
          lineNo: c.pairLineNo,
          raw: c.pairRaw,
          file: c.file,
        })
      }
      picked.push({
        area: c.area,
        fileIndex: c.fileIndex,
        lineNo: c.lineNo,
        raw: c.raw,
        toolName: c.toolName,
        file: c.file,
      })
    }
  }
  picked.sort((a, b) => a.fileIndex - b.fileIndex || a.lineNo - b.lineNo)

  const mcp = new McpNames()
  const envs = new Map<string, ScrubEnv>()
  const byArea = new Map<Area, string[]>(AREAS.map((a) => [a, []]))
  const emitted = new Set<string>()
  for (const p of picked) {
    const id = `${p.fileIndex}:${p.lineNo}`
    if (emitted.has(id)) continue
    emitted.add(id)
    const env = envs.get(p.file) ?? {}
    envs.set(p.file, env)
    env.toolName = p.toolName
    // A pair's call keeps the area of its result: they read together.
    const out = scrubLine(p.raw, env, mcp, options.maxString)
    if (out !== null) byArea.get(p.area)?.push(out)
  }

  await mkdir(options.out, { recursive: true })
  let total = 0
  for (const area of AREAS) {
    const lines = byArea.get(area) ?? []
    const body = lines.length === 0 ? '' : `${lines.join('\n')}\n`
    await writeFile(join(options.out, `${area}.jsonl`), body)
    total += Buffer.byteLength(body)
    console.error(
      `  ${area}.jsonl  ${lines.length} lines  ${(Buffer.byteLength(body) / 1024).toFixed(1)} KB`,
    )
  }
  console.error(
    `chat:fixtures: ${found.size} shapes, ${(total / 1024).toFixed(1)} KB written to ${options.out}`,
  )
  return 0
}
