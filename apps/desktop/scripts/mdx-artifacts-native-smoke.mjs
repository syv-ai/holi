import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'acorn'
import { createMdxSmokeClient } from './mdx-native-smoke-client.mjs'

/** Exercise inert artifact acquisition through the real packaged application IPC. */
export async function runArtifactNativeAcceptance(page, { vault, checks, ui }) {
  const { call, wire, rpc, refuse } = createMdxSmokeClient(page)
  const remote = 'fixture/isolated-mdx'
  const path = 'notes/fixture.mdx'
  const unavailable = /unavailable|cancel|supersed/i
  let status = await call('status', { remote }, 'query')
  assert(status.context)
  await refuse(
    rpc(wire('acquireDiagnosticsLease', { remote, path, context: status.context })),
    'Untrusted vault admitted an artifact owner',
    unavailable,
  )
  await call('approve', { remote, context: status.context })
  const acquire = async () => {
    status = await call('status', { remote }, 'query')
    return call('acquireDiagnosticsLease', { remote, path, context: status.context })
  }
  let owner = await acquire()
  await writeFile(join(vault, 'artifact-label.js'), 'export const label = "local"')
  await writeFile(join(vault, 'artifact-index.js'), "export { label } from './artifact-label.js'")
  await writeFile(
    join(vault, 'artifact-card.jsx'),
    [
      "import React from 'react'",
      "import { label } from './artifact-index.js'",
      'export const Card = () => <React.Fragment><span>{label}</span></React.Fragment>',
    ].join('\n'),
  )
  await writeFile(join(vault, 'artifact-child.mdx'), '# Child\n\n{1 + 2}\n')
  const source = [
    "import { Card } from '../artifact-card.jsx'",
    "import Child from '../artifact-child.mdx'",
    'export const probe = (() => { globalThis.__holi_artifact_source_executed__ = true; return 1 })()',
    '',
    '# Local graph',
    '',
    '<Card /><Child />',
  ].join('\n')
  const publish = async (generation, text = source) => {
    const result = await call('compileModules', { ...owner, generation, source: text })
    assert.deepEqual(result.diagnostics, [])
    assert(result.artifact, 'Successful compilation did not publish an artifact')
    return { ...owner, ...result.artifact }
  }
  let published = await publish(1)
  const graph = await call('acquireArtifact', published, 'query')
  assert.equal(graph.entry, path)
  assert.deepEqual(graph.modules.map((module) => module.path).sort(), [
    'artifact-card.jsx',
    'artifact-child.mdx',
    'artifact-index.js',
    'artifact-label.js',
    path,
  ])
  for (const module of graph.modules)
    parse(module.code, { sourceType: 'module', ecmaVersion: 'latest' })
  assert.deepEqual(graph.modules.find((module) => module.path === 'artifact-card.jsx').imports, {
    react: { runtime: 'react' },
    './artifact-index.js': { path: 'artifact-index.js' },
    'react/jsx-runtime': { runtime: 'react/jsx-runtime' },
  })
  checks.push('packaged authenticated IPC returns a complete inert MDX/JSX/JS browser ESM graph')
  const foreign = await page.evaluate(
    `window.holiSmoke.call('smoke:other-document', ${JSON.stringify(wire('acquireArtifact', published, 'query'))})`,
  )
  assert.equal(foreign.ok, false, 'Another WebContents acquired an artifact')
  const foreignCompile = await page.evaluate(
    `window.holiSmoke.call('smoke:other-document', ${JSON.stringify(wire('compileModules', { ...owner, generation: 2, source: '# Forged document' }))})`,
  )
  assert.equal(foreignCompile.ok, false, 'Another WebContents started compilation')
  const other = await acquire()
  await refuse(
    rpc(wire('acquireArtifact', { ...published, ...other }, 'query')),
    'Another lease acquired an artifact',
    unavailable,
  )
  await call('releaseDiagnosticsLease', other)
  await refuse(
    rpc(wire('acquireArtifact', { ...published, generation: 2 }, 'query')),
    'Wrong generation acquired an artifact',
    unavailable,
  )
  await refuse(
    rpc(wire('acquireArtifact', { ...published, id: '0'.repeat(64) }, 'query')),
    'Forged artifact ID was accepted',
    unavailable,
  )
  checks.push('real foreign WebContents, foreign lease, forged ID and wrong generation are denied')

  await writeFile(join(vault, 'artifact-label.js'), 'export const label = "changed"')
  await refuse(
    rpc(wire('acquireArtifact', published, 'query')),
    'Changed dependency snapshot survived acquisition',
    unavailable,
  )
  published = await publish(2)
  const written = await page.evaluate(
    `window.holi.trpc({type:'mutation',path:'files.write',input:{remote:${JSON.stringify(remote)},path:'artifact-label.js',bytes:new TextEncoder().encode('export const label = "saved"')}})`,
  )
  assert(written.ok, 'Production file mutation failed')
  await refuse(
    rpc(wire('acquireArtifact', published, 'query')),
    'Dependency path invalidation retained its artifact',
    unavailable,
  )
  checks.push('native dependency replacement and production path mutation retire published graphs')
  owner = await acquire()
  const old = await publish(1)
  published = await publish(1)
  await refuse(
    rpc(wire('acquireArtifact', old, 'query')),
    'Same-generation replacement retained its old ID',
    unavailable,
  )
  await call('cancelCompile', { ...owner, generation: 1 })
  await refuse(
    rpc(wire('acquireArtifact', published, 'query')),
    'Cancelled source retained its artifact',
    unavailable,
  )
  checks.push('same-generation source replacement and cancellation retire old artifact IDs')

  const external = await call('compileModules', {
    ...owner,
    generation: 2,
    source: "import 'https://example.invalid/executable.js'\n",
  })
  assert(external.diagnostics.length > 0)
  assert.equal(external.artifact, undefined)
  assert.deepEqual((await call('externalResources', owner, 'query')).pending, [])
  const missing = await call('compileModules', {
    ...owner,
    generation: 3,
    source: "import './missing.js'\n",
  })
  assert(missing.diagnostics.length > 0)
  assert.equal(missing.artifact, undefined)
  checks.push(
    'executable external imports and incomplete local graphs publish no artifact or executable consent',
  )

  const held = page.evaluate("window.holiSmoke.call('smoke:hold-compiler')")
  const pending = rpc(
    wire('compileModules', { ...owner, generation: 4, source: '# Held native compilation' }),
  )
  await held
  await call('cancelCompile', { ...owner, generation: 5 })
  await refuse(pending, 'In-flight native compiler outlived cancellation', unavailable)
  const current = await publish(6)
  assert.deepEqual(
    await call('compile', { ...owner, generation: 7, source: '# Ordinary diagnostics' }),
    [],
  )
  await refuse(
    rpc(wire('acquireArtifact', current, 'query')),
    'Ordinary source compilation retained an old artifact',
    unavailable,
  )
  published = await publish(8)
  await call('releaseDiagnosticsLease', owner)
  await refuse(
    rpc(wire('acquireArtifact', published, 'query')),
    'Released owner retained an artifact',
    unavailable,
  )
  checks.push(
    'real in-flight guest cancellation recovers; diagnostics-only compilation and release retire artifacts',
  )
  owner = await acquire()
  published = await publish(1)
  status = await call('status', { remote }, 'query')
  await call('revoke', { remote, context: status.context })
  await refuse(
    rpc(wire('acquireArtifact', published, 'query')),
    'Trust revocation retained an artifact',
    unavailable,
  )
  checks.push('production trust revocation retires native artifact owners')

  const state = await ui.windowStatus(page)
  assert.equal(state.artifactSourceExecuted, false, 'Vault code executed in Electron main')
  assert.equal(
    await page.evaluate("'__holi_artifact_source_executed__' in globalThis"),
    false,
    'Vault code executed in the privileged renderer',
  )
  assert(state.artifactGuestProbes > 0, 'No post-compilation guest marker observation was received')
  for (const counters of Object.values(state.network.destinations))
    for (const value of Object.values(counters))
      assert.equal(value, 0, 'Native artifact mode contacted a network destination')
  assert.equal(state.network.dns, 0)
  assert.equal(state.network.socket, 0)
  assert.deepEqual(state.network.requests, [])
  assert.deepEqual(state.network.responses, [])
  checks.push(
    'main/renderer/guest execution sentinels remain untouched and observed Node DNS/TLS/socket/HTTP counts stay zero',
  )
  return {
    modules: graph.modules.length,
    guestMarkerObservations: state.artifactGuestProbes,
    sourceExecuted: false,
    network: state.network,
    scope: 'inert compilation and authenticated acquisition; no preview execution',
  }
}
