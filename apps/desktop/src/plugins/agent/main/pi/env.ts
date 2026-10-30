import { buildAgentEnv } from '../claude/cli'

/**
 * Remove only the parent Pi session's process-local identity and worktree
 * handoff. Pi's configuration still comes from its normal home and config
 * files; unrelated environment configuration is passed through unchanged.
 */
const PARENT_SESSION_ENV = [
  'PI_SESSION_ID',
  'PI_SESSION_FILE',
  'PI_PROVIDER',
  'PI_MODEL',
  'PI_REASONING_LEVEL',
  'PI_WORKTREE_SESSION_MANIFEST',
  'PI_WORKTREE_SESSION_ID',
  'PI_SESSION_CONTINUATION',
  'PI_WORKTREE_SESSION_CONTINUATION',
] as const

export function buildPiEnv(
  base: NodeJS.ProcessEnv,
  opts: { binDir?: string | null } = {},
): Record<string, string> {
  const env = buildAgentEnv(base, opts)
  for (const key of PARENT_SESSION_ENV) delete env[key]
  return env
}
