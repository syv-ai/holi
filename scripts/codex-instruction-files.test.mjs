import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import {
  runInstructionFilesHarness,
  validateInstructionFilesEvidence,
} from './codex-instruction-files.mjs'

const tempDirs = []
after(async () => Promise.all(tempDirs.map((path) => rm(path, { recursive: true, force: true }))))

async function fixture(delivered = true) {
  const root = await mkdtemp(join(tmpdir(), 'holi788-validator-'))
  tempDirs.push(root)
  const vault = join(root, 'vault')
  const person = join(root, 'person')
  const profile = join(root, 'profile-instructions.txt')
  const ordinaryConfig = `developer_instructions = "HOLI788_CONFIG_INSTRUCTIONS"\nmodel_instructions_file = ${JSON.stringify(profile)}\n[model_providers.holi-fixture]\nbase_url = "http://127.0.0.1:43121/v1"\n[projects.${JSON.stringify(vault)}]\ntrust_level = "untrusted"\n`
  const sourceRows = [
    [profile, 'HOLI788_PROFILE_INSTRUCTIONS'],
    [join(person, 'config.toml'), ordinaryConfig],
    [join(person, 'fixture.config.toml'), ordinaryConfig],
    [join(person, 'AGENTS.md'), 'HOLI788_IGNORED_FALLBACK'],
    [join(person, 'AGENTS.override.md'), 'HOLI788_GLOBAL_INSTRUCTIONS'],
    [join(vault, 'AGENTS.md'), 'HOLI788_PROJECT_INSTRUCTIONS'],
  ]
  const sources = sourceRows.map(([path, text]) => ({ path, before: text, after: text }))
  const scenarios = []
  const requests = []
  const argv = []
  const outputs = []
  const receipts = []
  let index = 0
  for (const mode of ['ordinary', 'fenced', 'exec']) {
    const home = join(root, `${mode}-home`)
    const session = `${String(index + 1).padStart(8, '0')}-0000-4000-8000-000000000001`
    for (const phase of ['initial', 'resume']) {
      const prompt = `HOLI788_PROMPT:${mode}:${phase}`
      const guidance = `HOLI788_GUIDANCE:${mode}:${phase}`
      const config =
        mode === 'ordinary'
          ? ordinaryConfig
          : `[model_providers.holi-fixture]\nbase_url = "http://127.0.0.1:43121/v1"\n[projects.${JSON.stringify(vault)}]\ntrust_level = "untrusted"\n`
      const args =
        mode === 'ordinary'
          ? [
              '--no-alt-screen',
              '--profile',
              'fixture',
              ...(phase === 'resume' ? ['resume', session] : []),
            ]
          : mode === 'fenced'
            ? [
                '--no-alt-screen',
                '-C',
                vault,
                '--sandbox',
                'workspace-write',
                '-c',
                'approval_policy="on-request"',
                '-c',
                'sandbox_workspace_write.network_access=false',
                '-c',
                'web_search="disabled"',
                '-c',
                'tools.web_search=false',
                ...(phase === 'resume' ? ['resume', session] : []),
              ]
            : [
                'exec',
                '--json',
                '-C',
                vault,
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
                ...(phase === 'resume' ? ['resume', session] : []),
                prompt,
              ]
      const body = {
        input: [
          {
            role: 'developer',
            content:
              mode === 'ordinary'
                ? 'HOLI788_CONFIG_INSTRUCTIONS\nHOLI788_PROFILE_INSTRUCTIONS'
                : 'Native restricted workspace policy',
          },
          {
            role: 'user',
            content:
              '# AGENTS.md instructions\n<INSTRUCTIONS>\n' +
              (mode === 'ordinary' ? 'HOLI788_GLOBAL_INSTRUCTIONS\n' : '') +
              (delivered ? guidance : '') +
              '\n</INSTRUCTIONS>',
          },
          { role: 'user', content: prompt },
        ],
      }
      const requestIndex = requests.push({ body }) - 1
      const transcript =
        mode === 'exec'
          ? JSON.stringify({ type: 'thread.started', thread_id: session }) +
            '\n' +
            JSON.stringify({ type: 'turn.completed' })
          : 'Holi context fixture finished.'
      const launchLabel = `instructions-${mode}-${phase}`
      const sessionPath = join(home, 'sessions', 'session.jsonl')
      scenarios.push({
        mode,
        phase,
        home,
        session,
        prompt,
        guidance,
        requestIndex,
        files: [
          { path: join(home, 'AGENTS.md'), text: 'HOLI788_IGNORED_FALLBACK' },
          {
            path: join(home, 'AGENTS.override.md'),
            text: `${mode === 'ordinary' ? 'HOLI788_GLOBAL_INSTRUCTIONS\n' : ''}${guidance}`,
          },
        ],
        config,
        configAfter: config,
        args,
        launchLabel,
        transcript,
        sessionPath,
        sessionRecord: { type: 'session_meta', payload: { id: session } },
      })
      const launch = {
        label: launchLabel,
        codeHome: home,
        cwd: vault,
        command: '/usr/bin/sandbox-exec',
        args: [
          '-f',
          join(root, 'loopback.sb'),
          '--',
          process.execPath,
          join(root, 'install/node_modules/@openai/codex/bin/codex.js'),
          '--no-daemon',
          ...args,
        ],
      }
      argv.push(launch)
      outputs.push({ launch, transcript, exit: { code: 0 } })
      receipts.push({ drained: true })
      index++
    }
  }
  return {
    schema: 'holi.codex-instruction-files.v1',
    version: '0.169.0',
    outcome: 'supported',
    native: {
      status: 'demonstrated',
      classification: 'supported',
      scenario: 'instruction-files',
      version: 'codex-cli 0.169.0',
      package: { name: '@openai/codex', version: '0.169.0' },
      source: { commit: 'a'.repeat(40), repository: 'https://example.invalid/codex', dirty: false },
      root,
      containment: { loopback: true, external: 'EPERM' },
      modelClosed: true,
      drainage: true,
      rootRemoved: true,
      outputs,
      receipts,
      argv,
      requests,
      modelPort: 43121,
      instructionFiles: {
        sources,
        scenarios,
        controls: [{ path: join(root, 'sentinel'), executed: false }],
        projectConfig:
          '[mcp_servers.unrelated]\ncommand = "never-run"\n[plugins."unrelated@fixture"]\nenabled = true\n',
      },
    },
  }
}

describe('Codex instruction-file evidence contract', () => {
  it('accepts a complete supported observation and a bounded candidate-unsupported observation', async () => {
    const supported = await fixture()
    const resumed = supported.native.instructionFiles.scenarios[1]
    resumed.config += '\n[tui]\nscreen_reader_detection_done = true\n'
    resumed.configAfter = resumed.config
    assert.equal(validateInstructionFilesEvidence(supported), true)
    const saved = await runInstructionFilesHarness({
      output: join(supported.native.root, 'retained.json'),
      nativeRunner: async () => structuredClone(supported.native),
    })
    assert.equal(saved.evidence.outcome, 'supported')
    assert.equal(
      validateInstructionFilesEvidence(JSON.parse(await readFile(saved.output, 'utf8'))),
      true,
    )
    const unsupported = await fixture(false)
    unsupported.outcome = 'demonstrated-unsupported-path'
    unsupported.native.classification = 'demonstrated-unsupported-path'
    assert.equal(validateInstructionFilesEvidence(unsupported), true)
  })

  it('rejects incomplete, unsafe, misattributed, stale, changed-source, and wrong-role observations', async () => {
    const base = await fixture()
    const mutations = [
      (e) => {
        e.native.error = 'Owned loader did not close'
      },
      (e) => {
        e.native.instructionFiles.scenarios[0].configAfter =
          e.native.instructionFiles.scenarios[0].configAfter.replace('untrusted', 'trusted')
      },
      (e) => {
        e.native.argv[0].command = '/bin/sh'
      },
      (e) => {
        e.native.status = 'incomplete'
      },
      (e) => {
        e.native.containment.external = 'allowed'
      },
      (e) => {
        e.native.instructionFiles.scenarios[0].requestIndex = 99
      },
      (e) => {
        e.native.instructionFiles.scenarios[0].transcript = 'stale'
      },
      (e) => {
        e.native.instructionFiles.sources[0].after += ' changed'
      },
      (e) => {
        e.native.requests[0].body.input[1].role = 'assistant'
      },
      (e) => {
        e.native.requests[0].body.input.unshift({
          role: 'system',
          content: e.native.instructionFiles.scenarios[0].guidance,
        })
      },
    ]
    for (const mutate of mutations) {
      const evidence = structuredClone(base)
      mutate(evidence)
      assert.equal(validateInstructionFilesEvidence(evidence), false)
    }
  })

  it('guards artifact location and overwrite, and retains setup failures as non-conclusive evidence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holi788-output-'))
    tempDirs.push(dir)
    const output = join(dir, 'evidence.json')
    const result = await runInstructionFilesHarness({
      output,
      nativeRunner: async () => {
        throw new Error('fixture unavailable')
      },
    })
    assert.equal(result.evidence.outcome, 'incomplete-proof')
    assert.equal(validateInstructionFilesEvidence(result.evidence), false)
    assert.equal(JSON.parse(await readFile(output, 'utf8')).native.status, 'incomplete')
    const retained = await readFile(output, 'utf8')
    await assert.rejects(runInstructionFilesHarness({ output, nativeRunner: async () => ({}) }))
    assert.equal(await readFile(output, 'utf8'), retained)
    await assert.rejects(
      runInstructionFilesHarness({
        output: join(process.cwd(), 'evidence.json'),
        nativeRunner: async () => ({}),
      }),
    )
    const unavailable = await runInstructionFilesHarness({
      output: join(dir, 'unavailable.json'),
      nativeRunner: async () => ({
        status: 'incomplete',
        classification: 'setup-unavailable',
        error: 'Native containment unavailable',
      }),
    })
    assert.equal(unavailable.evidence.outcome, 'setup-unavailable')
    assert.equal(validateInstructionFilesEvidence(unavailable.evidence), false)
  })
})
