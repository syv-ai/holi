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
  'Pi is not installed. Install it with `npm install -g @mariozechner/pi-coding-agent`.'

const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface PiProviderDeps {
  resolveBin?: () => string | null
}

export function piProvider(deps: PiProviderDeps = {}): AgentProvider {
  const bin = deps.resolveBin ?? (() => resolveBin('pi'))
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
      const env = buildPiEnv(process.env, { binDir: target.binDir })
      return { bin: path, args, env }
    },
    capabilities: {},
  }
}
