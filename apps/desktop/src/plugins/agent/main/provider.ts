/**
 * The line between the agent host and the coding agent it runs
 * (docs/features/agent-sessions.md).
 *
 * The host owns the PTYs and terminal mirror, the turn coordinator, turn
 * review and the session surface. The provider is everything that is one
 * agent's own: its CLI verbs, its session listing, its per-vault config
 * directory, the command a terminal runs, its hook routes and what it seeds.
 *
 * Exactly what the host calls today, in Claude Code's shapes. Claude Code is
 * the one provider (`claude/`), so the types stay its own until a second
 * provider is written and shows which parts are really shared.
 */
import type { BridgeRoute, SeedContribution } from '../../../main/plugin-api'
import type { ClaudeCli, VaultCliTarget } from './claude/cli'
import type { ClaudeRow, PastSession, SessionSummary } from './claude/listing'
import type { AgentRoutesDeps } from './claude/routes'
import type { TranscriptChunk } from './claude/transcript'

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

/** Where the provider's hook routes are served (the bridge). */
export interface RouteServer {
  route(path: string, route: BridgeRoute): () => void
}

export interface AgentProvider {
  /** The provider's CLI verbs, each run for one vault. */
  cli: ClaudeCli
  /** The vault's sessions out of the CLI's listing. */
  parseListing(stdout: string | null, vaultRoot: string): ClaudeRow[]
  /** Is the session's process alive? */
  isLive(row: ClaudeRow): boolean
  /** A session whose process has gone, as a line of the agent's history. */
  summarisePast(row: ClaudeRow): PastSession
  /** What a live session is doing, for the renderer. */
  summarise(row: ClaudeRow, working: ReadonlySet<string>, contextPercent?: number): SessionSummary
  /** How full a session's context is, from its status report. */
  readContextPercent(status: unknown): number | null
  /** A conversation from `offset` on, for the chat. Null when it has no
   *  transcript to read. */
  transcript(configDir: string, sessionId: string, offset?: number): Promise<TranscriptChunk | null>
  /** The question a session is blocked on, as the JSON of its
   *  `AskUserQuestion` input, when the transcript does not hold it yet. */
  blockedQuestion(configDir: string, jobId: string): Promise<string | null>
  /** Call `onChange` when the config directory's session state moves.
   *  Returns the stop. */
  watch(configDir: string, onChange: () => void, log: (msg: string) => void): () => void
  /** Provision the vault's config directory. Null leaves the vault without
   *  an assistant. */
  configure(vault: VaultRef): Promise<{ dir: string } | null>
  /** True the first time Holi opens a terminal on this config directory,
   *  consumed on read. */
  takeFirstSpawn(configDir: string): Promise<boolean>
  /** Printed into that first terminal: the directory needs its own sign-in. */
  signInNotice: string
  /** What a terminal on the list (no `attach`) or on one session runs. Null
   *  when the agent is not installed on this machine. */
  terminal(target: VaultCliTarget, attach?: string): TerminalCommand | null
  /** Serve the hook routes that report turns and status. Returns the undo. */
  routes(server: RouteServer, deps: AgentRoutesDeps): () => void
  /** What the provider writes into a vault. */
  seed: SeedContribution
}
