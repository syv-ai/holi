import test from 'node:test'
import assert from 'node:assert/strict'
import { validateDocumentContextProof } from './codex-document-context.mjs'

const valid = () => {
  const prompt = 'synthetic prompt'
  return {
    schema: 'holi.codex-document-context.v1', prompt,
    instructions: ['base instruction', 'profile instruction', 'project instruction', 'model instruction'],
    provenance: { binary: '/owned/codex', argv: [], environment: {}, config: {} },
    initial: { conversationId: 'same', marker: 'new-document', messages: [
      { role: 'developer', content: 'base instruction profile instruction project instruction model instruction new-document' },
      { role: 'user', content: prompt },
    ] },
    resumed: { conversationId: 'same', marker: 'changed-document', messages: [
      { role: 'developer', content: 'base instruction profile instruction project instruction model instruction changed-document' },
      { role: 'user', content: prompt },
    ] },
    consent: { normalNativeFlow: true }, cleanup: { verified: true },
  }
}

test('accepts role-correct fresh document delivery with preserved instructions and cleanup evidence', () => {
  assert.equal(validateDocumentContextProof(valid()).valid, true)
})

test('rejects marker-only user context and missing instruction preservation', () => {
  const proof = valid()
  proof.initial.messages[0].role = 'user'
  proof.resumed.messages[0].content = 'changed-document'
  assert.equal(validateDocumentContextProof(proof).valid, false)
})

test('rejects history-only resume, absent consent, and unverified cleanup', () => {
  const proof = valid()
  proof.resumed.marker = proof.initial.marker
  proof.consent.normalNativeFlow = false
  proof.cleanup.verified = false
  assert.equal(validateDocumentContextProof(proof).valid, false)
})
