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
 *   of Holi's (`TerminalOpts.fence`): its cwd, and with `sandbox` its writes
 *   sandboxed there (Codex); with `folder` only its cwd, the agent free to
 *   reach past it with the person's own permissions (Pi). Either way what it
 *   may write is copied back at each turn's end (`host/fenced.ts`).
 */
import { isAgentId, type AgentProviderId } from '@holi/shared'
import type { BridgeRoute, SeedContribution } from '../../../main/plugin-api'
import type { ClaudeCli, VaultCliTarget } from './claude/cli'
import type { ClaudeRow, SessionSummary, StatusReading } from './claude/listing'
import type { SessionChannel } from './claude/messaging'

/** Which agent a session runs: one of this machine's harnesses, by its id
 *  (`harness/registry.ts`). The shape is checked here; whether it names one,
 *  against the registry. */
export type ProviderId = AgentProviderId

export const isProviderId = (value: unknown): value is ProviderId => isAgentId(value)

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
  /** Holi's stable conversation id for providers that can reopen a session. */
  conversation?: string
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
   *  said was still in flight, 0 meaning done; null when it does not say. An
   *  end may answer the tree of the settle commit Holi made for the turn, for
   *  the Stop hook to count the next prompt's changes from. At a start, `pid`
   *  is the session's own process, when its hook says. */
  onTurn(
    remote: string,
    id: string,
    active: boolean,
    pending: number | null,
    pid?: number,
  ): void | Promise<string | null>
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
  /** The vault's root, which a scratch job does not run in. */
  root: string
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
  /** `terminal` runs in `TerminalOpts.fence`'s folder: sandboxed there
   *  (`sandbox`), or with nothing holding it to it (`folder`). */
  fenced?: 'sandbox' | 'folder'
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
  /** Whether Holi can name new conversations and reopen them by that id. */
  namesConversation?: boolean
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
  /** Why a terminal cannot open on `opts`, in words, or null when it can:
   *  a harness a person added that was given no way to start on a message
   *  or to pick up a conversation. Absent: it takes every option. */
  refuses?(opts: TerminalOpts): string | null
  /** Why it runs nothing unattended, when it has neither `background` nor
   *  `jobs`: said instead of running the work on another agent. */
  unattended?: string
  /** It is a harness a person added (`harness/`), not a built-in agent. */
  custom?: boolean
  capabilities: ProviderCapabilities
}

/** What a terminal on `configDir` prints first: the provider's sign-in
 *  notice, the first time Holi opens one there (`firstSpawn`). */
export async function firstSpawnNotice(
  provider: Pick<AgentProvider, 'firstSpawn'>,
  configDir: string,
): Promise<string | undefined> {
  const first = provider.firstSpawn
  if (first === undefined) return undefined
  return (await first.take(configDir).catch(() => false)) ? first.notice : undefined
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
