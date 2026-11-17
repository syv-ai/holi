import assert from 'node:assert/strict'
import { test } from 'vitest'
import { runVaultFormatCorpus } from '@holi/shared/vault-format'
import {
  moveCrashCases,
  runCommand,
  validateMoveCheckpoint,
  moveCheckpointState,
  validateMoveCheckpointState,
  validateReport,
  validateSharedGraph,
} from '../scripts/host-checks.mjs'

import { storageFaultPhases, storageFixturePaths } from '../app/vault-storage-check'
import { moveFixtureBytes as images } from '../app/move-fixtures'

const runId = '11111111-1111-1111-1111-111111111111'
const corpus = runVaultFormatCorpus((text) => new TextEncoder().encode(text))
const context = {
  runId,
  launchedAt: 100,
  now: 200,
  osVersion: '26.2',
  storageRoot: '/sandbox/Documents',
}
const rawNames = ['Café.md', 'Cafe\u0301.md'].map((name, index) => ({
  root: `/sandbox/Documents/holi-raw-${runId}-${index}`,
  name,
  names: [name],
  aliasRejected: true,
  originalText: 'raw native fixture',
  saved: 'updated raw native fixture',
}))
const report = {
  schemaVersion: 2,
  phase: 'normal',
  rawNames,
  nativeFilenameRoots: rawNames,
  nativeFilenameSpellings: true,
  runId,
  platform: 'ios',
  osVersion: '26.2',
  startedAt: 110,
  finishedAt: 120,
  corpus,
  storage: {
    schemaVersion: 3,
    faultPhases: [...storageFaultPhases],
    faultOperations: 10,
    fixturesPreserved: [...storageFixturePaths],
    passed: 1,
    total: 1,
    failed: 0,
    concurrentFulfilled: 1,
    staleRejected: true,
    isolatedRoots: true,
    exactBytes: true,
    listingFiltered: true,
    caseAliasRejected: true,
    symlinkRejected: true,
    finalBytes: 'winner A',
  },
  storageRoot: `/sandbox/Documents/holi-storage-check-${runId}`,
}

test('host accepts only fresh complete native evidence for every bundled case', () => {
  assert.ok(corpus.total > 0)
  assert.equal(corpus.failed, 0)
  validateReport(report, context)
})

for (const [name, mutate] of [
  [
    'wrong phase',
    (value) => {
      value.phase = 'recovery'
    },
  ],
  [
    'missing fault cases',
    (value) => {
      value.storage.faultOperations = 0
    },
  ],
  [
    'missing planted fixtures',
    (value) => {
      value.storage.fixturesPreserved.pop()
    },
  ],
  [
    'missing native Unicode proof',
    (value) => {
      delete value.rawNames
    },
  ],
  [
    'wrong raw root',
    (value) => {
      value.rawNames[0].root = '/outside'
    },
  ],
  [
    'Unicode spelling mismatch',
    (value) => {
      value.rawNames[0].names = ['Cafe\u0301.md']
    },
  ],
  [
    'traversal storage root',
    (value) => {
      value.storageRoot = '/sandbox/Documents/../Library/private'
    },
  ],
  [
    'symlink-like namespace root',
    (value) => {
      value.storageRoot = '/sandbox/Documents/holi-storage-check-fresh-110/../outside'
    },
  ],
  [
    'outside container storage root',
    (value) => {
      value.storageRoot = '/sandbox-other/Documents/holi-storage-check-fresh-110'
    },
  ],
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
      value.schemaVersion = 3
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
    'missing storage evidence',
    (value) => {
      delete value.storage
    },
  ],
  [
    'failed storage evidence',
    (value) => {
      value.storage.failed = 1
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
    resources: [
      'mobile-path-safety.ts',
      'path-safety.ts',
      'vault-format.ts',
      'vault-format.v1.json',
      'wiki-links.ts',
    ],
    edges: [
      { from: 'mobile-path-safety.ts', request: './path-safety', to: 'path-safety.ts' },
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

test('native move crash matrix covers every durable event and rejects forged checkpoint evidence', () => {
  const cases = moveCrashCases()
  assert.equal(cases.length, 13)
  assert.deepEqual(
    cases.map(({ ordinal, phase, path }) => [ordinal, phase, path]),
    [
      [0, 'journal-before', null],
      [1, 'journal-after', null],
      ...['from.md', 'to.md', 'back-a.md', 'back-b.md'].flatMap((path, index) => [
        [2 + index * 2, 'file-before', path],
        [3 + index * 2, 'file-after', path],
      ]),
      [10, 'cleanup-before', 'journal'],
      [11, 'cleanup-after', 'journal'],
      [12, 'recovery-file-before', 'to.md'],
    ],
  )
  assert.deepEqual(
    cases.map(({ phase, direction }) => `${phase}:${direction}`),
    [
      'journal-before:before',
      'journal-after:after',
      ...Array.from({ length: 4 }, () => ['file-before:before', 'file-after:after']).flat(),
      'cleanup-before:before',
      'cleanup-after:after',
      'recovery-file-before:before',
    ],
  )
  const caseInfo = cases[10]
  const marker = {
    schemaVersion: 1,
    runId,
    ordinal: caseInfo.ordinal,
    phase: caseInfo.phase,
    direction: caseInfo.direction,
    path: 'move-22222222-2222-4222-8222-222222222222.json',
    root: '/sandbox/Documents/holi-move-run-10',
    privatePath: '/sandbox/Library/HoliVaultStorage/test-root',
    pid: 42,
    startedAt: 110,
    readyAt: 120,
    operationId: '22222222-2222-4222-8222-222222222222',
  }
  const context = {
    runId,
    caseInfo,
    pid: 42,
    launchedAt: 100,
    now: 130,
    root: marker.root,
    privatePath: marker.privatePath,
  }
  assert.equal(validateMoveCheckpoint(marker, context), marker)
  for (const patch of [
    { pid: 43 },
    { operationId: 'not-an-id' },
    { root: '/outside' },
    { privatePath: '/outside' },
    { readyAt: 99 },
    { phase: 'file-after' },
    { path: '../outside' },
  ])
    assert.throws(() => validateMoveCheckpoint({ ...marker, ...patch }, context))
  const journalBefore = cases[0]
  assert.throws(() =>
    validateMoveCheckpoint(
      { ...marker, ordinal: 0, phase: journalBefore.phase, direction: journalBefore.direction },
      { ...context, caseInfo: journalBefore },
    ),
  )
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

test('native move checkpoint states reject interchangeable pre/post evidence', () => {
  const operationId = '22222222-2222-4222-8222-222222222222'
  const root = '/sandbox/Documents/holi-move-run'
  const values = (expected) =>
    Object.fromEntries(
      Object.entries(expected).map(([path, text]) => [
        path,
        text === null ? null : Buffer.from(text),
      ]),
    )
  const journal = {
    schema: 2,
    root,
    operationId,
    from: 'from.md',
    to: 'to.md',
    changes: [
      { path: 'from.md', before: [...new TextEncoder().encode(images.source)], after: null },
      { path: 'to.md', before: null, after: [...new TextEncoder().encode(images.moved)] },
      {
        path: 'back-a.md',
        before: [...new TextEncoder().encode(images.backA)],
        after: [...new TextEncoder().encode(images.movedA)],
      },
      {
        path: 'back-b.md',
        before: [...new TextEncoder().encode(images.backB)],
        after: [...new TextEncoder().encode(images.movedB)],
      },
    ],
  }
  for (const caseInfo of moveCrashCases()) {
    const state = moveCheckpointState(caseInfo, operationId, images, root)
    const evidence = {
      caseInfo,
      operationId,
      files: values(state.files),
      journal: state.journal ? journal : null,
    }
    validateMoveCheckpointState(state, evidence)
    if (caseInfo.phase === 'journal-before' || caseInfo.phase === 'cleanup-after') {
      assert.throws(() => validateMoveCheckpointState(state, { ...evidence, journal }))
    } else {
      assert.throws(() => validateMoveCheckpointState(state, { ...evidence, journal: null }))
    }
    if (caseInfo.phase.startsWith('file-')) {
      const alternate = caseInfo.phase === 'file-before' ? 'file-after' : 'file-before'
      const swapped = moveCheckpointState(
        { ...caseInfo, phase: alternate },
        operationId,
        images,
        root,
      )
      assert.throws(() =>
        validateMoveCheckpointState(state, { ...evidence, files: values(swapped.files) }),
      )
    }
    if (caseInfo.phase === 'file-after' && caseInfo.path === 'from.md') {
      const wrongPrefix = {
        ...evidence,
        files: values({ ...state.files, 'from.md': `prefix${images.source}` }),
      }
      assert.throws(() => validateMoveCheckpointState(state, wrongPrefix))
    }
    if (caseInfo.phase === 'journal-after') {
      const wrongImage = structuredClone(journal)
      wrongImage.changes[0].before[0] ^= 1
      assert.throws(() => validateMoveCheckpointState(state, { ...evidence, journal: wrongImage }))
    }
  }
  const recovery = moveCheckpointState(moveCrashCases()[12], operationId, images, root)
  assert.deepEqual(recovery.files, {
    'from.md': null,
    'to.md': null,
    'back-a.md': images.backA,
    'back-b.md': images.backB,
  })
})
