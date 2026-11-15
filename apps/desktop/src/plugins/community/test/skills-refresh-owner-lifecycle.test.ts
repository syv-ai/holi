import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pluginPinPath, type PluginManifest, type PluginPin } from '@holi/shared'
import type { CapabilityTable, CapabilityContext, PluginCtx } from '../../../main/plugin-api'
import { communityMain } from '../main'
import { communityOwner } from '../main/owner'
import { skillTransactionFs } from '../main/skill-transaction'
import type { Install } from '../main/store'

const roots: string[] = []
const disposals: (() => Promise<void>)[] = []
const waitFor = async (predicate: () => boolean, message: string) => {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose().catch(() => undefined)))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const manifest: PluginManifest = {
  id: 'demo',
  name: 'Demo',
  version: '1.0.0',
  opens: [],
  skills: ['skills/demo'],
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'holi-522-owner-')))
  roots.push(root)
  const userData = join(root, 'user')
  const owner = communityOwner({ userData })
  const releasePath = join(userData, 'plugins/demo/release')
  const vaults = ['a', 'b'].map((name) => ({
    root: join(root, `vault-${name}`),
    remote: `owner/vault-${name}`,
  }))
  for (const vault of vaults) {
    await mkdir(join(vault.root, '.holi/plugins/demo'), { recursive: true })
    await mkdir(join(vault.root, '.holi/settings'), { recursive: true })
    await writeFile(
      join(vault.root, '.holi/settings/plugins.yaml'),
      'plugins:\n  community: true\n  demo: true\n',
    )
    await writeFile(
      join(vault.root, pluginPinPath('demo')),
      JSON.stringify({
        ...manifest,
        repo: 'owner/demo',
        path: '',
        commit: '0'.repeat(40),
      } satisfies PluginPin),
    )
  }
  const skill = join(releasePath, 'skills/demo')
  await mkdir(skill, { recursive: true })
  await writeFile(join(skill, 'SKILL.md'), 'pinned skill\n')
  await writeFile(join(releasePath, 'holi-plugin.json'), JSON.stringify(manifest))
  const { execFileSync } = await import('node:child_process')
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: releasePath, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('add', '.')
  git('-c', 'user.name=Ada', '-c', 'user.email=ada@example.test', 'commit', '-qm', 'release')
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: releasePath,
    encoding: 'utf8',
  }).trim()
  const installedPath = join(userData, 'plugins/demo', commit)
  await rename(releasePath, installedPath)
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/demo.git'], {
    cwd: installedPath,
  })
  const install: Install = {
    id: 'demo',
    source: { kind: 'release', repo: 'owner/demo', path: '', tag: 'v1.0.0', commit },
    manifest,
    setup: 'ok',
  }
  await owner.store.put(install)
  await owner.consent.grant('demo', commit)
  for (const vault of vaults) {
    await writeFile(
      join(vault.root, pluginPinPath('demo')),
      JSON.stringify({
        ...manifest,
        repo: 'owner/demo',
        path: '',
        commit,
      } satisfies PluginPin),
    )
  }

  const activations: {
    root: string
    remote: string
    table: CapabilityTable
    dispose: () => Promise<void>
  }[] = []
  const attachmentSignals: AbortSignal[] = []
  const attach = owner.attach.bind(owner)
  owner.attach = (...args) => {
    const attachment = attach(...args)
    attachmentSignals.push(attachment.signal)
    return attachment
  }
  let commandEvents = 0
  for (const vault of vaults) {
    let table!: CapabilityTable
    const dispose = await communityMain.activate!({
      userData,
      root: vault.root,
      remote: vault.remote,
      githubToken: null,
      register: (_namespaces: readonly string[], registered: CapabilityTable) => {
        table = registered
        return () => {}
      },
      emit: (_remote: string, name: string) => {
        if (name === 'commands') commandEvents++
      },
      frameOrigin: () => () => {},
      onSnapshot: () => () => {},
    } as unknown as PluginCtx)
    const close = async () => {
      await dispose?.()
    }
    disposals.push(close)
    activations.push({ root: vault.root, remote: vault.remote, table, dispose: close })
  }
  const call = (activation: (typeof activations)[number]) => {
    const capability = activation.table['community.refresh-skills'] as unknown as {
      params(raw: unknown): unknown
      run(ctx: CapabilityContext, params: unknown): Promise<string[]>
    }
    return capability.run(
      { root: activation.root, remote: activation.remote } as CapabilityContext,
      capability.params({ id: 'demo', force: true }),
    )
  }
  owner.attach = attach
  return {
    root,
    owner,
    vaults,
    activations,
    attachmentSignals,
    call,
    remove: (activation: (typeof activations)[number]) => {
      const capability = activation.table['community.remove'] as unknown as {
        params(raw: unknown): unknown
        run(ctx: CapabilityContext, params: unknown): Promise<unknown>
      }
      return capability.run(
        { root: activation.root, remote: activation.remote } as CapabilityContext,
        capability.params({ id: 'demo' }),
      )
    },
    commandEvents: () => commandEvents,
  }
}

describe('community refresh through real owner attachments', () => {
  it('drains a closed vault at pre-publication, rolls back, and refreshes the other vault', async () => {
    const f = await fixture()
    const [a, b] = f.activations
    const destination = join(a!.root, '.claude/skills/demo')
    await mkdir(destination, { recursive: true })
    await writeFile(join(destination, 'SKILL.md'), 'old A\n')
    let entered!: () => void
    let release!: () => void
    const atPublication = new Promise<void>((resolve) => {
      entered = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const originalRename = skillTransactionFs.rename
    let hold = true
    skillTransactionFs.rename = async (from, to) => {
      if (hold && String(to).endsWith('.original')) {
        hold = false
        entered()
        await blocked
      }
      return originalRename(from, to)
    }
    try {
      const refreshA = f.call(a!)
      await atPublication
      const staleQueuedA = f.call(a!)
      const staleQueuedAssertion = expect(staleQueuedA).rejects.toThrow(/attachment is closed/)
      const closeA = a!.dispose()
      expect(f.attachmentSignals[0]!.aborted).toBe(true)
      expect((await f.owner.store.get('demo'))?.id).toBe('demo')
      expect(await readFile(join(destination, 'SKILL.md'), 'utf8')).toBe('old A\n')
      let drained = false
      void closeA.then(() => {
        drained = true
      })
      await new Promise((resolve) => setTimeout(resolve, 15))
      expect(drained).toBe(false)
      release()
      await expect(refreshA).rejects.toThrow(/attachment is closed/)
      await staleQueuedAssertion
      await closeA
      expect(await readFile(join(destination, 'SKILL.md'), 'utf8')).toBe('old A\n')
      await expect(f.call(b!)).resolves.toEqual(['.claude/skills/demo'])
      expect(await readFile(join(b!.root, '.claude/skills/demo/SKILL.md'), 'utf8')).toBe(
        'pinned skill\n',
      )
    } finally {
      release()
      skillTransactionFs.rename = originalRename
      await Promise.all(f.activations.map(({ dispose }) => dispose()))
    }
  })

  it.skipIf(process.platform === 'win32')(
    'drains a closed owner promptly when a checkout manifest is a FIFO',
    async () => {
      const f = await fixture()
      const [activation] = f.activations
      const manifestPath = join(
        f.owner.store.codeDir((await f.owner.store.get('demo'))!),
        'holi-plugin.json',
      )
      await rm(manifestPath)
      const { execFileSync } = await import('node:child_process')
      execFileSync(['mk', 'fifo'].join(''), [manifestPath])
      const pending = f.call(activation!)
      const outcome = pending.then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      )
      await new Promise((resolve) => setTimeout(resolve, 50))
      await activation!.dispose()
      await expect(
        Promise.race([
          outcome,
          new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2_000)),
        ]),
      ).resolves.not.toBe('timeout')
    },
  )

  it('serializes removal behind a refresh admitted by the other vault', async () => {
    const f = await fixture()
    const [a, b] = f.activations
    const destination = join(a!.root, '.claude/skills/demo')
    let entered!: () => void
    let release!: () => void
    const atPublication = new Promise<void>((resolve) => {
      entered = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const originalRename = skillTransactionFs.rename
    let hold = true
    skillTransactionFs.rename = async (from, to) => {
      if (hold && String(to) === destination) {
        hold = false
        entered()
        await blocked
      }
      return originalRename(from, to)
    }
    try {
      const refreshA = f.call(a!)
      await atPublication
      let removed = false
      const removeB = f.remove(b!).then(() => {
        removed = true
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(removed).toBe(false)
      expect(await f.owner.store.get('demo')).not.toBeNull()
      release()
      await expect(refreshA).resolves.toEqual(['.claude/skills/demo'])
      await removeB
      expect(await f.owner.store.get('demo')).toBeNull()
      expect(await readFile(join(destination, 'SKILL.md'), 'utf8')).toBe('pinned skill\n')
    } finally {
      release()
      skillTransactionFs.rename = originalRename
      await Promise.all(f.activations.map(({ dispose }) => dispose()))
    }
  })

  it('uses owner admission without triggering mutation observers', async () => {
    const f = await fixture()
    const [a] = f.activations
    await waitFor(() => f.commandEvents() >= 2, 'both initial owner refreshes did not finish')
    const initial = f.commandEvents()
    await expect(f.call(a!)).resolves.toEqual(['.claude/skills/demo'])
    expect(f.commandEvents()).toBe(initial)
    await f.owner.mutate(async () => undefined)
    expect(f.commandEvents()).toBeGreaterThan(initial)
    await Promise.all(f.activations.map(({ dispose }) => dispose()))
  })
})
