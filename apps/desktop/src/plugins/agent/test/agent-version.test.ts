/**
 * `holi agent version`: Holi's version and the Claude Code one, which is
 * `unknown` when Claude Code cannot say and cleanup is confirmed.
 */
import { ChildProcess } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  execProgram,
  UnconfirmedOwnedProgramError,
  type CapabilityContext,
} from '../../../main/plugin-api'
import { createAgentProbeOwner } from '../main/probe-owner'
import { versionCapabilities } from '../main/version'

vi.mock('../../../main/plugin-api', async (actual) => ({
  ...(await actual<typeof import('../../../main/plugin-api')>()),
  execProgram: vi.fn(),
}))
afterEach(() => vi.mocked(execProgram).mockReset())

const versionText = (
  deps: Omit<Parameters<typeof versionCapabilities>[0], 'probes'>,
  probes = createAgentProbeOwner(new AbortController().signal),
) => {
  const entry = versionCapabilities({ ...deps, probes })['agent.version']
  return entry
    .run({} as CapabilityContext, entry.params({}))
    .then((result) => entry.text?.(result) ?? '')
}

function commandError(code: number | string) {
  return Object.assign(new Error(`command failed with ${code}`), { code, cmd: 'claude --version' })
}

function holdVersionCallback() {
  let callback: Parameters<typeof execProgram>[3] | undefined
  vi.mocked(execProgram).mockImplementationOnce((_bin, _args, _opts, done) => {
    callback = done
    return new ChildProcess()
  })
  return (...args: Parameters<Parameters<typeof execProgram>[3]>) => callback!(...args)
}

describe('agent.version', () => {
  it('prints both versions, asking claude --version', async () => {
    const asked: string[][] = []
    const text = await versionText({
      holi: '0.5.0',
      claudeBin: () => '/bin/claude',
      run: async (bin, args) => {
        asked.push([bin, ...args])
        return '2.1.312 (Claude Code)\n'
      },
    })
    expect(asked).toEqual([['/bin/claude', '--version']])
    expect(text).toBe('Holi 0.5.0\nClaude Code 2.1.312')
  })

  it('uses Holi’s Claude binary even when the Dock PATH cannot find it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holi-agent-version-'))
    // Windows runs only a file with a program's extension.
    const bin = join(dir, process.platform === 'win32' ? 'claude.cmd' : 'claude')
    try {
      await writeFile(bin, '#!/bin/sh\n')
      await chmod(bin, 0o755)
      vi.stubEnv('HOLI_CLAUDE_BIN', bin)
      vi.stubEnv('PATH', '/nonexistent')
      const asked: string[][] = []
      const text = await versionText({
        holi: '0.5.0',
        run: async (resolvedBin, args) => {
          asked.push([resolvedBin, ...args])
          return '2.1.312 (Claude Code)\n'
        },
      })
      expect(asked).toEqual([[bin, '--version']])
      expect(text).toBe('Holi 0.5.0\nClaude Code 2.1.312')
    } finally {
      vi.unstubAllEnvs()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('says unknown when claude is not on this machine', async () => {
    const text = await versionText({ holi: '0.5.0', claudeBin: () => null })
    expect(text).toBe('Holi 0.5.0\nClaude Code unknown')
  })

  it('says unknown when the resolver cannot inspect the binary', async () => {
    const text = await versionText({
      holi: '0.5.0',
      claudeBin: () => {
        throw new Error('access denied')
      },
    })
    expect(text).toBe('Holi 0.5.0\nClaude Code unknown')
  })

  it('keeps unconfirmed ownership metadata alongside the primary exit error', async () => {
    const done = holdVersionCallback()
    const controller = new AbortController()
    const probes = createAgentProbeOwner(controller.signal)
    const deps = { holi: '0.5.0', claudeBin: () => '/bin/claude' }
    const version = versionText(deps, probes)
    controller.abort()
    const stopping = probes.stop()
    const stopped = vi.fn()
    void stopping.then(stopped, stopped)
    const primary = commandError(7)
    const cause = new Error('receipt transport failed')
    const revokeFailure = new Error('broker could not confirm zero')
    const lease = { revoke: vi.fn().mockRejectedValue(revokeFailure) }
    done(primary, '', 'command-controlled stderr', { kind: 'unconfirmed', cause, lease })
    const observed = await version.catch((error: unknown) => error)
    expect(observed).toBeInstanceOf(UnconfirmedOwnedProgramError)
    const failure = observed as UnconfirmedOwnedProgramError
    expect(failure.cause).toBe(cause)
    expect(failure.lease).toBe(lease)
    expect(failure.commandError).toBe(primary)
    await expect(versionText(deps, probes)).rejects.toBe(failure)
    expect(execProgram).toHaveBeenCalledTimes(1)
    await expect(stopping).rejects.toMatchObject({ errors: [failure, revokeFailure] })
    expect(probes.stop()).toBe(stopping)
    expect(stopped).toHaveBeenCalledOnce()
    expect(lease.revoke).toHaveBeenCalledOnce()
  })

  it.each(['EMPTY', 'not-started'])(
    'says unknown for a known %s command failure, and can probe again',
    async (outcome) => {
      const probes = createAgentProbeOwner(new AbortController().signal)
      const deps = { holi: '0.5.0', claudeBin: () => '/bin/claude' }
      const done = holdVersionCallback()
      const version = versionText(deps, probes)
      // Both receipts have the same settled metadata at the exec callback seam.
      const error = commandError(outcome === 'EMPTY' ? 7 : 'ENOENT')
      done(error, '', '', { kind: 'settled' })
      await expect(version).resolves.toBe('Holi 0.5.0\nClaude Code unknown')

      const finishNext = holdVersionCallback()
      const next = versionText(deps, probes)
      finishNext(null, '2.1.312 (Claude Code)\n', '', { kind: 'settled' })
      await expect(next).resolves.toBe('Holi 0.5.0\nClaude Code 2.1.312')
      await expect(probes.stop()).resolves.toBeUndefined()
      expect(execProgram).toHaveBeenCalledTimes(2)
    },
  )

  it('says unknown when claude fails or times out', async () => {
    const text = await versionText({
      holi: '0.5.0',
      claudeBin: () => '/bin/claude',
      run: () => Promise.reject(new Error('timed out')),
    })
    expect(text).toBe('Holi 0.5.0\nClaude Code unknown')
  })
})
