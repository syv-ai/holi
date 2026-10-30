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
 *   rules, its output read as events (`host/jobs.ts`). Codex's `codex exec`.
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
  /** A folder of Holi's the session is fenced to (`fenced` only): its cwd
   *  (`dir`), its writes sandboxed to it, with no network, MCP servers or web
   *  search, and the agent's own approvals in its terminal; and a folder of
   *  Holi's outside it for the agent's own state (`state`). */
  fence?: { dir: string; state: string }
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
  | { kind: 'thread'; id: string }
  | { kind: 'turn-started' }
  /** `tokens`: what the turn used, input and output, when it says. */
  | { kind: 'turn-completed'; tokens?: number }
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
  /** A folder of Holi's outside what it may write, for the agent's own
   *  state (its own home, say), which goes with the job. */
  state: string
}

/** A prompt run unwatched, sandboxed by the agent (`host/jobs.ts`). */
interface JobsCapability {
  /** Its sandbox bounds what it writes, not what it reads: a job can read any
   *  file on this computer, so one runs unattended only in a vault this
   *  machine allowed (`host/unattended.ts`). Codex's. */
  readsAnywhere?: true
  /** What runs one turn of the job. Null when the agent is not installed.
   *  Throws with a sentence when it cannot run. */
  command(run: JobRun): TerminalCommand | null
  /** One line of the job's standard output, or null when it says nothing
   *  the host reads. Another program's output: never throws. */
  event(line: string): JobEvent | null
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
  /** A process Holi ran on one of its state folders (a job's, a fenced
   *  session's) has exited: take back what the agent keeps of the person's,
   *  such as a sign-in it refreshed there. Never throws. */
  release?(state: string): Promise<void>
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
