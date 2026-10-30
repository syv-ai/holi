/**
 * The line between the agent host and the coding agents it runs
 * (docs/features/agent-sessions.md, Providers).
 *
 * The host owns the PTYs and terminal mirror, the turn coordinator, turn
 * review and the session surface. A provider is everything that is one
 * agent's own: the command a terminal runs, its per-vault directory, what it
 * seeds, and whichever **capabilities** its CLI and hooks allow.
 *
 * **The core is enough to run it in a tab.** A provider with no capabilities
 * still gets sessions: Holi runs the CLI in a PTY of its own, and the session
 * lives as long as that process (`host/pty-sessions.ts`). Its turns are read
 * off the terminal stream (`host/pty-signals.ts`) unless its hooks say.
 *
 * The capabilities are what the UI may offer for a session, never assumed:
 *
 * - `background`: sessions its own supervisor runs, which outlive any
 *   terminal and can run with nobody watching. Claude Code's `--bg`. Holis
 *   and automations need it, since their runs start with no terminal.
 * - `turns`: hook routes that report a turn's start and end.
 * - `status`: how full a session's context is, and its model.
 * - `jobs`: a prompt run with nobody watching, sandboxed by the agent's own
 *   rules or by the process's (`pi/sandbox.ts`), its output read as events
 *   (`host/jobs.ts`). Codex's `codex exec`, Pi's RPC mode.
 *   Either in a scratch folder Holi owns, what it may write copied back when
 *   it succeeds, or in the vault with only named folders writable (a Holi's
 *   or an automation's run), and resumed for a follow-up.
 * - `fenced`: a session Holi runs whose terminal can be fenced to a folder
 *   of Holi's (`TerminalOpts.fence`): its cwd, its writes sandboxed there.
 *   What it may write is copied back at each turn's end (`host/fenced.ts`).
 */
import { AGENT_PROVIDER_IDS, type AgentProviderId } from '@holi/shared'
import type { BridgeRoute, SeedContribution } from '../../../main/plugin-api'
import type { ClaudeCli, VaultCliTarget } from './claude/cli'
import type { ClaudeRow, SessionSummary, StatusReading } from './claude/listing'
import type { SessionChannel } from './claude/messaging'

/** Which agent a session runs: the vault setting's own list. */
export type ProviderId = AgentProviderId

export const isProviderId = (value: unknown): value is ProviderId =>
  typeof value === 'string' && (AGENT_PROVIDER_IDS as readonly string[]).includes(value)

/** A vault the provider is asked about. */
export interface VaultRef {
  remote: string
  root: string
}

/** What a terminal runs. */
export interface TerminalCommand {
  bin: string
  args: string[]
  env: Record<string, string>
}

/**
 * What a terminal is opened on. Each provider reads the fields it has.
 * @public exported for its test
 */
export interface TerminalOpts {
  /** A background session to attach to (`background` only). */
  attach?: string
  /** A new conversation's id, a UUID Holi chose, for a provider that takes
   *  one (`namesConversation`). */
  conversation?: string
  /** A copy of a conversation, by the provider's id for it. */
  fork?: string
  /** The provider's own sign-in. */
  login?: boolean
  /** A conversation to pick up: its id, or `'pick'` for the provider's own
   *  picker. */
  resume?: string
  /** The session's first message. */
  prompt?: string
  /** Holi's id for a session it runs itself, which its hooks name. */
  session?: string
  /** A folder of Holi's the session is fenced to (`fenced` only): its cwd,
   *  its writes sandboxed to it, with no network, MCP servers or web search,
   *  and the agent's own approvals in its terminal. */
  fence?: string
}

/** Where the provider's hook routes are served (the bridge). */
export interface RouteServer {
  route(path: string, route: BridgeRoute): () => void
}

/** What a provider's hooks report, by the session id they carry: a
 *  background job id, or the id Holi gave a session it runs. */
export interface TurnRouteDeps {
  /** A turn began or ended. At an end, `pending` is how much the session
   *  said was still in flight, 0 meaning done; null when it does not say. */
  onTurn(remote: string, id: string, active: boolean, pending: number | null): void
  /** A status report (`status` reads it). */
  onStatus?(remote: string, id: string, status: unknown): void
  /** What the session said about itself at a turn's end: its first ask,
   *  which names it, and the provider's id for the conversation. */
  onConversation?(
    remote: string,
    id: string,
    about: { name?: string; conversationId?: string },
  ): void
  /** The session said where it takes messages: its inbox socket and token
   *  (`background`'s `message`). */
  onChannel?(remote: string, id: string, channel: SessionChannel): void
  log?: (msg: string) => void
}

/** Sessions the provider's own supervisor runs (Claude Code's `--bg`). */
interface BackgroundCapability {
  /** The provider's CLI verbs, each run for one vault. */
  cli: ClaudeCli
  /** The vault's sessions out of the CLI's listing. */
  parseListing(stdout: string | null, vaultRoot: string): ClaudeRow[]
  /** Is the session's process alive? */
  isLive(row: ClaudeRow): boolean
  /** What a live session is doing, for the renderer. */
  summarise(
    row: ClaudeRow,
    working: ReadonlySet<string>,
    reading?: StatusReading,
  ): Omit<SessionSummary, 'provider'>
  /** Call `onChange` when the config directory's session state moves.
   *  Returns the stop. */
  watch(configDir: string, onChange: () => void, log: (msg: string) => void): () => void
  /** Add a message to a running session's conversation through the channel
   *  its hooks reported. Throws a `CapabilityError` when it is not taken. */
  message(channel: SessionChannel, text: string): Promise<void>
}

/** What a job's output said, one line of it at a time. */
export type JobEvent =
  /** The agent's thread, and the model it runs on when it says. */
  | { kind: 'thread'; id: string; model?: string }
  | { kind: 'turn-started' }
  /** `tokens`: what the turn used, input and output, when it says. */
  | { kind: 'turn-completed'; tokens?: number }
  /** One reply of the agent's within the turn: what it used, and why it
   *  failed when it did. The turn's last reply says how the turn went. */
  | { kind: 'reply'; tokens?: number; error?: string }
  /** The run is over and the agent will not go on by itself: an agent that
   *  takes its input on stdin (`JobsCapability.input`) is then told to end. */
  | { kind: 'settled'; aborted: boolean }
  | { kind: 'turn-failed'; message: string }
  | { kind: 'error'; message: string }

/** How one turn of a job runs (`host/jobs.ts`). */
export interface JobRun {
  /** Where it runs, and the one folder it may write unless `readOnly`. */
  cwd: string
  prompt: string
  model?: string
  /** Other folders it may write, absolute. */
  writable?: readonly string[]
  /** It may write nothing at all. */
  readOnly?: boolean
  /** The agent's thread to add this turn to: a follow-up. */
  resume?: string
  /** A folder of Holi's for the agent's own state (its saved session), which
   *  it may write and which goes with the job. */
  state: string
  /** The vault, for a job that runs in it: readable, but for what in it is
   *  not the vault's shared content. */
  vault?: string
}

/** A prompt run unwatched, sandboxed by the agent (`host/jobs.ts`). */
interface JobsCapability {
  /** What runs one turn of the job. Null when the agent is not installed. */
  command(run: JobRun): TerminalCommand | null
  /** One line of the job's standard output, or null when it says nothing
   *  the host reads. Another program's output: never throws. */
  event(line: string): JobEvent | null
  /** Why no job can run on this machine at all, or null when one can. */
  unavailable?(): string | null
  /** An agent driven over its standard input (Pi's RPC mode): the lines
   *  that start a turn, and the one that asks it to stop. Its input is closed
   *  once the run settles or a command fails, which ends the process. */
  input?: { start(run: JobRun): string[]; abort: string }
}

interface ProviderCapabilities {
  background?: BackgroundCapability
  jobs?: JobsCapability
  /** `terminal` honours `TerminalOpts.fence`. */
  fenced?: true
  /** Serve the hook routes that report turns. Returns the undo. */
  turns?: { routes(server: RouteServer, deps: TurnRouteDeps): () => void }
  status?: {
    /** How full a session's context is, from its status report. */
    contextPercent(status: unknown): number | null
    /** The model a session runs on, from its status report. */
    model(status: unknown): string | null
  }
}

export interface AgentProvider {
  id: ProviderId
  /** Its name, as a person says it. */
  label: string
  /** Why a terminal could not open: the CLI is not on this machine. */
  notInstalled: string
  /** Whether its CLI is on this machine now. */
  installed(): boolean
  /** Provision the vault's directory for it. Null leaves the vault without
   *  this provider. */
  configure(vault: VaultRef): Promise<{ dir: string } | null>
  /** What a terminal runs. Null when the agent is not installed. */
  terminal(target: VaultCliTarget, opts?: TerminalOpts): TerminalCommand | null
  /** A directory that needs its own sign-in: true the first time Holi opens
   *  a terminal on it (consumed on read), and what that terminal prints. */
  firstSpawn?: { take(configDir: string): Promise<boolean>; notice: string }
  /** What the provider writes into a vault. */
  seed?: SeedContribution
  /** It takes an id Holi chose, a UUID, as its conversation's own (Pi's
   *  `--session-id`): a session is reopenable from its start, and a copy of
   *  one is a `fork` of it. */
  namesConversation?: boolean
  capabilities: ProviderCapabilities
}

/** A provider whose sessions its own supervisor runs. */
export type BackgroundProvider = AgentProvider & {
  capabilities: ProviderCapabilities & { background: BackgroundCapability }
}

export const hasBackground = (p: AgentProvider): p is BackgroundProvider =>
  p.capabilities.background !== undefined

/** A provider that runs jobs. */
export type JobsProvider = AgentProvider & {
  capabilities: ProviderCapabilities & { jobs: JobsCapability }
}

export const hasJobs = (p: AgentProvider): p is JobsProvider => p.capabilities.jobs !== undefined
