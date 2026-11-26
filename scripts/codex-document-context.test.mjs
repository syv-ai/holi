import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateDocumentContextProof } from './codex-document-context.mjs'

function fixture() {
  const message = (role, value) => ({
    type: 'message',
    role,
    content: [{ type: 'input_text', text: value }],
  })
  const common = [
    message('developer', 'profile instructions'),
    message('user', 'project instructions'),
  ]
  const request = (input) => ({ input: [message('developer', 'model instructions'), ...input] })
  return {
    schema: 'holi.codex-document-context.v1',
    expected: {
      developer: 'profile instructions',
      excluded: 'base instructions',
      model: 'model instructions',
      project: 'project instructions',
    },
    prompt: 'unchanged user prompt',
    baseline: { request: request([...common, message('user', 'unchanged user prompt')]) },
    initial: {
      conversationId: '12345678-1234-1234-1234-123456789abc',
      marker: 'document.md initial',
      request: request([
        ...common,
        message('developer', 'document.md initial'),
        message('user', 'unchanged user prompt'),
      ]),
    },
    resumed: {
      conversationId: '12345678-1234-1234-1234-123456789abc',
      marker: 'document.md resumed',
      request: request([
        ...common,
        message('developer', 'document.md initial'),
        message('user', 'unchanged user prompt'),
        message('assistant', 'done'),
        message('developer', 'document.md resumed'),
        message('user', 'unchanged user prompt'),
      ]),
    },
    consent: {
      before: 'synthetic config',
      after: 'trusted_hash = "sha256:abc"',
      hook: '/owned/hook',
      transcript: 'Trusted /owned/hook',
    },
    containment: { loopback: true, external: 'EPERM' },
    sourcesUnchanged: true,
    provenance: {
      version: 'codex-cli 0.169.0',
      binaryHash: 'a'.repeat(64),
      launches: [{}],
      config: { profile: 'synthetic config' },
    },
    cleanup: { rootRemoved: true, serverClosed: true, receipts: [{ drained: true }] },
  }
}

test('accepts role-correct native startup/resume observations with preserved instructions', () => {
  assert.deepEqual(validateDocumentContextProof(fixture()), { valid: true, errors: [] })
})

test('rejects user-role context and stale resumed history', () => {
  const userRole = fixture()
  userRole.initial.request.input.find(
    (item) => item.content[0].text === 'document.md initial',
  ).role = 'user'
  assert.equal(validateDocumentContextProof(userRole).valid, false)
  const historical = fixture()
  const index = historical.resumed.request.input.findIndex(
    (item) => item.content[0].text === 'document.md resumed',
  )
  const context = historical.resumed.request.input.splice(index, 1)[0]
  historical.resumed.request.input.unshift(context)
  assert.equal(validateDocumentContextProof(historical).valid, false)
})

test('rejects instruction replacement, profile loss and changed prompts', () => {
  for (const mutate of [
    (p) => {
      p.initial.request.input.find(
        (item) => item.content[0].text === 'model instructions',
      ).content[0].text = ''
    },
    (p) => {
      p.initial.request.input.find(
        (item) => item.content[0].text === 'profile instructions',
      ).content[0].text = 'base instructions'
    },
    (p) => {
      p.initial.request.input.find(
        (item) => item.content[0].text === 'project instructions',
      ).content[0].text = ''
    },
    (p) => {
      p.resumed.request.input.at(-1).content[0].text += ' modified'
    },
  ]) {
    const proof = fixture()
    mutate(proof)
    assert.equal(validateDocumentContextProof(proof).valid, false)
  }
})

test('rejects unobserved consent, cleanup failure and a different resumed session', () => {
  for (const mutate of [
    (p) => {
      p.consent.transcript = ''
    },
    (p) => {
      p.cleanup.receipts[0].drained = false
    },
    (p) => {
      p.cleanup.serverClosed = false
    },
    (p) => {
      p.resumed.conversationId = '87654321-1234-1234-1234-123456789abc'
    },
  ]) {
    const proof = fixture()
    mutate(proof)
    assert.equal(validateDocumentContextProof(proof).valid, false)
  }
})
