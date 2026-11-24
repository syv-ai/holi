import assert from 'node:assert/strict'
import { mkdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createMdxDiagnostics } from '../src/main/mdx-diagnostics'
import type { createMdxResources } from '../src/main/mdx-resources'
import type { createMdxTrustStore } from '../src/main/mdx-trust'
import type { createGuestProbes } from './mdx-compiler-guest-probes'

export function createNativeMdxScenarios({
  vault,
  remote,
  compiler,
  trustStore,
  inspect,
}: {
  vault: string
  remote: string
  compiler: ReturnType<typeof createMdxResources>
  trustStore: ReturnType<typeof createMdxTrustStore>
  inspect: ReturnType<typeof createMdxResources>['inspect']
}) {
  const file = join(vault, 'notes/fixture.mdx')
  let inspectedSources = 0
  const context = 'fixture-context-507'
  let accountGeneration = 1
  let openRevision = 1
  let identity = {
    accountGeneration,
    accountId: '507',
    remote,
    openRevision,
    active: {},
  }
  const owner = () => ({ accountId: identity.accountId, remote })
  let dependencyRaceChild: string | null = null
  let graphMutation: ((source: string) => Promise<void>) | null = null
  const diagnostics = createMdxDiagnostics({
    authorize: (candidate, requested) => requested === remote && candidate === identity,
    context: (token, requested) => (token === context && requested === remote ? identity : null),
    root: async (requested) => {
      if (requested !== remote) throw new Error('fixture vault unavailable')
      return vault
    },
    trusted: async (candidate) => candidate === identity && trustStore.status(owner()),
    createResourceOwner: compiler.createOwner,
    retireResourceOwner: compiler.retireOwner,
    async inspect(resourceOwner, source, signal, format) {
      inspectedSources += 1
      const result = await inspect(resourceOwner, source, signal, format)
      await graphMutation?.(source)
      if (source.includes('HOLI_NATIVE_DEPENDENCY_REPLACEMENT_RACE') && dependencyRaceChild) {
        await writeFile(dependencyRaceChild, '# changed after inspection\n')
        dependencyRaceChild = null
      }
      return result
    },
  })
  async function run(probes: Awaited<ReturnType<typeof createGuestProbes>>) {
    diagnostics.invalidate()
    const policy = await probes.policy(compiler)
    const recovery = await probes.crashAndHang(compiler)
    const stale: Array<{ name: string; rejected: string }> = []
    const heldChange = async (
      name: string,
      change: (lease: string) => void | Promise<void>,
      reuse = false,
    ) => {
      const { lease } = await diagnostics.acquire({ remote, path: 'notes/fixture.mdx', context })
      const ready = probes.hold()
      const result = diagnostics
        .compile({ lease, generation: 1, source: '# held native request\n' })
        .then(
          () => ({ ok: true, message: '' }),
          (error: Error) => ({ ok: false, message: error.message }),
        )
      await ready
      await change(lease)
      const outcome = await result
      assert.equal(outcome.ok, false, `${name} returned stale diagnostics`)
      stale.push({ name, rejected: outcome.message })
      if (reuse) {
        assert.deepEqual(
          await diagnostics.compile({ lease, generation: 2, source: '# current source\n' }),
          [],
        )
        diagnostics.release({ lease })
      } else {
        diagnostics.release({ lease })
        const fresh = await diagnostics.acquire({ remote, path: 'notes/fixture.mdx', context })
        assert.deepEqual(
          await diagnostics.compile({
            lease: fresh.lease,
            generation: 1,
            source: '# current owner\n',
          }),
          [],
        )
        diagnostics.release(fresh)
      }
    }
    const graphCases: Array<{ name: string; outcome: string }> = []
    const compileGraphCase = async (name: string, source: string) => {
      const lease = await diagnostics.acquire({ remote, path: 'notes/fixture.mdx', context })
      try {
        const result = await diagnostics.compile({ lease: lease.lease, generation: 1, source })
        graphCases.push({ name, outcome: result.length ? 'diagnostics' : 'clean' })
        return result
      } finally {
        diagnostics.release(lease)
      }
    }
    await mkdir(join(vault, 'notes/graph'), { recursive: true })
    await writeFile(join(vault, 'notes/graph/child.jsx'), 'export default <\n')
    const missing = await compileGraphCase(
      'missing dependency',
      "import Child from './graph/missing.jsx'\n<Child />",
    )
    assert(missing.length > 0)
    const syntaxChild = await compileGraphCase('syntax child', "import './graph/child.jsx'\n")
    assert(syntaxChild.length > 0)
    const cycleA = join(vault, 'notes/graph/a.jsx')
    const cycleB = join(vault, 'notes/graph/b.jsx')
    await writeFile(cycleA, "import './b.jsx'\nexport default 1\n")
    await writeFile(cycleB, "import './a.jsx'\nexport default 2\n")
    assert((await compileGraphCase('cycle', "import './graph/a.jsx'\n")).length > 0)
    for (const [name, path] of [
      ['protected dot-local', 'notes/graph/secret.local.jsx'],
      ['protected memory', '.holi/memory/secret.mdx'],
    ] as const) {
      let rejected = false
      try {
        await diagnostics.acquire({ remote, path, context })
      } catch {
        rejected = true
      }
      assert(rejected, `${name} path must be refused`)
      graphCases.push({ name, outcome: 'refused' })
    }
    for (const [name, source] of [
      ['external URL', "import 'https://example.invalid/x.jsx'"],
      ['dynamic import', "{import('./graph/child.jsx')}"],
      ['CommonJS', "{require('./graph/child.jsx')}"],
      ['unsupported formats', "import './graph/child.mjs'"],
      ['outward traversal', "import '../../../outside.jsx'"],
    ] as const) {
      assert((await compileGraphCase(name, source)).length > 0, `${name} must produce diagnostics`)
    }
    await mkdir(join(vault, '.holi/state'), { recursive: true })
    await writeFile(
      join(vault, '.holi/state/private.js'),
      "export const privateMarker = 'MACHINE_STATE_BYTES_MUST_NOT_BE_INSPECTED'\n",
    )
    assert(
      (
        await compileGraphCase(
          'protected machine state import',
          "import '../.holi/state/private.js'\n",
        )
      ).length > 0,
    )
    assert(
      (
        await compileGraphCase(
          'protected machine state case alias',
          "import '../.HOLI/STATE/private.js'\n",
        )
      ).length > 0,
    )
    await mkdir(join(vault, '.holi/memory'), { recursive: true })
    await writeFile(join(vault, '.holi/memory/secret.mdx'), 'do not inspect fixture content\n')
    assert(
      (await compileGraphCase('protected memory import', "import '../.holi/memory/secret.mdx'\n"))
        .length > 0,
    )
    assert(
      (
        await compileGraphCase(
          'protected memory case alias',
          "import '../.HOLI/memory/secret.mdx'\n",
        )
      ).length > 0,
    )
    await writeFile(
      join(vault, 'notes/graph/secret.local.jsx'),
      'throw new Error("must never evaluate")',
    )
    assert(
      (await compileGraphCase('protected dependency', "import './graph/secret.local.jsx'\n"))
        .length > 0,
    )
    await symlink(join(vault, 'notes/graph/secret.local.jsx'), join(vault, 'notes/graph/alias.jsx'))
    assert((await compileGraphCase('symlink alias', "import './graph/alias.jsx'\n")).length > 0)
    await writeFile(join(vault, 'notes/graph/large.jsx'), ' '.repeat(256 * 1024 + 1))
    assert((await compileGraphCase('file size limit', "import './graph/large.jsx'\n")).length > 0)
    const budgetFiles = Array.from({ length: 64 }, (_, index) => `budget${index}.js`)
    for (const name of budgetFiles)
      await writeFile(join(vault, 'notes/graph', name), 'export const value = 1\n')
    assert(
      (
        await compileGraphCase(
          'module count budget',
          "import './graph/budget0.js'\n" +
            budgetFiles
              .slice(1)
              .map((name) => `import './graph/${name}'`)
              .join('\n'),
        )
      ).length > 0,
    )
    const aggregateFiles = Array.from({ length: 6 }, (_, i) => `aggregate${i}.js`)
    for (const name of aggregateFiles)
      await writeFile(
        join(vault, 'notes/graph', name),
        '/*' + ' '.repeat(200 * 1024) + '*/\nexport const value = 1',
      )
    assert(
      (
        await compileGraphCase(
          'aggregate size budget',
          aggregateFiles.map((name) => `import './graph/${name}'`).join('\n'),
        )
      ).length > 0,
    )
    for (let index = 0; index < 18; index++) {
      await writeFile(
        join(vault, `notes/graph/depth${index}.js`),
        index === 17 ? 'export const leaf = 1' : `export * from './depth${index + 1}.js'`,
      )
    }
    assert((await compileGraphCase('graph depth limit', "import './graph/depth0.js'\n")).length > 0)
    await writeFile(
      join(vault, 'notes/graph/child.jsx'),
      "export const marker = 'HOLI_NATIVE_DEPENDENCY_REPLACEMENT_RACE'",
    )
    const raceLease = await diagnostics.acquire({ remote, path: 'notes/fixture.mdx', context })
    dependencyRaceChild = join(vault, 'notes/graph/child.jsx')
    let raceRejected = false
    try {
      await diagnostics.compile({
        lease: raceLease.lease,
        generation: 1,
        source: "import './graph/child.jsx'\n",
      })
    } catch {
      raceRejected = true
    } finally {
      dependencyRaceChild = null
      diagnostics.release(raceLease)
    }
    assert(raceRejected, 'dependency replacement during inspection must invalidate graph snapshot')
    graphCases.push({ name: 'dependency replacement race', outcome: 'refused' })
    assert.deepEqual(await compileGraphCase('fresh source after race', '# valid source\n'), [])
    const graphRace = async (
      name: string,
      source: string,
      mutate: () => Promise<void>,
      restore: () => Promise<void>,
    ) => {
      graphMutation = async (parsed) => {
        if (!parsed.includes('HOLI_GRAPH_RACE_CHILD')) return
        graphMutation = null
        await mutate()
      }
      let refused = false
      try {
        await compileGraphCase(name, source)
      } catch {
        refused = true
      } finally {
        graphMutation = null
        await restore()
      }
      assert(refused, `${name} must reject stale diagnostics`)
      graphCases.push({ name, outcome: 'refused' })
    }
    await writeFile(
      join(vault, 'notes/graph/race.js'),
      "export const value = 'HOLI_GRAPH_RACE_CHILD'",
    )
    const backupVault = `${vault}-graph-race-backup`
    await graphRace(
      'root replacement',
      "import './graph/race.js'\n",
      async () => {
        await rename(vault, backupVault)
        await mkdir(join(vault, 'notes'), { recursive: true })
        await writeFile(file, '# replacement root')
      },
      async () => {
        await rm(vault, { recursive: true, force: true })
        await rename(backupVault, vault)
      },
    )
    const graphDir = join(vault, 'notes/graph')
    const backupGraph = join(vault, 'notes/graph-backup')
    await graphRace(
      'ancestor replacement',
      "import './graph/race.js'\n",
      async () => {
        await rename(graphDir, backupGraph)
        await mkdir(graphDir)
      },
      async () => {
        await rm(graphDir, { recursive: true, force: true })
        await rename(backupGraph, graphDir)
      },
    )
    await writeFile(join(graphDir, 'shared.js'), 'export const shared = 1')
    await writeFile(join(graphDir, 'left.js'), "export * from './shared.js'")
    await writeFile(
      join(graphDir, 'right.js'),
      "export * from './shared.js'\nexport const marker = 'HOLI_GRAPH_RACE_CHILD'",
    )
    await graphRace(
      'diamond snapshot replacement',
      "import './graph/left.js'\nimport './graph/right.js'\n",
      async () => {
        await writeFile(join(graphDir, 'shared.js'), 'export const shared = 200')
      },
      async () => {},
    )
    await writeFile(join(graphDir, 'case.js'), 'export const value = 1')
    await writeFile(join(graphDir, 'CASE.js'), 'export const value = ;')
    const caseSensitive =
      (await stat(join(graphDir, 'case.js'))).ino !== (await stat(join(graphDir, 'CASE.js'))).ino
    if (caseSensitive) {
      assert(
        (
          await compileGraphCase(
            'case-distinct dependency paths',
            "import './graph/case.js'\nimport './graph/CASE.js'\n",
          )
        ).length > 0,
      )
    } else {
      await writeFile(join(graphDir, 'case.js'), 'export const value = 1')
      const canonicalCase = await import('node:fs/promises').then((fs) =>
        fs.realpath(join(graphDir, 'case.js')),
      )
      const alias = canonicalCase.endsWith('/case.js') ? 'CASE.js' : 'case.js'
      assert(
        (await compileGraphCase('case-insensitive alias rejected', `import './graph/${alias}'\n`))
          .length > 0,
      )
      graphCases.push({
        name: 'case-distinct files',
        outcome: 'inapplicable: case-insensitive filesystem',
      })
    }
    assert.deepEqual(
      await compileGraphCase('fresh source after graph races', '# source remains usable'),
      [],
    )
    const activeOwner = await diagnostics.acquire({ remote, path: 'notes/fixture.mdx', context })
    const activeReady = probes.hold()
    const activeResult = diagnostics
      .compile({ lease: activeOwner.lease, generation: 1, source: '# queued ownership owner\n' })
      .then(
        () => false,
        () => true,
      )
    await activeReady
    const queuedOwner = await diagnostics.acquire({ remote, path: 'notes/fixture.mdx', context })
    const inspectedCount = inspectedSources
    const queuedResult = diagnostics
      .compile({ lease: queuedOwner.lease, generation: 1, source: '# revoked while queued\n' })
      .then(
        () => false,
        () => true,
      )
    for (let attempt = 0; attempt < 100 && inspectedSources === inspectedCount; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    diagnostics.release({ lease: queuedOwner.lease })
    assert.equal(
      await queuedResult,
      true,
      'revoking a diagnostics owner must cancel its queued compile',
    )
    diagnostics.release({ lease: activeOwner.lease })
    assert.equal(
      await activeResult,
      true,
      'releasing the active diagnostics owner must cancel in-flight work',
    )
    stale.push({ name: 'queued ownership revocation and in-flight release', rejected: 'cancelled' })
    await heldChange(
      'source generation cancellation',
      (lease) => {
        diagnostics.cancel({ lease, generation: 2 })
      },
      true,
    )
    await heldChange('view release', (lease) => {
      diagnostics.release({ lease })
    })
    await heldChange('trust revoke and reapproval', async () => {
      diagnostics.invalidate()
      await trustStore.revoke(owner())
      await trustStore.approve(owner())
    })
    await heldChange('account A–B–A', () => {
      diagnostics.invalidate()
      identity = {
        ...identity,
        accountId: 'other',
        accountGeneration: ++accountGeneration,
        active: {},
      }
      diagnostics.invalidate()
      identity = {
        ...identity,
        accountId: '507',
        accountGeneration: ++accountGeneration,
        active: {},
      }
    })
    await heldChange('vault A–B–A', () => {
      diagnostics.invalidate()
      identity = { ...identity, remote: 'fixture/other', openRevision: ++openRevision, active: {} }
      diagnostics.invalidate()
      identity = { ...identity, remote, openRevision: ++openRevision, active: {} }
    })
    await heldChange('native filesystem replacement watcher', async () => {
      await writeFile(`${file}.replacement`, '# atomically replaced source\n')
      await rename(`${file}.replacement`, file)
    })
    probes.assertHealthy()
    return { policy, recovery, stale, graphCases }
  }
  return {
    run,
    status: () => ({ accountGeneration, openRevision }),
    close: () => diagnostics.close(),
  }
}
