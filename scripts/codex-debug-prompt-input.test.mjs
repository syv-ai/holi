import test from 'node:test'
import assert from 'node:assert/strict'
import { validateDebugPromptInputEvidence } from './codex-debug-prompt-input.mjs'

const message = (role, text) => ({
  type: 'message',
  role,
  content: [{ type: 'input_text', text }],
})

function completeEvidence() {
  const evidence = {
    schema: 'holi.codex-debug-prompt-input.v1',
    outcome: 'demonstrated-unsupported-path',
    status: 'demonstrated',
    native: {
      version: 'codex-cli 0.169.0',
      package: { name: '@openai/codex', version: '0.169.0' },
      source: { commit: 'a'.repeat(40), dirty: false },
      containment: { loopback: true, external: 'EPERM' },
      cleanup: { rootRemoved: true, drained: true },
      receipts: [{ drained: true }],
      configUnchanged: true,
      sentinelsUnexecuted: true,
      modelRequests: 0,
      integrationControls: ['hook', 'mcp', 'plugin'].map((kind) => ({
        kind,
        declaration: 'synthetic declared control',
        policy: kind === 'hook' ? 'untrusted' : 'disabled',
        before: false,
        after: false,
      })),
      observations: [
        {
          exitCode: 0,
          stdout: '[]',
          stderr: '',
          input: [
            message('developer', 'HOLI807_BASE_DEVELOPER'),
            message('user', 'HOLI807_UNCHANGED_USER_PROMPT'),
          ],
          argv: ['debug', 'prompt-input'],
          cwd: '/fixture/vault',
          env: { CODEX_HOME: '/fixture/codex-home' },
        },
        {
          exitCode: 0,
          stdout: '[]',
          stderr: '',
          input: [
            message('developer', 'HOLI807_PROFILE_DEVELOPER'),
            message('user', 'HOLI807_UNCHANGED_USER_PROMPT'),
          ],
          argv: ['debug', 'prompt-input', '--profile', 'fixture'],
          cwd: '/fixture/vault',
          env: { CODEX_HOME: '/fixture/codex-home' },
        },
      ],
    },
  }
  for (const observation of evidence.native.observations)
    observation.stdout = JSON.stringify(observation.input)
  return evidence
}

test('accepts complete base and profile native observations as demonstrated limitation', () => {
  assert.equal(validateDebugPromptInputEvidence(completeEvidence()), true)
})

test('accepts an incomplete report only when its status is incomplete', () => {
  const evidence = {
    schema: 'holi.codex-debug-prompt-input.v1',
    outcome: 'incomplete-proof',
    status: 'incomplete',
  }
  assert.equal(validateDebugPromptInputEvidence(evidence), true)
  assert.equal(validateDebugPromptInputEvidence({ ...evidence, status: 'demonstrated' }), false)
})

test('rejects claims that omit containment or cleanup evidence', () => {
  for (const [key, patch] of [
    ['containment', { containment: { loopback: true, external: 'unverified' } }],
    ['cleanup', { cleanup: { rootRemoved: false, drained: true } }],
  ]) {
    const evidence = completeEvidence()
    Object.assign(evidence.native, { [key]: patch[key] })
    assert.equal(validateDebugPromptInputEvidence(evidence), false)
  }
})

test('rejects observations that do not prove the requested roles and unchanged prompt', () => {
  const mutations = [
    (input) => {
      input[0] = message('user', 'HOLI807_BASE_DEVELOPER')
    },
    (input) => {
      input.splice(0, 1)
    },
    (input) => {
      input.at(-1).content[0].text = 'changed prompt'
    },
  ]
  for (const mutate of mutations) {
    const evidence = completeEvidence()
    mutate(evidence.native.observations[0].input)
    evidence.native.observations[0].stdout = JSON.stringify(evidence.native.observations[0].input)
    assert.equal(validateDebugPromptInputEvidence(evidence), false)
  }
})

test('rejects recorded command, cleanup, receipt and model failures despite positive observations', () => {
  for (const mutate of [
    (evidence) => (evidence.error = 'command failed'),
    (evidence) => (evidence.cleanupError = 'cleanup failed'),
    (evidence) => (evidence.native.receipts[0].error = 'receipt failed'),
    (evidence) => (evidence.native.modelFailures = ['model failed']),
  ]) {
    const evidence = completeEvidence()
    mutate(evidence)
    assert.equal(validateDebugPromptInputEvidence(evidence), false)
  }
})

test('rejects nonzero command results and evidence of model requests', () => {
  const nonzero = completeEvidence()
  nonzero.native.observations[0].exitCode = 1
  assert.equal(validateDebugPromptInputEvidence(nonzero), false)

  const requestedModel = completeEvidence()
  requestedModel.native.modelRequests = 1
  assert.equal(validateDebugPromptInputEvidence(requestedModel), false)
})

test('rejects missing, executed and inconclusive integration controls', () => {
  for (const kind of ['hook', 'mcp', 'plugin']) {
    for (const mutation of ['missing', 'executed', 'inconclusive']) {
      const evidence = completeEvidence()
      if (mutation === 'missing')
        evidence.native.integrationControls = evidence.native.integrationControls.filter(
          (control) => control.kind !== kind,
        )
      else {
        const control = evidence.native.integrationControls.find((item) => item.kind === kind)
        if (mutation === 'executed') control.after = true
        else delete control.after
      }
      assert.equal(validateDebugPromptInputEvidence(evidence), false)
    }
  }
})

test('rejects native output beyond its capture bound', () => {
  const evidence = completeEvidence()
  evidence.native.observations[0].stdout = 'x'.repeat(524289)
  assert.equal(validateDebugPromptInputEvidence(evidence), false)
})
