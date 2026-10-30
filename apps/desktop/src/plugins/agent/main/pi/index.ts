/**
 * Stock Pi CLI as an interactive provider. It deliberately uses the user's
 * normal Pi home/configuration and runs in the managed vault directory.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveBin } from '../../../../main/bin'
import type { AgentProvider } from '../provider'

export const NOT_INSTALLED =
  'Pi is not installed. Install it with `npm install -g @mariozechner/pi-coding-agent`.'

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
    // Pi owns its normal user config; no per-vault copy or config isolation.
    configure: async () => ({ dir: process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi') }),
    terminal: (_target, opts = {}) => {
      const path = bin()
      if (path === null) return null
      const args =
        opts.resume === undefined
          ? []
          : ['--resume', ...(opts.resume === 'pick' ? [] : [opts.resume])]
      if (opts.prompt !== undefined && opts.prompt.trim() !== '') args.push(opts.prompt)
      return { bin: path, args, env: { ...process.env } }
    },
    capabilities: {},
  }
}
