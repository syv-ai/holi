import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { inspectCodexTuiEvidence, runCodexTuiProducer } from './codex-tui-producer.mjs'

function protocol() {
  const identity = { runId: 'synthetic-protocol-run', nonce: 'synthetic-protocol-challenge' }
  let serial = 100
  const context = (approval = false) => {
    const raw = Buffer.from(
      approval ? '\x1b]9;Approval requested\x07You canceled the request' : 'native fixture answer',
    )
    const conversationId = `conversation-${serial}`
    return {
      removed: true,
      requests: [{ modelRequest: { input: [] } }],
      received: [
        {
          body: JSON.stringify({
            type: 'agent-turn-complete',
            client: 'codex-tui',
            'thread-id': conversationId,
          }),
        },
      ],
      consumed: [{ kind: 'turn', after: [{ id: 'p0123456789ab', state: 'idle', conversationId }] }],
      changes: approval ? [[{ state: 'needs-you' }]] : [],
      brackets: [{ edge: 'begin' }, { edge: 'end' }],
      native: [
        {
          argv: ['-f', 'owned-policy', 'owned-binary', '--no-daemon'],
          inputs: approval ? [{ hex: '1b' }] : [],
          receipt: {
            drained: true,
            supervisorPid: serial++,
            anchorPid: serial++,
            nativePid: serial++,
          },
          rawBase64: raw.toString('base64'),
          sha256: createHash('sha256').update(raw).digest('hex'),
        },
      ],
    }
  }
  const proof = {
    schema: 'holi.codex-tui-producer.v1',
    ...identity,
    workerPid: 99,
    owners: Array.from({ length: 6 }, () => ({ removed: true, nativeDrained: true })),
    classification: 'pass',
    cleanup: { bridgeClosed: true, contextsRemoved: true, nativeDrained: true },
    scenarios: [
      { name: 'success', status: 'pass', contexts: [context()] },
      { name: 'approval-cancel', status: 'pass', contexts: [context(true)] },
      { name: 'closed-session-notify', status: 'pass', contexts: [context(), context()] },
      { name: 'leave-isolation', status: 'pass', contexts: [context(), context()] },
    ],
  }
  return { proof, identity }
}

function inspect(proof, identity, receiptChanges = {}) {
  const bytes = Buffer.from(JSON.stringify(proof))
  const receipt = {
    ...identity,
    workerPid: proof.workerPid,
    settled: true,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...receiptChanges,
  }
  return inspectCodexTuiEvidence(bytes, receipt, identity)
}

test('complete synthetic wire protocol validates consumer evidence and final settlement', () => {
  const { proof, identity } = protocol()
  assert.equal(inspect(proof, identity).complete, true)
  assert.equal(inspect(proof, identity).settled, true)
})

test('partial or skipped scenarios cannot establish acceptance even with a settlement receipt', () => {
  for (const change of [
    (proof) => proof.scenarios.pop(),
    (proof) => {
      proof.scenarios[1].status = 'skipped'
    },
    (proof) => {
      proof.scenarios[0].contexts[0].consumed = []
    },
    (proof) => {
      proof.scenarios[1].contexts[0].changes = []
    },
    (proof) => {
      proof.scenarios[1].contexts[0].native[0].inputs = [{ hex: '0d' }]
    },
  ]) {
    const { proof, identity } = protocol()
    change(proof)
    assert.equal(inspect(proof, identity).complete, false)
  }
})

test('foreign identity, tampered bytes and missing physical receipts fail closed', () => {
  const { proof, identity } = protocol()
  assert.throws(() => inspect(proof, { ...identity, nonce: 'foreign' }))
  assert.equal(inspect(proof, identity, { sha256: 'not-the-artifact-digest' }).settled, false)
  proof.owners.push({ removed: false, nativeDrained: false })
  assert.equal(inspect(proof, identity).settled, false)
  proof.owners.pop()
  proof.scenarios[0].contexts[0].native[0].receipt.drained = false
  assert.equal(inspect(proof, identity).settled, false)
  assert.equal(inspect(proof, identity).complete, false)
  assert.throws(() => inspectCodexTuiEvidence(Buffer.alloc(4 * 1024 * 1024 + 1), {}, identity))
})

test('unavailable package command preserves diagnostics and removes an unadmitted runtime', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'holi-tui-runner-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const result = await runCodexTuiProducer({
    npm: join(directory, 'missing-npm'),
    evidencePath: join(directory, 'evidence.json'),
  })
  assert.equal(result.failed, true)
  assert.equal(result.evidence.classification, 'setup-unavailable')
  assert.equal(result.evidence.cleanup.rootRemoved, true)
  assert.equal(
    JSON.parse(await readFile(result.evidence.artifact, 'utf8')).classification,
    'setup-unavailable',
  )
})
