/**
 * Claude Code as the agent's provider (`../provider.ts`): its CLI, its
 * session listing, its per-vault config directory, the terminal command, its
 * hook routes and its seed.
 *
 * No `electron` import: the caller hands in the colour mode it reads from
 * `nativeTheme`, so this loads under plain Node in the tests.
 */
import { readBlockedQuestion } from './blocked'
import { findTranscript, readTranscript } from './transcript'
import type { AgentProvider } from '../provider'
import { createClaudeCli, terminalCommand } from './cli'
import { resolveVaultAgentConfig, SIGN_IN_NOTICE, takeFirstSpawn } from './config-dir'
import {
  isLive,
  parseListing,
  readContextPercent,
  summarise,
  summarisePast,
  watchConfigDir,
} from './listing'
import { registerAgentRoutes } from './routes'
import { claudeSeed } from './seed'

export interface ClaudeProviderDeps {
  /** Holi's data directory, where each vault's config directory lives. */
  userData: string
  /** The `holi` command, for every session's settings `env`. */
  holiBin(): string
  /** The OS asks for dark: what a vault's `system` colour scheme means. */
  systemPrefersDark(): boolean
}

export function claudeProvider(deps: ClaudeProviderDeps): AgentProvider {
  return {
    cli: createClaudeCli(),
    parseListing,
    isLive,
    summarise,
    summarisePast,
    readContextPercent,
    watch: watchConfigDir,
    // Per vault open, not per launch: the open vault moves, and the theme
    // stamped into its directory tracks a setting the user can flip while
    // the app runs. Static paths every session needs ride in the settings
    // `env` block, the one channel that reaches a background session.
    configure: ({ remote, root }) =>
      resolveVaultAgentConfig({
        userDataDir: deps.userData,
        remote,
        root,
        systemPrefersDark: deps.systemPrefersDark(),
        env: { HOLI_BIN: deps.holiBin() },
      }),
    transcript: async (configDir, sessionId, offset) => {
      const path = await findTranscript(configDir, sessionId)
      return path === null ? null : readTranscript(path, sessionId, offset)
    },
    blockedQuestion: readBlockedQuestion,
    takeFirstSpawn,
    signInNotice: SIGN_IN_NOTICE,
    terminal: (target, attach) => terminalCommand(target, attach),
    routes: registerAgentRoutes,
    seed: claudeSeed,
  }
}
