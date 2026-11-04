/**
 * Stock Pi CLI as an interactive provider. It deliberately uses the user's
 * normal Pi home/configuration and runs in the managed vault directory.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveBin } from '../../../../main/plugin-api'
import { buildPiEnv } from './env'
import type { AgentProvider } from '../provider'

/** @public */
export const NOT_INSTALLED =
  'Pi is not installed. Install it with `npm install -g @earendil-works/pi-coding-agent`.'

const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface PiProviderDeps {
  resolveBin?: () => string | null
  /** Variables the Pi preset adds (Settings, General, Agents). */
  env?: () => Readonly<Record<string, string>>
}

/** How every Pi process Holi starts is found and given its environment, a
 *  terminal's and an RPC run's alike: the preset's program, else `pi` on
 *  `PATH`, and Holi's agent environment plus the preset's variables. The
 *  preset's arguments are a terminal's alone: an RPC run's are its mode. */
export function piCommand(deps: PiProviderDeps = {}) {
  return {
    bin: deps.resolveBin ?? (() => resolveBin('pi')),
    env: (binDir: string | null | undefined): Record<string, string> => ({
      ...buildPiEnv(process.env, { binDir }),
      ...deps.env?.(),
    }),
  }
}

export function piProvider(deps: PiProviderDeps = {}): AgentProvider {
  const { bin, env: envFor } = piCommand(deps)
  return {
    id: 'pi',
    label: 'Pi',
    notInstalled: NOT_INSTALLED,
    installed: () => bin() !== null,
    namesConversation: true,
    // Pi owns its normal user config; no per-vault copy or config isolation.
    configure: async () => ({ dir: process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi') }),
    terminal: (target, opts = {}) => {
      const path = bin()
      if (path === null) return null
      const conversation = opts.conversation
      const args =
        opts.resume === 'pick'
          ? ['--resume']
          : opts.fork !== undefined && CONVERSATION_ID.test(opts.fork)
            ? [
                '--fork',
                opts.fork,
                ...(conversation && CONVERSATION_ID.test(conversation)
                  ? ['--session-id', conversation]
                  : []),
              ]
            : opts.resume !== undefined && CONVERSATION_ID.test(opts.resume)
              ? ['--session-id', opts.resume]
              : conversation !== undefined && CONVERSATION_ID.test(conversation)
                ? ['--session-id', conversation]
                : []
      if (opts.prompt !== undefined && opts.prompt.trim() !== '') args.push('--', opts.prompt)
      return { bin: path, args, env: envFor(target.binDir) }
    },
    // Create vault app runs it in a scratch folder of Holi's, copied back
    // each turn, but nothing sandboxes it there: it keeps the person's own
    // permissions, as its background runs do.
    capabilities: { fenced: 'folder' },
  }
}
