/**
 * Claude Code as a provider (`../provider.ts`): every capability. Its
 * sessions are background sessions its supervisor runs, its hooks report
 * turns and its status line the context and model.
 *
 * No `electron` import: the caller hands in the colour mode it reads from
 * `nativeTheme`, so this loads under plain Node in the tests.
 */
import type { BackgroundProvider } from '../provider'
import { createClaudeCli, NOT_INSTALLED, resolveClaudeBin, terminalCommand } from './cli'
import { resolveVaultAgentConfig, SIGN_IN_NOTICE, takeFirstSpawn } from './config-dir'
import {
  isLive,
  parseListing,
  readContextPercent,
  readModelName,
  summarise,
  watchConfigDir,
} from './listing'
import { postToSession } from './messaging'
import { registerAgentRoutes } from './routes'
import { claudeSeed } from './seed'

export interface ClaudeProviderDeps {
  /** Holi's data directory, where each vault's config directory lives. */
  userData: string
  /** The `holi` command, for every session's settings `env`. */
  holiBin(): string
  /** The OS asks for dark: what a vault's `system` colour scheme means. */
  systemPrefersDark(): boolean
  /** Which `claude` runs: its preset's (`../harness/registry.ts`). */
  resolveBin?: () => string | null
}

export function claudeProvider(deps: ClaudeProviderDeps): BackgroundProvider {
  const resolveBin = deps.resolveBin ?? (() => resolveClaudeBin())
  return {
    id: 'claude',
    label: 'Claude Code',
    notInstalled: NOT_INSTALLED,
    installed: () => resolveBin() !== null,
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
    terminal: (target, opts = {}) =>
      terminalCommand(target, opts.attach, resolveBin, opts.fork, opts.login),
    firstSpawn: { take: takeFirstSpawn, notice: SIGN_IN_NOTICE },
    seed: claudeSeed,
    capabilities: {
      background: {
        cli: createClaudeCli({ resolveBin }),
        parseListing,
        isLive,
        summarise,
        watch: watchConfigDir,
        message: postToSession,
      },
      turns: { routes: registerAgentRoutes },
      status: { contextPercent: readContextPercent, model: readModelName },
    },
  }
}
