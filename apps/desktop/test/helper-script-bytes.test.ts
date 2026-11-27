import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { installHoliCli } from '../src/main/bridge/cli'
import { publishCliEndpoint } from '../src/main/bridge/cli-endpoint'
import { createCliTargetResolver } from '../src/main/bridge/cli-target'
import { createBridgeServer } from '../src/main/bridge/server'
import { createCapabilityHost } from '../src/main/capabilities/dispatch'
import { paramsObject, stringParam } from '../src/main/capabilities/params'
import { cap, createCapabilityRegistry } from '../src/main/capabilities/registry'
import { noCoreServices } from '../src/main/capabilities/services'
import { VaultRegistry } from '../src/main/vault/registry'

const exec = promisify(execFile)

// These are native POSIX executions, not Windows Git Bash portability checks.
it.skipIf(process.platform === 'win32').each(['darwin', 'linux'] as const)(
  'dispatches commands through the installed %s helper and requires its endpoint',
  async (platform) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "holi helper's files ")))
    const vaults = new VaultRegistry(join(root, 'registry.json'))
    const capabilities = createCapabilityRegistry()
    const targets = createCliTargetResolver(vaults, () => true)
    let endpoint: Awaited<ReturnType<typeof publishCliEndpoint>> | undefined
    const host = createCapabilityHost({
      registry: capabilities,
      rootFor: async () => root,
      get: () => null,
      core: noCoreServices,
      pluginEnabled: async () => true,
      claims: async () => [],
    })
    const server = createBridgeServer({
      log: () => {},
      cli: {
        dispatch: host.dispatch,
        commands: (remote) => capabilities.commands(remote),
        rootFor: async () => root,
        machine: {
          token: () => endpoint?.token ?? '',
          resolveTarget: async (selector, cwd) => {
            const target = await targets.resolve(selector, cwd)
            return (
              target && {
                remote: target.entry.remote,
                root: target.entry.path,
                live: target.live,
              }
            )
          },
        },
      },
    })
    try {
      await vaults.add({
        remote: 'owner/notes',
        name: 'Notes',
        path: root,
        lastOpenedAt: '2026-01-01',
      })
      capabilities.register(['probe'], {
        'probe.echo': cap({
          doors: ['cli'],
          cli: { args: ['text'], summary: 'echo text in the selected vault' },
          params: (raw) => ({ text: stringParam(paramsObject(raw), 'text') }),
          run: async (ctx, params) => `${ctx.remote}: ${params.text}`,
          text: (value) => value,
        }),
      })
      const cli = await installHoliCli(root, platform)
      await server.start()
      endpoint = await publishCliEndpoint(join(root, 'cli-endpoint.json'), server.port()!)
      const text = "spaces, 'quotes', $variables & æøå"
      const args = ['probe', 'echo', text, '--vault=owner/notes']
      const options = { cwd: root, env: { PATH: process.env.PATH }, timeout: 10_000 }
      expect(await exec(cli, args, options)).toMatchObject({
        stdout: `owner/notes: ${text}\n`,
        stderr: '',
      })
      await endpoint.dispose()
      endpoint = undefined
      await expect(exec(cli, args, options)).rejects.toMatchObject({ code: 1, stdout: '' })
    } finally {
      await endpoint?.dispose()
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  },
)
