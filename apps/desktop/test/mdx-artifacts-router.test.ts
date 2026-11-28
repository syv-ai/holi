import { mkdir, rename, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'acorn'
import { expect, it } from 'vitest'
import { gate, REMOTE, resourceRig } from './fixtures/mdx-router'

type Rig = Awaited<ReturnType<typeof resourceRig>>

async function publish(rig: Rig, source = '# Artifact', generation = 1, owner?: { lease: string }) {
  const lease = owner ?? (await rig.acquire())
  const result = await rig.mdx.compileModules({ ...lease, generation, source })
  expect(result.diagnostics).toEqual([])
  expect(result.artifact).toBeDefined()
  expect(result.artifact!.generation).toBe(generation)
  return { ...lease, ...result.artifact! }
}

it('returns a complete inert browser ESM graph with local and host-runtime import targets', async () => {
  const rig = await resourceRig()
  await writeFile(join(rig.root, 'labels.js'), "export const label = 'ready'\n")
  await writeFile(join(rig.root, 'index.js'), "export { label } from './labels.js'\n")
  await writeFile(
    join(rig.root, 'card.jsx'),
    [
      "import React from 'react'",
      "import { label } from './index.js'",
      'export const Card = ({children}) => <React.Fragment><section aria-label={label}>{children}</section></React.Fragment>',
    ].join('\n'),
  )
  await writeFile(join(rig.root, 'child.mdx'), '# Nested MDX\n\n{1 + 2}\n')
  const source = [
    "import { Card } from './card.jsx'",
    "import Child from './child.mdx'",
    "export { label } from './index.js'",
    'export const probe = (() => { globalThis.__holi_artifact_source_executed__ = true; return 1 })()',
    '',
    '# Subject',
    '',
    '<Card><Child /></Card>',
  ].join('\n')
  expect(globalThis).not.toHaveProperty('__holi_artifact_source_executed__')
  const published = await publish(rig, source)
  const graph = await rig.mdx.acquireArtifact(published)
  expect(graph).toMatchObject({ id: published.id, generation: 1, entry: 'page.mdx' })
  expect(graph.modules.map(({ path }) => path).sort()).toEqual([
    'card.jsx',
    'child.mdx',
    'index.js',
    'labels.js',
    'page.mdx',
  ])
  for (const module of graph.modules)
    expect(() => parse(module.code, { sourceType: 'module', ecmaVersion: 'latest' })).not.toThrow()
  expect(graph.modules.find(({ path }) => path === 'page.mdx')!.imports).toMatchObject({
    './card.jsx': { path: 'card.jsx' },
    './child.mdx': { path: 'child.mdx' },
    'react/jsx-runtime': { runtime: 'react/jsx-runtime' },
  })
  expect(graph.modules.find(({ path }) => path === 'card.jsx')!.imports).toMatchObject({
    './index.js': { path: 'index.js' },
    react: { runtime: 'react' },
    'react/jsx-runtime': { runtime: 'react/jsx-runtime' },
  })
  expect(globalThis).not.toHaveProperty('__holi_artifact_source_executed__')
  graph.modules.length = 0
  expect((await rig.mdx.acquireArtifact(published)).modules).toHaveLength(5)
  expect(
    await rig.mdx.compile({ ...published, generation: 2, source: '# Diagnostics only' }),
  ).toEqual([])
  const ordinary = await rig.mdx.compile({
    ...published,
    generation: 3,
    source: "import React from 'react'\n\n# Ordinary inspection policy",
  })
  expect(ordinary.length).toBeGreaterThan(0)
  await expect(rig.mdx.acquireArtifact(published)).rejects.toThrow()
})

it('does not fetch executable external imports or offer executable consent, even with a saved data grant', async () => {
  const rig = await resourceRig()
  const owner = await rig.acquire()
  const url = 'https://one.example/module.js'
  const source = `import '${url}'\n`
  rig.routes.set(url, { text: 'export const value = 1' })
  await rig.mdx.compile({ ...owner, generation: 1, source })
  const pending = (await rig.mdx.externalResources(owner)).pending
  expect(pending).toHaveLength(1)
  await rig.mdx.approveExternalResource({ ...owner, requestId: pending[0]!.id })
  expect((await rig.mdx.externalResources(owner)).approved).toHaveLength(1)
  const result = await rig.mdx.compileModules({ ...owner, generation: 2, source })
  expect(result.diagnostics.length).toBeGreaterThan(0)
  expect(result.artifact).toBeUndefined()
  expect(rig.contacts).toEqual([])
  expect((await rig.mdx.externalResources(owner)).pending).toEqual([])
})

it.each([
  'missing',
  'unsupported',
  'bare package',
  'dynamic import',
  'commonjs',
  'protected',
  'symlink',
  'cycle',
  'module limit',
  'depth limit',
  'aggregate source limit',
  'emitted code limit',
  'private syntax error',
])('publishes no partial graph for %s', async (kind) => {
  const rig = await resourceRig()
  const marker = 'PRIVATE_ARTIFACT_INPUT_MUST_NOT_APPEAR_IN_DIAGNOSTICS'
  let source = "import './missing.js'\n"
  if (kind === 'unsupported') source = "import './data.json'\n"
  if (kind === 'bare package') source = "import 'node:fs'\n"
  if (kind === 'dynamic import') source = "{import('./part.js')}\n"
  if (kind === 'commonjs') source = "{require('./part.js')}\n"
  if (kind === 'protected') {
    await mkdir(join(rig.root, '.holi', 'state'), { recursive: true })
    await writeFile(
      join(rig.root, '.holi', 'state', 'private.js'),
      `export const secret = '${marker}'`,
    )
    source = "import './.HOLI/state/private.js'\n"
  }
  if (kind === 'symlink') {
    await writeFile(join(rig.root, 'private.local.js'), `export const secret = '${marker}'`)
    await symlink(join(rig.root, 'private.local.js'), join(rig.root, 'part.js'))
    source = "import './part.js'\n"
  }
  if (kind === 'cycle') {
    await writeFile(join(rig.root, 'a.js'), "export * from './b.js'")
    await writeFile(join(rig.root, 'b.js'), "export * from './a.js'")
    source = "import './a.js'\n"
  }
  if (
    kind === 'module limit' ||
    kind === 'aggregate source limit' ||
    kind === 'emitted code limit'
  ) {
    const count = kind === 'module limit' ? 64 : kind === 'aggregate source limit' ? 6 : 4
    const body =
      kind === 'aggregate source limit'
        ? `/*${' '.repeat(200 * 1024)}*/\nexport const x = 1`
        : kind === 'emitted code limit'
          ? `export default () => <>${'<i>a</i>'.repeat(15000)}</>`
          : 'export const x = 1'
    const extension = kind === 'emitted code limit' ? 'jsx' : 'js'
    for (let index = 0; index < count; index++)
      await writeFile(join(rig.root, `part${index}.${extension}`), body)
    source =
      Array.from({ length: count }, (_, index) => `import './part${index}.${extension}'`).join(
        '\n',
      ) + '\n'
  }
  if (kind === 'depth limit') {
    for (let index = 0; index < 18; index++)
      await writeFile(
        join(rig.root, `part${index}.js`),
        index === 17 ? 'export const x = 1' : `export * from './part${index + 1}.js'`,
      )
    source = "import './part0.js'\n"
  }
  if (kind === 'private syntax error') {
    await writeFile(join(rig.root, 'part.js'), `export const secret = /${marker}[z-a]/`)
    source = "import './part.js'\n"
  }
  const owner = await rig.acquire()
  const result = await rig.mdx.compileModules({ ...owner, generation: 1, source })
  expect(result.diagnostics.length).toBeGreaterThan(0)
  expect(result.artifact).toBeUndefined()
  expect(JSON.stringify(result)).not.toContain(marker)
})

it('rejects forged ownership, generation, IDs, and oversized UTF-8 input', async () => {
  const rig = await resourceRig()
  const published = await publish(rig)
  const other = await rig.acquire()
  for (const request of [
    { ...published, ...other },
    { ...published, generation: 2 },
    { ...published, id: '0'.repeat(64) },
    { ...published, id: '../other' },
    { ...published, generation: -1 },
  ])
    await expect(rig.mdx.acquireArtifact(request)).rejects.toThrow()
  await expect(
    rig.mdx.compileModules({ ...published, generation: 2, source: '🪿'.repeat(70000) }),
  ).rejects.toThrow()
})

it.each([
  'same generation',
  'new generation',
  'failed replacement',
  'cancel',
  'release',
  'trust',
  'account',
  'document',
  'vault',
])('retires publication after %s changes', async (change) => {
  const rig = await resourceRig()
  const published = await publish(rig)
  if (change === 'same generation' || change === 'new generation')
    await publish(rig, '# Replacement', change === 'same generation' ? 1 : 2, published)
  if (change === 'failed replacement') {
    const result = await rig.mdx.compileModules({
      ...published,
      generation: 2,
      source: "import './missing.js'\n",
    })
    expect(result.artifact).toBeUndefined()
  }
  if (change === 'cancel') await rig.mdx.cancelCompile({ ...published, generation: 1 })
  if (change === 'release') await rig.mdx.releaseDiagnosticsLease(published)
  if (change === 'trust') {
    const status = await rig.mdx.status({ remote: REMOTE })
    await rig.mdx.revoke({ remote: REMOTE, context: status.context! })
  }
  if (change === 'account') await rig.session.signOut()
  if (change === 'document') rig.retireDocument()
  if (change === 'vault') {
    await rig.registry.add({
      remote: 'syv-ai/other',
      path: rig.root,
      name: 'other',
      lastOpenedAt: '2026-01-01',
    })
    await rig.caller.vaults.open({ remote: 'syv-ai/other' })
    await rig.caller.vaults.open({ remote: REMOTE })
  }
  await expect(rig.mdx.acquireArtifact(published)).rejects.toThrow()
})

it.each(['content', 'symlink replacement', 'public path write'])(
  'refuses acquisition after dependency %s',
  async (change) => {
    const rig = await resourceRig()
    const path = join(rig.root, 'part.js')
    await writeFile(path, 'export const value = 1')
    const published = await publish(rig, "import './part.js'\n")
    if (change === 'content') await writeFile(path, 'export const value = 200')
    if (change === 'symlink replacement') {
      await rename(path, join(rig.root, 'moved.js'))
      await symlink(join(rig.root, 'moved.js'), path)
    }
    if (change === 'public path write')
      await rig.caller.files.write({
        remote: REMOTE,
        path: 'part.js',
        bytes: new TextEncoder().encode('export const value = 2'),
      })
    await expect(rig.mdx.acquireArtifact(published)).rejects.toThrow()
  },
)

it('does not publish superseded in-flight work even when a generation number is reused', async () => {
  const entered = gate()
  const resume = gate()
  let first = true
  const rig = await resourceRig(false, {
    holdInspection: async (signal) => {
      if (!first) return
      first = false
      entered.resolve()
      await resume.promise
      signal.throwIfAborted()
    },
  })
  const owner = await rig.acquire()
  const pending = rig.mdx.compileModules({ ...owner, generation: 1, source: '# Superseded' })
  const rejected = expect(pending).rejects.toThrow()
  try {
    await entered.promise
    const current = await publish(rig, '# Current', 1, owner)
    resume.resolve()
    await rejected
    expect(await rig.mdx.acquireArtifact(current)).toMatchObject({ id: current.id, generation: 1 })
  } finally {
    resume.resolve()
  }
})

it('preserves diagnostics-only inspection while an unrelated path is saved', async () => {
  const entered = gate()
  const resume = gate()
  const rig = await resourceRig(false, {
    holdInspection: async (signal) => {
      entered.resolve()
      await resume.promise
      signal.throwIfAborted()
    },
  })
  const owner = await rig.acquire()
  const pending = rig.mdx.compile({ ...owner, generation: 1, source: '# Unchanged source' })
  const completed = expect(pending).resolves.toEqual([])
  try {
    await entered.promise
    await rig.caller.files.write({
      remote: REMOTE,
      path: 'unrelated.js',
      bytes: new TextEncoder().encode('export const x = 1'),
    })
  } finally {
    resume.resolve()
  }
  await completed
})
