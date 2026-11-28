import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { mkdir, open, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { parse as parseToml } from 'smol-toml'
import { runNativeInstructionFilesFixture } from './codex-instruction-files-native.mjs'

const schema = 'holi.codex-instruction-files.v1'
const preservedConfigKeys = [
  'projects',
  'hooks',
  'profiles',
  'plugins',
  'mcp_servers',
  'developer_instructions',
  'model_instructions_file',
  'sandbox_mode',
  'approval_policy',
  'sandbox_workspace_write',
  'model',
  'model_provider',
  'model_providers',
]
const repository = await realpath(fileURLToPath(new URL('../', import.meta.url)))
const textOf = (message) =>
  typeof message?.content === 'string'
    ? message.content
    : (message?.content?.map((part) => part.text ?? '').join('') ?? '')
const inside = (root, path) => {
  if (typeof path !== 'string' || !isAbsolute(path)) return false
  const rel = relative(root, path)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function inspectNative(native) {
  assert(
    ['observed', 'demonstrated'].includes(native.status) && !native.error,
    'Native matrix did not complete',
  )
  assert(native.scenario === 'instruction-files', 'Wrong native scenario')
  assert(
    native.version === 'codex-cli 0.169.0' &&
      native.package?.name === '@openai/codex' &&
      native.package.version === '0.169.0',
    'Pinned native identity missing',
  )
  assert(
    /^[a-f0-9]{40}$/.test(native.source?.commit) &&
      native.source.repository &&
      native.source.dirty === false,
    'Clean source provenance missing',
  )
  assert(isAbsolute(native.root), 'Owned root missing')
  assert(
    native.containment?.loopback === true &&
      ['EPERM', 'EACCES'].includes(native.containment.external),
    'Containment unverified',
  )
  assert(
    native.modelClosed === true &&
      native.drainage === true &&
      native.rootRemoved === true &&
      !native.cleanupError,
    'Cleanup unverified',
  )
  assert(
    native.outputs?.length > 0 &&
      native.outputs.length === native.receipts?.length &&
      native.argv?.length === native.outputs.length,
    'Owned launch receipts incomplete',
  )
  assert(
    native.receipts.every((item) => item.drained && !item.failure) &&
      native.outputs.every((item) => !item.failure),
    'Owned launch failure',
  )
  const matrix = native.instructionFiles
  assert(
    matrix?.sources?.length === 6 && matrix.scenarios?.length === 6,
    'Instruction matrix incomplete',
  )
  const originals = new Map()
  for (const source of matrix.sources) {
    assert(
      inside(native.root, source.path) &&
        typeof source.before === 'string' &&
        source.before === source.after &&
        !originals.has(source.path),
      'Original instruction sources changed or ambiguous',
    )
    originals.set(source.path, source.before)
  }
  assert(
    originals.get(join(native.root, 'person', 'AGENTS.override.md')) ===
      'HOLI788_GLOBAL_INSTRUCTIONS' &&
      originals.get(join(native.root, 'person', 'AGENTS.md')) === 'HOLI788_IGNORED_FALLBACK' &&
      originals.get(join(native.root, 'vault', 'AGENTS.md')) === 'HOLI788_PROJECT_INSTRUCTIONS' &&
      originals.get(join(native.root, 'profile-instructions.txt')) ===
        'HOLI788_PROFILE_INSTRUCTIONS',
    'Original instruction fixtures missing',
  )
  assert(
    matrix.controls?.length === 1 &&
      inside(native.root, matrix.controls[0].path) &&
      matrix.controls[0].executed === false,
    'Integration exclusion unverified',
  )
  const project = parseToml(matrix.projectConfig)
  assert(
    project.mcp_servers?.unrelated && project.plugins?.['unrelated@fixture']?.enabled === true,
    'Project integration declarations missing',
  )
  const observations = []
  const requestIndexes = new Set()
  const homes = new Set()
  const sessions = new Set()
  for (const mode of ['ordinary', 'fenced', 'exec']) {
    let initial
    for (const phase of ['initial', 'resume']) {
      const matches = matrix.scenarios.filter((item) => item.mode === mode && item.phase === phase)
      assert(matches.length === 1, 'Missing or duplicate native scenario')
      const item = matches[0]
      assert(
        item.prompt === `HOLI788_PROMPT:${mode}:${phase}` &&
          item.guidance === `HOLI788_GUIDANCE:${mode}:${phase}`,
        'Scenario input attribution missing',
      )
      assert(
        inside(native.root, item.home) &&
          item.home !== join(native.root, 'person') &&
          /^[a-f0-9-]{36}$/.test(item.session),
        'Managed home/session invalid',
      )
      if (phase === 'initial') {
        assert(
          !homes.has(item.home) && !sessions.has(item.session),
          'Scenario families share ownership',
        )
        homes.add(item.home)
        sessions.add(item.session)
        initial = item
      } else
        assert(
          item.home === initial.home && item.session === initial.session,
          'Resume was not the same conversation/home',
        )
      assert(
        Number.isInteger(item.requestIndex) && !requestIndexes.has(item.requestIndex),
        'Captured request reused',
      )
      requestIndexes.add(item.requestIndex)
      const request = native.requests[item.requestIndex]?.body
      assert(Array.isArray(request?.input), 'Actual captured model request missing')
      const users = request.input.filter((message) => message.role === 'user')
      assert(
        textOf(users.at(-1)) === item.prompt &&
          request.input.some((message) => message.role === 'developer'),
        'Original prompt or native policy messages changed',
      )
      if (phase === 'resume')
        assert.deepEqual(
          request.input.filter((message) => message.role === 'developer').map(textOf),
          native.requests[initial.requestIndex].body.input
            .filter((message) => message.role === 'developer')
            .map(textOf),
          'Resume changed effective native developer instructions',
        )
      const raw = JSON.stringify(request)
      assert(!raw.includes('HOLI788_IGNORED_FALLBACK'), 'Native override precedence lost')
      const config = parseToml(item.config)
      assert(
        config.projects?.[join(native.root, 'vault')]?.trust_level === 'untrusted' &&
          !raw.includes('HOLI788_PROJECT_INSTRUCTIONS'),
        'Native untrusted-project instruction exclusion changed',
      )
      const afterConfig = parseToml(item.configAfter)
      for (const key of preservedConfigKeys)
        assert.deepEqual(
          afterConfig[key],
          config[key],
          'Native launch changed saved trust, instructions or controls',
        )
      const endpoint = new URL(config.model_providers?.['holi-fixture']?.base_url)
      assert(
        endpoint.hostname === '127.0.0.1' && Number(endpoint.port) === native.modelPort,
        'Non-fixture model endpoint',
      )
      assert(!item.config.includes('HOLI788_GUIDANCE'), 'Guidance injected through configuration')
      assert(item.files?.length === 2, 'Native instruction-file observations missing')
      const fallback = item.files.find((file) => file.path === join(item.home, 'AGENTS.md'))
      const active = item.files.find((file) => file.path === join(item.home, 'AGENTS.override.md'))
      assert(
        fallback?.text === 'HOLI788_IGNORED_FALLBACK' &&
          active?.text ===
            `${mode === 'ordinary' ? 'HOLI788_GLOBAL_INSTRUCTIONS\n' : ''}${item.guidance}`,
        'Managed instruction composition invalid',
      )
      assert(
        typeof item.transcript === 'string' &&
          item.transcript.length > 0 &&
          item.launchLabel === `instructions-${mode}-${phase}`,
        'Native transcript attribution missing',
      )
      const index = native.argv.findIndex(
        (launch) => launch.label === item.launchLabel && launch.codeHome === item.home,
      )
      assert(
        index >= 0 && Array.isArray(item.args) && item.args.length > 0,
        'Owned native launch missing',
      )
      const launch = native.argv[index]
      assert(
        launch.command === '/usr/bin/sandbox-exec' &&
          launch.args[0] === '-f' &&
          launch.args[1] === join(native.root, 'loopback.sb') &&
          launch.args[2] === '--' &&
          isAbsolute(launch.args[3]) &&
          launch.args[4] === join(native.root, 'install/node_modules/@openai/codex/bin/codex.js') &&
          launch.args[5] === '--no-daemon',
        'Native launch escaped the verified containment wrapper',
      )
      assert.deepEqual(
        native.outputs[index].launch,
        launch,
        'Owned output launch provenance differs',
      )
      assert(
        launch.cwd === join(native.root, 'vault') &&
          launch.args.slice(-item.args.length).every((arg, i) => arg === item.args[i]),
        'Recorded argument provenance differs',
      )
      assert(
        native.outputs[index].transcript.startsWith(item.transcript),
        'Transcript differs from owned output',
      )
      if (mode === 'ordinary') {
        assert(
          config.developer_instructions === 'HOLI788_CONFIG_INSTRUCTIONS',
          'Effective ordinary configuration changed',
        )
        const originalConfig = parseToml(
          originals.get(join(native.root, 'person', 'fixture.config.toml')),
        )
        for (const key of preservedConfigKeys)
          assert.deepEqual(
            config[key],
            originalConfig[key],
            'Effective ordinary configuration changed',
          )
        assert(
          request.input.some(
            (message) =>
              message.role === 'developer' &&
              textOf(message).includes('HOLI788_CONFIG_INSTRUCTIONS'),
          ) &&
            request.input.some(
              (message) =>
                message.role === 'developer' &&
                textOf(message).includes('HOLI788_PROFILE_INSTRUCTIONS'),
            ) &&
            raw.includes('HOLI788_GLOBAL_INSTRUCTIONS'),
          'Effective ordinary instructions lost',
        )
        assert(
          JSON.stringify(item.args) ===
            JSON.stringify([
              '--no-alt-screen',
              '--profile',
              'fixture',
              ...(phase === 'resume' ? ['resume', item.session] : []),
            ]),
          'Ordinary native permissions or launch changed',
        )
      } else {
        assert(
          config.projects?.[join(native.root, 'vault')]?.trust_level === 'untrusted' &&
            !config.hooks &&
            !config.profiles &&
            !config.plugins &&
            !config.mcp_servers &&
            !config.developer_instructions &&
            !config.model_instructions_file,
          'Restricted home policy changed',
        )
        assert(
          !request.input.some(
            (message) =>
              message.role === 'developer' &&
              textOf(message).includes('HOLI788_CONFIG_INSTRUCTIONS'),
          ) &&
            !raw.includes('HOLI788_PROFILE_INSTRUCTIONS') &&
            !raw.includes('HOLI788_GLOBAL_INSTRUCTIONS'),
          'Excluded ordinary instructions restored',
        )
        const controls = [
          `approval_policy="${mode === 'exec' ? 'never' : 'on-request'}"`,
          'sandbox_workspace_write.network_access=false',
          'web_search="disabled"',
          'tools.web_search=false',
        ]
        const overrides = item.args.filter((_, index) => item.args[index - 1] === '-c')
        assert(
          overrides.length === controls.length &&
            controls.every((flag) => overrides.includes(flag)) &&
            !item.args.includes('--config'),
          'Restricted native overrides changed',
        )
        assert(
          item.args.filter((arg) => arg === '--sandbox').length === 1 &&
            item.args.filter((arg) => arg === '-C').length === 1 &&
            item.args[item.args.indexOf('-C') + 1] === join(native.root, 'vault'),
          'Restricted native working directory/sandbox attribution changed',
        )
        assert(
          !item.args.some((arg) =>
            [
              '--yolo',
              '--dangerously-bypass-approvals-and-sandbox',
              '--ask-for-approval',
              '-a',
              '--add-dir',
            ].includes(arg),
          ),
          'Restricted native permissions overridden',
        )
        assert(
          item.args[item.args.indexOf('--sandbox') + 1] === 'workspace-write',
          'Restricted sandbox changed',
        )
        if (mode === 'exec') {
          assert(
            item.args[0] === 'exec' &&
              item.args.includes('--json') &&
              item.args.at(-1) === item.prompt &&
              native.outputs[index].exit?.code === 0,
            'Restricted exec did not finish',
          )
          const events = item.transcript.split('\n').flatMap((line) => {
            try {
              return [JSON.parse(line)]
            } catch {
              return []
            }
          })
          assert(
            events.some((event) => event.type === 'turn.completed') &&
              events.some(
                (event) => event.type === 'thread.started' && event.thread_id === item.session,
              ),
            'Native exec thread/completion absent',
          )
        } else
          assert(
            item.args[0] === '--no-alt-screen' && !item.args.includes('exec'),
            'Fenced scenario was not a terminal',
          )
        if (phase === 'resume')
          assert(
            item.args.includes('resume') && item.args.includes(item.session),
            'Restricted native resume missing',
          )
      }
      if (mode !== 'exec')
        assert(
          inside(item.home, item.sessionPath) &&
            item.sessionRecord?.type === 'session_meta' &&
            item.sessionRecord.payload?.id === item.session &&
            item.transcript.includes('Holi context fixture finished.'),
          'Native terminal identity/completion absent',
        )
      const roles = request.input
        .filter((message) => textOf(message).includes(item.guidance))
        .map((message) => message.role)
      assert(
        roles.every((role) => role === 'user'),
        'Guidance appeared outside user instructions',
      )
      const delivered = users.some(
        (message) =>
          textOf(message).includes('# AGENTS.md instructions') &&
          textOf(message).includes('<INSTRUCTIONS>') &&
          textOf(message).includes(item.guidance),
      )
      observations.push({
        mode,
        phase,
        roles,
        projectInstructions: 'excluded-untrusted',
        delivered,
      })
    }
  }
  return {
    classification: observations.every((item) => item.delivered)
      ? 'supported'
      : 'demonstrated-unsupported-path',
    observations,
  }
}

/** Accept only complete, independently cross-checked native candidate observations. */
export function validateInstructionFilesEvidence(value) {
  try {
    if (value?.schema !== schema || value.version !== '0.169.0') return false
    const result = inspectNative(value.native)
    return value.outcome === result.classification
  } catch {
    return false
  }
}

/** Retain an exclusive bounded artifact; setup or incomplete observations never establish feasibility. */
export async function runInstructionFilesHarness({
  output = process.env.HOLI_CODEX_INSTRUCTION_FILES_EVIDENCE ??
    join(tmpdir(), `holi788-evidence-${randomUUID()}.json`),
  nativeRunner = runNativeInstructionFilesFixture,
} = {}) {
  const path = resolve(output)
  await mkdir(dirname(path), { recursive: true })
  const parent = await realpath(dirname(path))
  assert(
    !inside(repository, parent) && parent !== repository,
    'Evidence output must be outside the repository',
  )
  const file = await open(path, 'wx', 0o600)
  try {
    let native
    try {
      native = await nativeRunner()
    } catch (error) {
      native = { status: 'incomplete', classification: 'incomplete-proof', error: String(error) }
    }
    const evidence = { schema, version: '0.169.0', outcome: 'incomplete-proof', native }
    try {
      const result = inspectNative(native)
      evidence.outcome = result.classification
      evidence.observations = result.observations
      if (result.classification === 'demonstrated-unsupported-path')
        evidence.limitation = `Required native user-instruction guidance missing from: ${result.observations
          .filter((item) => !item.delivered)
          .map((item) => `${item.mode}/${item.phase}`)
          .join(', ')}`
    } catch (error) {
      evidence.validationError = String(error)
      evidence.outcome =
        native.classification === 'setup-unavailable' ? 'setup-unavailable' : 'incomplete-proof'
    }
    const bytes = `${JSON.stringify(evidence, null, 2)}\n`
    assert(Buffer.byteLength(bytes) <= 8 * 1024 * 1024, 'Instruction evidence byte bound exceeded')
    await file.writeFile(bytes)
    return { evidence, output: path }
  } finally {
    await file.close()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runInstructionFilesHarness()
  console.log(
    JSON.stringify({
      output: result.output,
      outcome: result.evidence.outcome,
      validationError: result.evidence.validationError,
    }),
  )
  if (!validateInstructionFilesEvidence(result.evidence)) process.exitCode = 1
}
