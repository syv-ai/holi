/**
 * `holi agent version`: the Holi release and the Claude Code it runs, for a
 * feedback issue's context (the holi-feedback skill). The agent need not find
 * `claude` itself, which may not be on its `PATH`.
 *
 * Claude Code is asked only when the command runs, with a timeout, and is
 * `unknown` when it cannot say, unless its cleanup cannot be confirmed.
 *
 * No Electron import: this loads under plain Node in the tests.
 */
import { cap, execProgram, noParams, UnconfirmedOwnedProgramError } from '../../../main/plugin-api'
import { buildAgentEnv, resolveClaudeBin } from './claude/cli'
import type { AgentProbeOwner } from './probe-owner'

const VERSION_TIMEOUT_MS = 5_000

interface VersionDeps {
  /** The running Holi's version. */
  holi: string
  probes: AgentProbeOwner
  /** The `claude` Holi runs, or null when it is not on this machine. */
  claudeBin?: () => string | null
  /** Injected so tests never shell out. Resolves with stdout. */
  run?: (bin: string, args: string[], timeoutMs: number) => Promise<string>
}

function defaultRun(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // The agent's environment: an npm-installed `claude` finds `node` on its
    // PATH, and the session's own Claude Code variables are not passed on.
    const child = execProgram(
      bin,
      args,
      {
        timeoutMs,
        maxBuffer: 64 * 1024,
        encoding: 'utf8',
        env: buildAgentEnv(process.env),
      },
      (err, stdout, _stderr, ownership) => {
        if (ownership?.kind === 'unconfirmed') {
          reject(
            err instanceof UnconfirmedOwnedProgramError &&
              err.cause === ownership.cause &&
              err.lease === ownership.lease
              ? err
              : new UnconfirmedOwnedProgramError(ownership.cause, ownership.lease, err),
          )
        } else if (err instanceof UnconfirmedOwnedProgramError) {
          reject(err)
        } else if (process.platform === 'win32' && ownership?.kind !== 'settled') {
          reject(
            new UnconfirmedOwnedProgramError(
              new Error('Windows version probe did not report ownership completion'),
              undefined,
              err,
            ),
          )
        } else if (err) reject(err)
        else resolve(stdout)
      },
    )
    // No input: `claude` waits on an open stdin pipe (`claude/cli.ts`).
    child.stdin?.end()
  })
}

interface Versions {
  holi: string
  /** `claude --version`'s number, or `unknown`. */
  claudeCode: string
}

export const versionCapabilities = (deps: VersionDeps) => {
  const claudeBin = deps.claudeBin ?? (() => resolveClaudeBin())
  const run = deps.run ?? defaultRun

  async function claudeCode(): Promise<string> {
    try {
      const bin = claudeBin()
      if (bin === null) return 'unknown'
      // `2.1.312 (Claude Code)`: the name is said once, in the text below.
      const out = await run(bin, ['--version'], VERSION_TIMEOUT_MS)
      const line = (out.trim().split('\n')[0] ?? '').replace(/\s*\(Claude Code\)$/, '')
      return line === '' ? 'unknown' : line
    } catch (error) {
      if (error instanceof UnconfirmedOwnedProgramError) throw error
      return 'unknown'
    }
  }

  return {
    'agent.version': cap({
      doors: ['cli'],
      cli: { args: [], summary: "Holi's version and the Claude Code version it runs" },
      params: noParams,
      run: async (): Promise<Versions> => ({
        holi: deps.holi,
        claudeCode: await deps.probes.run(claudeCode),
      }),
      text: (v) => `Holi ${v.holi}\nClaude Code ${v.claudeCode}`,
    }),
  }
}
