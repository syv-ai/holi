import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createBridgeEnv } from '../../../../main/bridge/env-file'
import type { BridgeServer, Route } from '../../../../main/bridge/server'
import { codexProvider, registerCodexRoutes } from '../../main/codex'
import { createPtySessions } from '../../main/host/pty-sessions'
import { startCodexTuiModel } from './codex-tui-model'
import { createCodexTuiTerminals } from './codex-tui-terminal'

type NativeHandle = Awaited<
  ReturnType<NonNullable<NonNullable<Parameters<typeof createCodexTuiTerminals>[0]>['launch']>>
>
const { startOwnedPty } = createRequire(import.meta.url)(
  '../../../../../../../scripts/pi-native-tui-process.mjs',
) as { startOwnedPty(options: Record<string, unknown>): Promise<NativeHandle> }

export async function createCodexTuiContext({
  root,
  bin,
  bridge,
  remote,
  mode,
  onOwned,
}: {
  root: string
  bin: string
  bridge: BridgeServer
  remote: string
  mode: 'success' | 'approval'
  onOwned(record: { directory: string | null; removed: boolean; nativeDrained: boolean }): void
}) {
  if (process.platform !== 'darwin')
    throw new Error('Native TUI containment requires macOS Seatbelt')
  const ownership = { directory: null as string | null, removed: false, nativeDrained: false }
  onOwned(ownership)
  const directory = await realpath(await mkdtemp(join(root, 'context-')))
  ownership.directory = directory
  const vault = join(directory, 'vault')
  const env: NodeJS.ProcessEnv = {
    HOME: join(directory, 'home'),
    CODEX_HOME: join(directory, 'codex'),
    XDG_CONFIG_HOME: join(directory, 'xdg'),
    XDG_CACHE_HOME: join(directory, 'xdg'),
    TMPDIR: join(directory, 'tmp'),
    PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    TERM: 'xterm-256color',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
  }
  const model = startCodexTuiModel({ mode })
  const bridgeEnv = createBridgeEnv()
  const native: Array<{
    handle: NativeHandle
    argv: string[]
    inputs: Array<{ hex: string; outputOffset: number }>
    receipt?: { drained: boolean }
  }> = []
  const brackets: Array<{ id: string; edge: string }> = []
  const changes: Array<ReturnType<ReturnType<typeof createPtySessions>['sessions']>> = []
  const received: Array<{ remote: string; session: string | null; body: string }> = []
  const consumed: Array<{
    remote: string
    id: string
    kind: string
    before: unknown
    after: unknown
  }> = []
  let gate: Promise<void> | undefined
  let release: (() => void) | undefined
  let detachRoutes = () => {}
  let undoVars = () => {}
  let closeWork: Promise<void> | undefined
  let removed = false
  const releaseNotify = () => {
    release?.()
    release = undefined
    gate = undefined
  }
  const terminals = createCodexTuiTerminals({
    launch: async (args) => {
      if (!args.command) throw new Error(args.notInstalled)
      const argv = [
        '-f',
        join(directory, 'policy.sb'),
        args.command.bin,
        '--no-daemon',
        ...args.command.args,
      ]
      const handle = await startOwnedPty({
        command: '/usr/bin/sandbox-exec',
        args: argv,
        cwd: args.cwd,
        env: args.command.env,
        stateDirectory: join(root, 'pty-state', remote.replaceAll('/', '-'), String(native.length)),
        timeoutMs: 45_000,
        maxOutputBytes: 262_144,
      })
      const entry: (typeof native)[number] = { handle, argv, inputs: [] }
      native.push(entry)
      return {
        get output() {
          return handle.output
        },
        get failure() {
          return handle.failure
        },
        get nativeExit() {
          return handle.nativeExit
        },
        waitForExit: () => handle.waitForExit(),
        write: async (bytes) => {
          entry.inputs.push({
            hex: Buffer.from(bytes).toString('hex'),
            outputOffset: handle.output.length,
          })
          await handle.write(bytes)
        },
        close: async () => {
          entry.receipt = await handle.close()
          return entry.receipt
        },
      }
    },
  })
  const sessions = createPtySessions({
    vault: { root: vault, remote },
    providers: () => [codexProvider({ base: env, resolveBin: () => bin })],
    terminals,
    binDir: () => null,
    idleMs: 120_000,
    bracket: (id, edge) => {
      brackets.push({ id, edge })
    },
    onChange: (rows) => {
      changes.push(structuredClone(rows))
    },
  })
  const close = () =>
    (closeWork ??= (async () => {
      releaseNotify()
      const failures: unknown[] = []
      for (const work of [
        () => sessions.leave(),
        ...terminals.list().map(
          ({ id }) =>
            () =>
              terminals.close(id),
        ),
        async () => {
          detachRoutes()
          undoVars()
          await bridgeEnv.detach(remote)
        },
        () => model.close(),
      ]) {
        try {
          await work()
        } catch (error) {
          failures.push(error)
        }
      }
      ownership.nativeDrained = native.every(({ receipt }) => receipt?.drained === true)
      if (native.some(({ receipt }) => receipt?.drained !== true))
        failures.push(new Error('Native PTY drainage missing'))
      if (failures.length) throw new AggregateError(failures, 'Native context cleanup incomplete')
      await rm(directory, { recursive: true, force: true })
      removed = true
      ownership.removed = true
    })())
  try {
    for (const path of [
      vault,
      env.HOME!,
      env.CODEX_HOME!,
      env.XDG_CONFIG_HOME!,
      env.TMPDIR!,
      join(vault, '.holi'),
    ])
      await mkdir(path, { recursive: true, mode: 0o700 })
    await writeFile(join(vault, '.holi/vault'), JSON.stringify({ remote }), { mode: 0o600 })
    await nativeUntil(() => model.port > 0, 'model listener', 3000)
    const port = bridge.port()
    if (!port) throw new Error('Production bridge is not listening')
    await writeFile(
      join(env.CODEX_HOME!, 'config.toml'),
      `model = "gpt-5.1-codex-mini"
model_provider = "holi-fixture"
approval_policy = "on-request"
sandbox_mode = "workspace-write"
web_search = "disabled"
check_for_update_on_startup = false
[model_providers.holi-fixture]
name = "Holi fixture"
base_url = "http://127.0.0.1:${model.port}/v1"
wire_api = "responses"
requires_openai_auth = false
[sandbox_workspace_write]
network_access = false
[tui]
notifications = ["approval-requested"]
notification_method = "osc9"
notification_condition = "always"
[analytics]
enabled = false
`,
      { mode: 0o600 },
    )
    await writeFile(
      join(directory, 'policy.sb'),
      `(version 1)
(allow default)
(deny network*)
(allow network-outbound (remote ip "localhost:${model.port}") (remote ip "localhost:${port}"))
(deny file-write*)
(allow file-write* (subpath ${JSON.stringify(directory)}))
(allow file-write* (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/ttys[0-9]+$"))
`,
      { mode: 0o600 },
    )
    undoVars = bridgeEnv.contribute(remote, {
      HOLI_BRIDGE_PORT: String(port),
      HOLI_BRIDGE_TOKEN: bridge.tokenForVault(remote),
    })
    await bridgeEnv.attach(remote, vault)
    detachRoutes = registerCodexRoutes(
      {
        route: (path, route) =>
          bridge.route(
            path,
            {
              body: route.body,
              async handle(...args: Parameters<Route['handle']>) {
                received.push({ remote: args[0], session: args[1].get('session'), body: args[2] })
                if (gate) await gate
                return route.handle(...args)
              },
            },
            remote,
          ),
      },
      {
        onConversation: (origin, id, about) => {
          const before = sessions.sessions()
          if (origin !== remote) throw new Error('Cross-vault conversation delivery')
          sessions.noteConversation(id, about)
          consumed.push({
            remote: origin,
            id,
            kind: 'conversation',
            before,
            after: sessions.sessions(),
          })
        },
        onTurn: (origin, id, active) => {
          const before = sessions.sessions()
          if (origin !== remote) throw new Error('Cross-vault turn delivery')
          sessions.noteTurn(id, active)
          consumed.push({ remote: origin, id, kind: 'turn', before, after: sessions.sessions() })
        },
      },
    )
  } catch (error) {
    try {
      await close()
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Native context setup and cleanup failed')
    }
    throw error
  }
  return {
    sessions,
    terminals,
    model,
    received,
    consumed,
    brackets,
    changes,
    close,
    releaseNotify,
    detachRoutes: () => detachRoutes(),
    holdNotify() {
      if (gate) throw new Error('Native notify gate already held')
      gate = new Promise<void>((resolve) => {
        release = resolve
      })
    },
    snapshot: () => ({
      remote,
      directory,
      removed,
      sessions: sessions.sessions(),
      received,
      consumed,
      brackets,
      changes,
      requests: model.requests,
      native: native.map(({ handle, argv, inputs, receipt }) => ({
        argv,
        inputs,
        receipt,
        failure: handle.failure?.message,
        rawBase64: handle.output.toString('base64'),
        sha256: createHash('sha256').update(handle.output).digest('hex'),
      })),
    }),
  }
}

export async function nativeUntil(predicate: () => boolean, description: string, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Native TUI deadline: ${description}`)
    await delay(20)
  }
}
