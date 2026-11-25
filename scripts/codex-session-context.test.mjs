import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  const prompts = ['HOLI764_RESTRICTED_PROMPT', 'HOLI764_RESTRICTED_FOLLOWUP']
  const launches = prompts.map((prompt, index) => ({
    home: '/fixture/home',
    args: [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-C',
      '/fixture/vault',
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy="never"',
      '-c',
      'sandbox_workspace_write.network_access=false',
      '-c',
      'web_search="disabled"',
      '-c',
      'tools.web_search=false',
      ...(index ? ['resume', '--', session] : ['--']),
      prompt,
    ],
    exit: { code: 0 },
    output: `${JSON.stringify({ type: 'thread.started', thread_id: session })}\n${JSON.stringify({ type: 'turn.completed' })}\n`,
  }))
  const argv = launches.map((launch) => ({
    command: '/usr/bin/sandbox-exec',
    args: ['-f', '/fixture/policy', '--', '/node', '/codex', '--no-daemon', ...launch.args],
    codeHome: launch.home,
  }))
  return {
    status: 'demonstrated',
    classification: 'demonstrated-unsupported-path',
    version: 'codex-cli 0.169.0',
    package: { name: '@openai/codex', version: '0.169.0' },
    source: { commit: 'a'.repeat(40), repository: '/fixture/holi', dirty: false },
    containment: { loopback: true, external: 'EPERM' },
    drainage: true,
    rootRemoved: true,
    receipts: launches.map(() => ({ drained: true })),
    argv,
    outputs: launches.map((launch, index) => ({
      launch: argv[index],
      transcript: launch.output,
      exit: launch.exit,
    })),
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
      launches,
      configs: launches.map(() => '[projects."/fixture/vault"]\ntrust_level = "untrusted"\n'),
      requests: prompts.map((prompt) => ({ body: request(prompt) })),
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
    (native) => {
      native.receipts[0].failure = 'deadline exceeded'
    },
    (native) => {
      native.outputs[0].failure = 'output exceeded bound'
    },
    (native) => {
      native.restricted.launches[0].args = ['exec', '--', 'unsafe']
    },
    (native) => {
      native.restricted.configs = []
    },
    (native) => {
      native.restricted.requests[1].body = request('wrong thread prompt')
    },
    (native) => {
      native.restricted.launches[1].output = JSON.stringify({
        type: 'thread.started',
        thread_id: 'another-thread',
      })
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

test('reports explicit setup unavailability and supported observations without relabeling either', async (t) => {
  const unavailable = await runContextHarness({
    output: await artifact(t),
    nativeRunner: async () => ({
      status: 'incomplete',
      classification: 'setup-unavailable',
      error: 'No verified containment on this platform',
    }),
  })
  assert.equal(unavailable.evidence.outcome, 'setup-unavailable')
  const native = observedNative()
  native.classification = 'supported'
  native.restricted.status = 'demonstrated'
  for (const item of native.restricted.requests)
    item.body.input[0].content[0].text = ordinary('restricted')
  const supported = await runContextHarness({
    output: await artifact(t),
    nativeRunner: async () => native,
  })
  assert.equal(supported.evidence.outcome, 'supported')
})

test('repository children beginning with dots are refused before native execution', async (t) => {
  const root = await mkdtemp(join(fileURLToPath(new URL('../', import.meta.url)), '..evidence-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let called = false
  await assert.rejects(
    runContextHarness({
      output: join(root, 'evidence.json'),
      nativeRunner: async () => {
        called = true
        return observedNative()
      },
    }),
  )
  assert.equal(called, false)
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
