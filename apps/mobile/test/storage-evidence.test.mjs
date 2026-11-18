import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'vitest'
import { validateCheckpoint, validateReport } from '../scripts/host-checks.mjs'
import { captureStorageEvidence, readBoundedJson } from '../scripts/storage-evidence.mjs'
import {
  interruptionArtifacts,
  interruptionBefore,
  interruptionAfter,
  legacyStagingDirectory,
  stagingDirectory,
} from '../app/storage-staging'
import { runVaultFormatCorpus } from '@holi/shared/vault-format'

const runId = '11111111-1111-1111-1111-111111111111'
const root = `/sandbox/Documents/holi-storage-interruption-${runId}`
const context = {
  runId,
  pid: 321,
  launchedAt: 100,
  now: 200,
  documents: '/sandbox/Documents',
  library: '/sandbox/Library',
}
test('private artifact namespaces are prefix-free for aligned and Unicode roots', () => {
  const prefix = '/sandbox/Documents/'
  const aligned = `${prefix}${'a'.repeat(32 - new TextEncoder().encode(prefix).length)}`
  assert.equal(new TextEncoder().encode(aligned).length % 32, 0)
  const roots = [
    aligned,
    `${aligned}x`,
    `${prefix}é${'😀'.repeat(12)}`,
    `${prefix}${'long'.repeat(48)}`,
  ]
  for (const root of roots) {
    const artifactPath = stagingDirectory(context.library, root)
    assert.equal(artifactPath.split('/').at(-1), 'artifacts')
    assert.notEqual(artifactPath, legacyStagingDirectory(context.library, root))
  }
  const first = stagingDirectory(context.library, aligned)
  const sibling = stagingDirectory(context.library, `${aligned}x`)
  assert.ok(!sibling.startsWith(`${first}/`))
  assert.ok(!first.startsWith(`${sibling}/`))
  const oldFirst = legacyStagingDirectory(context.library, aligned)
  const oldSibling = legacyStagingDirectory(context.library, `${aligned}x`)
  assert.ok(oldSibling.startsWith(`${oldFirst}/`), 'fixture must reproduce the old nesting')
})

const marker = {
  schemaVersion: 1,
  phase: 'staged',
  runId,
  pid: 321,
  startedAt: 110,
  readyAt: 120,
  root,
  relative: 'durable.md',
  stage: `${stagingDirectory(context.library, root)}/stage-00000000-0000-0000-0000-000000000000.tmp`,
}

test('checkpoint requires fresh identity and the exact private root namespace', () => {
  validateCheckpoint(marker, context)
  for (const patch of [
    { runId: 'old' },
    { pid: 322 },
    { phase: 'normal' },
    { startedAt: 99 },
    { readyAt: 201 },
    { schemaVersion: 2 },
    { relative: '../outside' },
    { root: '/outside' },
    { stage: '/sandbox/Documents/forged.tmp' },
    {
      stage: `${stagingDirectory(context.library, root)}/../stage-00000000-0000-0000-0000-000000000000.tmp`,
    },
    {
      stage: `${stagingDirectory(context.library, root)}/nested/stage-00000000-0000-0000-0000-000000000000.tmp`,
    },
    {
      stage: `${stagingDirectory(context.library, root)}-other/stage-00000000-0000-0000-0000-000000000000.tmp`,
    },
  ])
    assert.throws(() => validateCheckpoint({ ...marker, ...patch }, context))
})

test('recovery reports cannot substitute normal completion or omit recovery cases', () => {
  const report = {
    schemaVersion: 2,
    phase: 'recovery',
    runId,
    platform: 'ios',
    osVersion: '27.2',
    startedAt: 110,
    finishedAt: 120,
    corpus: runVaultFormatCorpus((text) => new TextEncoder().encode(text)),
    recovery: {
      root,
      before: interruptionBefore,
      after: interruptionAfter,
      normalBytes: 'winner A',
      ownedStageRemoved: true,
      unownedPreserved: interruptionArtifacts.map(([name]) => name),
      rawNamesPreserved: ['Café.md', 'Cafe\u0301.md'],
    },
  }
  const ctx = {
    ...context,
    osVersion: '27.2',
    storageRoot: context.documents,
    phase: 'recovery',
    normalBytes: 'winner A',
  }
  validateReport(report, ctx)
  for (const patch of [
    { ownedStageRemoved: false },
    { root: '/outside' },
    { before: interruptionAfter },
    { unownedPreserved: [] },
    { rawNamesPreserved: [] },
    { normalBytes: 'winner B' },
  ])
    assert.throws(() =>
      validateReport({ ...report, recovery: { ...report.recovery, ...patch } }, ctx),
    )
  assert.throws(() => validateReport({ ...report, phase: 'normal' }, ctx))
})

test('failure snapshots retain bounded regular bytes and omit links and oversized files', async () => {
  const base = await mkdtemp('/tmp/holi-588-evidence-test-')
  try {
    const source = join(base, 'owned')
    await mkdir(source)
    await writeFile(join(source, 'durable.md'), 'preserved')
    await writeFile(join(base, 'outside'), 'must not copy')
    await symlink(join(base, 'outside'), join(source, 'link'))
    await writeFile(join(source, 'large'), 'x'.repeat(128))
    const output = join(base, 'snapshot.json')
    const snapshot = await captureStorageEvidence([source], output, { maxBytes: 32 })
    assert.equal(Buffer.from(snapshot.files[0].base64, 'base64').toString(), 'preserved')
    assert.equal(snapshot.files.length, 1)
    assert.ok(snapshot.omissions.some((item) => item.reason === 'symlink'))
    assert.ok(snapshot.omissions.some((item) => item.reason === 'file/byte limit'))
    assert.deepEqual(await readBoundedJson(output), snapshot)
    await assert.rejects(readBoundedJson(output, 1), /oversized/)
    await assert.rejects(readBoundedJson(join(source, 'link')))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
