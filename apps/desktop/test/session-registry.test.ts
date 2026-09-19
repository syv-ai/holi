import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSessionRegistry, SESSIONS_DIR } from '../src/main/agent/session-registry'

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'holi-session-registry-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const VAULT_ROOT = '/Users/ada/Holi/syv/vault'

/** What `claude agents --json` prints, as it prints it. */
function listing(rows: unknown[]): string {
  return JSON.stringify(rows, null, 2) + '\n'
}

const ROW = {
  pid: 4242,
  cwd: VAULT_ROOT,
  kind: 'interactive',
  startedAt: 1789848338870,
  sessionId: '0ed06be6-aba7-4553-ba1b-caab3adccf85',
  name: 'Fix the broken CSV import',
  nameSource: 'user',
  status: 'busy',
}

/** A registry whose only outside contact is the injected runner. */
function registryWith(
  run: (bin: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>,
) {
  return createSessionRegistry({ resolveBin: () => '/usr/local/bin/claude', run })
}

describe('readRows', () => {
  it('keys the vault’s rows by pid', async () => {
    const registry = registryWith(async () => listing([ROW]))

    const rows = await registry.readRows({ configDir: '/cfg', vaultRoot: VAULT_ROOT })

    expect([...rows.keys()]).toEqual([4242])
    expect(rows.get(4242)).toEqual({
      pid: 4242,
      name: 'Fix the broken CSV import',
      nameSource: 'user',
      status: 'busy',
      waitingFor: undefined,
    })
  })

  it('parses a row with no nameSource, which is every row the command prints', async () => {
    // Verified against 2.1.278: the file under `sessions/` carries `nameSource`,
    // the supported command does not. A caller cannot read a chosen name apart
    // from the cwd placeholder here, and must know it from the spawn instead.
    const { nameSource: _dropped, ...withoutSource } = ROW
    const registry = registryWith(async () => listing([withoutSource]))

    const rows = await registry.readRows({ configDir: '/cfg', vaultRoot: VAULT_ROOT })

    expect(rows.get(4242)?.name).toBe('Fix the broken CSV import')
    expect(rows.get(4242)?.nameSource).toBeUndefined()
  })

  it('carries waitingFor, which is the whole of the needs-you signal', async () => {
    const registry = registryWith(async () =>
      listing([{ ...ROW, status: 'waiting', waitingFor: 'permission prompt' }]),
    )

    const rows = await registry.readRows({ configDir: '/cfg', vaultRoot: VAULT_ROOT })

    expect(rows.get(4242)?.status).toBe('waiting')
    expect(rows.get(4242)?.waitingFor).toBe('permission prompt')
  })

  it('drops a row from another directory', async () => {
    // The config directory is per vault (D86), so this should not happen — but a
    // row Holi acted on for the wrong tree is the D87 mistake, and the cheap
    // guard is the one that makes it impossible rather than unlikely.
    const registry = registryWith(async () =>
      listing([ROW, { ...ROW, pid: 99, cwd: '/somewhere/else' }]),
    )

    const rows = await registry.readRows({ configDir: '/cfg', vaultRoot: VAULT_ROOT })

    expect([...rows.keys()]).toEqual([4242])
  })

  it('drops a row that is missing the fields it is read for', async () => {
    const registry = registryWith(async () =>
      listing([{ cwd: VAULT_ROOT, status: 'busy' }, { ...ROW, status: 'nonsense' }, ROW]),
    )

    const rows = await registry.readRows({ configDir: '/cfg', vaultRoot: VAULT_ROOT })

    expect([...rows.keys()]).toEqual([4242])
  })

  it('runs the documented command, with the vault’s config directory', async () => {
    const calls: { bin: string; args: string[]; env: NodeJS.ProcessEnv }[] = []
    const registry = registryWith(async (bin, args, env) => {
      calls.push({ bin, args, env })
      return listing([])
    })

    await registry.readRows({ configDir: '/cfg/vault-a', vaultRoot: VAULT_ROOT })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.bin).toBe('/usr/local/bin/claude')
    expect(calls[0]!.args).toEqual(['agents', '--json'])
    expect(calls[0]!.env.CLAUDE_CONFIG_DIR).toBe('/cfg/vault-a')
    // Inherited, or the child cannot find node, the keychain or the user's PATH.
    expect(calls[0]!.env.PATH).toBe(process.env.PATH)
  })

  it('answers empty when the command fails, prints nonsense, or is missing', async () => {
    const thrown = registryWith(async () => {
      throw new Error('spawn ENOENT')
    })
    const garbage = registryWith(async () => 'not json at all')
    const notAnArray = registryWith(async () => '{"sessions":[]}')
    const noBin = createSessionRegistry({
      resolveBin: () => null,
      run: async () => {
        throw new Error('must not run')
      },
    })

    for (const registry of [thrown, garbage, notAnArray, noBin]) {
      await expect(
        registry.readRows({ configDir: '/cfg', vaultRoot: VAULT_ROOT }),
      ).resolves.toEqual(new Map())
    }
  })
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Polled, not slept: the condition is true the moment it is true, and the
 *  timeout only bounds the failure. The convention is active-vault.test.ts's. */
async function waitFor(what: string, predicate: () => boolean, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`)
    await sleep(25)
  }
}

/** See vault-watcher.test.ts: macOS replays FSEvents from just before a watcher
 *  became ready, so a fixture has to quiesce before it is watched. */
const QUIESCE = 150

describe('watch', () => {
  it('fires once for a burst of writes, and stops when unsubscribed', async () => {
    const configDir = await tempDir()
    const sessions = join(configDir, SESSIONS_DIR)
    await mkdir(sessions, { recursive: true })
    await sleep(QUIESCE)
    const registry = registryWith(async () => listing([]))

    let fired = 0
    const stop = registry.watch(configDir, () => {
      fired += 1
    })

    await writeFile(join(sessions, '1.json'), '{}')
    await writeFile(join(sessions, '2.json'), '{}')
    await waitFor('the debounced edge', () => fired > 0)
    // Long enough that a second, undebounced call would have landed.
    await sleep(QUIESCE * 3)
    expect(fired).toBe(1)

    stop()
    await writeFile(join(sessions, '3.json'), '{}')
    await sleep(QUIESCE * 3)
    expect(fired).toBe(1)
  })

  it('survives a config directory that has never run an agent', async () => {
    const configDir = await tempDir() // no sessions/ in it
    const registry = registryWith(async () => listing([]))

    const stop = registry.watch(configDir, () => {})

    expect(stop).toBeTypeOf('function')
    expect(() => stop()).not.toThrow()
  })

  it('keeps trying until Claude Code creates sessions/, then reports it', async () => {
    // The directory that matters most is the one that does not exist yet: Holi
    // deliberately does not create it, and Claude Code makes it about a second
    // into the first spawn. A watch attempted once, at the spawn, is attempted
    // at exactly the moment it cannot take — and never again.
    const configDir = await tempDir()
    const registry = registryWith(async () => listing([]))

    let fired = 0
    const stop = registry.watch(configDir, () => {
      fired += 1
    })
    await sleep(QUIESCE)
    expect(fired).toBe(0)

    await mkdir(join(configDir, SESSIONS_DIR), { recursive: true })
    // The directory appearing is itself the news: the rows it now holds are
    // ones nothing has read.
    await waitFor('the retried watch to take', () => fired > 0)

    await sleep(QUIESCE)
    await writeFile(join(configDir, SESSIONS_DIR, '1.json'), '{}')
    await waitFor('an edge from the watcher that finally attached', () => fired > 1)

    stop()
  })

  it('stops retrying when unsubscribed before the directory ever appears', async () => {
    const configDir = await tempDir()
    const registry = registryWith(async () => listing([]))

    let fired = 0
    const stop = registry.watch(configDir, () => {
      fired += 1
    })
    stop()

    await mkdir(join(configDir, SESSIONS_DIR), { recursive: true })
    await sleep(QUIESCE * 6) // several retry intervals
    expect(fired).toBe(0)
  })
})
