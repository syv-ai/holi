import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runContextHarness, validateContextEvidence } from './codex-session-context.mjs'

const request = (prompt, context = '') => ({
  input: [
    { role: 'developer', content: [{ type: 'input_text', text: context }] },
    { role: 'user', content: [{ type: 'input_text', text: prompt }] },
  ],
})
const ordinary = (source) =>
  `HOLI764_CONFIG_INSTRUCTIONS HOLI764_PROFILE_INSTRUCTIONS HOLI764_ADDITIVE_CONTEXT:${source}`
function observedNative() {
  const session = 'fixture-session'
  return {
    status: 'demonstrated',
    version: 'codex-cli 0.169.0',
    package: { name: '@openai/codex', version: '0.169.0' },
    source: { commit: 'reviewed-revision', dirty: false },
    containment: { loopback: true, external: 'EPERM' },
    drainage: true,
    rootRemoved: true,
    receipts: [{ drained: true }],
    initial: {
      status: 'demonstrated',
      request: request('HOLI764_UNCHANGED_USER_PROMPT', ordinary('startup')),
    },
    resume: {
      status: 'demonstrated',
      session,
      request: request('HOLI764_RESUME_PROMPT', ordinary('resume')),
    },
    hooks: [
      { source: 'startup', session_id: session },
      { source: 'resume', session_id: session },
    ],
    consent: [{ label: 'trust-exact-owned-hook' }],
    trustChanges: [{ before: 'fixture config', after: 'trusted_hash = "sha256:native-generated"' }],
    approvalTranscript: 'Command /fixture/owned-context-hook.mjs',
    negativeControls: [
      {
        label: 'unrelated-hook',
        status: 'demonstrated',
        deniedHookExecuted: false,
        request: request('control', ordinary('startup')),
      },
      {
        label: 'modified-hook',
        status: 'demonstrated',
        deniedHookExecuted: false,
        beforeEvents: 3,
        afterEvents: 3,
        request: request('control'),
      },
    ],
    restricted: {
      status: 'demonstrated-unsupported',
      limitation: 'Production isolated home excludes this ordinary hook/context path.',
      projectIntegrationExecuted: false,
      launches: [{ exit: { code: 0 } }, { exit: { code: 0 } }],
      requests: [{ body: request('job') }, { body: request('followup') }],
    },
  }
}
async function artifact(t) {
  const root = await mkdtemp(join(tmpdir(), 'holi764-evidence-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return join(root, 'evidence.json')
}

test('complete native observations retain a bounded unsupported-path result, not feature delivery', async (t) => {
  const output = await artifact(t)
  const result = await runContextHarness({ output, nativeRunner: async () => observedNative() })
  assert.equal(result.evidence.outcome, 'demonstrated-unsupported-path')
  assert.equal(validateContextEvidence(JSON.parse(await readFile(output, 'utf8'))), true)
  assert.equal((await stat(output)).mode & 0o777, 0o600)
})

test('partial, stale, unsafe or misattributed observations cannot produce a conclusive result', async (t) => {
  const mutations = [
    (native) => {
      native.source.dirty = true
    },
    (native) => {
      native.containment.external = 'CONNECTED'
    },
    (native) => {
      native.receipts[0].drained = false
    },
    (native) => {
      native.resume.request = request('HOLI764_RESUME_PROMPT', ordinary('startup'))
    },
    (native) => {
      native.initial.request = request('a rewritten user prompt', ordinary('startup'))
    },
    (native) => {
      native.negativeControls[1].afterEvents++
    },
    (native) => {
      native.restricted.requests = []
    },
    (native) => {
      native.restricted.projectIntegrationExecuted = true
    },
    (native) => {
      native.trustChanges = [{}]
    },
  ]
  for (const mutate of mutations) {
    const native = observedNative()
    mutate(native)
    const output = await artifact(t)
    const result = await runContextHarness({ output, nativeRunner: async () => native })
    assert.equal(result.evidence.outcome, 'incomplete-proof')
  }
  assert.equal(validateContextEvidence(null), false)
})

test('native setup failure remains incomplete evidence and cannot overwrite an existing artifact', async (t) => {
  const output = await artifact(t)
  const nativeRunner = async () => ({
    status: 'incomplete',
    error: 'Native setup unavailable',
    drainage: true,
    rootRemoved: true,
  })
  const result = await runContextHarness({ output, nativeRunner })
  assert.equal(result.evidence.outcome, 'incomplete-proof')
  const before = await readFile(output, 'utf8')
  await assert.rejects(runContextHarness({ output, nativeRunner }), { code: 'EEXIST' })
  assert.equal(await readFile(output, 'utf8'), before)
})
