import assert from 'node:assert/strict'
import { test } from 'vitest'
import { runVaultFormatCorpus } from '@holi/shared/vault-format'
import { runCommand, validateReport, validateSharedGraph } from '../scripts/host-checks.mjs'

const corpus = runVaultFormatCorpus((text) => new TextEncoder().encode(text))
const context = { runId: 'fresh', launchedAt: 100, now: 200, osVersion: '26.2' }
const report = {
  schemaVersion: 1,
  runId: 'fresh',
  platform: 'ios',
  osVersion: '26.2',
  startedAt: 110,
  finishedAt: 120,
  corpus,
}

test('host accepts only fresh complete native evidence for every bundled case', () => {
  assert.ok(corpus.total > 0)
  assert.equal(corpus.failed, 0)
  validateReport(report, context)
})

for (const [name, mutate] of [
  [
    'stale run',
    (value) => {
      value.runId = 'old'
    },
  ],
  [
    'old timestamp',
    (value) => {
      value.startedAt = 99
    },
  ],
  [
    'future timestamp',
    (value) => {
      value.finishedAt = 201
    },
  ],
  [
    'wrong platform',
    (value) => {
      value.platform = 'node'
    },
  ],
  [
    'wrong runtime',
    (value) => {
      value.osVersion = '27.2'
    },
  ],
  [
    'unsupported schema',
    (value) => {
      value.schemaVersion = 2
    },
  ],
  [
    'native parser error',
    (value) => {
      value.error = 'Unsupported operation'
    },
  ],
  [
    'missing report',
    (value) => {
      delete value.corpus
    },
  ],
  [
    'partial report',
    (value) => {
      value.corpus.results.pop()
    },
  ],
  [
    'failed fixture',
    (value) => {
      value.corpus.failed = 1
    },
  ],
  [
    'mismatched output',
    (value) => {
      value.corpus.results[0].actual.path = 'wrong.md'
    },
  ],
  [
    'wrong expected output',
    (value) => {
      value.corpus.results[0].expected.path = 'wrong.md'
    },
  ],
  [
    'changed fixture input',
    (value) => {
      value.corpus.results[0].input = 'wrong.md'
    },
  ],
  [
    'duplicate fixture',
    (value) => {
      value.corpus.results[1] = value.corpus.results[0]
    },
  ],
]) {
  test(`host rejects ${name}`, () => {
    const value = structuredClone(report)
    mutate(value)
    assert.throws(() => validateReport(value, context))
  })
}

test('host rejects absent, incomplete or nonportable shared graph evidence', () => {
  const graph = {
    schemaVersion: 1,
    resources: ['path-safety.ts', 'vault-format.ts', 'vault-format.v1.json'],
    edges: [
      { from: 'vault-format.ts', request: './path-safety', to: 'path-safety.ts' },
      { from: 'vault-format.ts', request: './vault-format.v1.json', to: 'vault-format.v1.json' },
    ],
  }
  validateSharedGraph(graph)
  for (const patch of [
    { schemaVersion: 2 },
    { resources: [] },
    { edges: [] },
    { resources: [...graph.resources, 'path-safety-node.ts'] },
    { edges: [...graph.edges, { from: 'vault-format.ts', request: 'node:fs', to: 'polyfill.js' }] },
  ])
    assert.throws(() => validateSharedGraph({ ...graph, ...patch }))
})

test('host command failures and timeouts cannot pass', async () => {
  assert.equal(await runCommand(process.execPath, ['-e', 'process.stdout.write("ok")']), 'ok')
  assert.equal(
    await runCommand(process.execPath, [
      '-e',
      'process.stderr.write("warning"); process.stdout.write("{\\"ok\\":true}")',
    ]),
    '{"ok":true}',
  )
  await assert.rejects(runCommand(process.execPath, ['-e', 'process.exit(7)']), /Exit 7/)
  await assert.rejects(
    runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 50 }),
    /Timed out/,
  )
})
