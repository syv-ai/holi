import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startOwnedPty } from './pi-native-tui-process.mjs'
import { createContextModel } from './codex-context-model.mjs'
import { installPinnedCodex } from './codex-native-install.mjs'

const repository = fileURLToPath(new URL('../', import.meta.url))
const prompt = 'HOLI807_UNCHANGED_USER_PROMPT'
const profileText = 'HOLI807_PROFILE_DEVELOPER'
const baseText = 'HOLI807_BASE_DEVELOPER'
const clean = (text) => text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').trim()
const messageText = (item) =>
  Array.isArray(item.content) ? item.content.map((part) => part.text ?? '').join('') : item.content

export async function runOwnedCommand(child, label) {
  const exit = await child.waitForExit()
  await child.close()
  const output = clean(child.output.toString())
  if (exit.code !== 0 || child.failure) throw Error(`${label} failed: ${output.slice(-4000)}`)
  return output
}

// Serialized into the existing owned PTY; its descendants retain the same supervisor.
async function captureNativeOutput(args) {
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  const limit = 524288
  let stdout = Buffer.alloc(0)
  let stderr = Buffer.alloc(0)
  let overflow = false
  for (const [stream, kind] of [
    [child.stdout, 'stdout'],
    [child.stderr, 'stderr'],
  ]) {
    stream.on('data', (bytes) => {
      const previous = kind === 'stdout' ? stdout : stderr
      if (previous.length + bytes.length > limit) {
        overflow = true
        child.kill('SIGKILL')
        return
      }
      if (kind === 'stdout') stdout = Buffer.concat([stdout, bytes])
      else stderr = Buffer.concat([stderr, bytes])
    })
  }
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  if (overflow) throw Error('Native output exceeded 524288 bytes')
  if (exitCode !== 0) throw Error('Native command failed: ' + stderr.toString().slice(-4000))
  process.stdout.write(
    JSON.stringify({ stdout: stdout.toString(), stderr: stderr.toString(), exitCode }),
  )
}

/** Accept a candidate limitation only after complete native observations and cleanup. */
export function validateDebugPromptInputEvidence(value) {
  if (value?.schema !== 'holi.codex-debug-prompt-input.v1') return false
  if (value.outcome === 'incomplete-proof') return value.status === 'incomplete'
  if (value.error || value.cleanupError) return false
  const n = value.native
  if (
    value.outcome !== 'demonstrated-unsupported-path' ||
    value.status !== 'demonstrated' ||
    n?.version !== 'codex-cli 0.169.0' ||
    n.package?.name !== '@openai/codex' ||
    n.package?.version !== '0.169.0' ||
    !n.source?.commit ||
    n.source.dirty !== false ||
    n.containment?.loopback !== true ||
    !['EPERM', 'EACCES'].includes(n.containment.external) ||
    n.cleanup?.rootRemoved !== true ||
    n.cleanup?.drained !== true ||
    !n.receipts?.length ||
    !n.receipts.every((r) => r.drained && !r.error && !r.failure) ||
    n.configUnchanged !== true ||
    n.sentinelsUnexecuted !== true ||
    !['hook', 'mcp', 'plugin'].every((kind) =>
      n.integrationControls?.some(
        (control) =>
          control.kind === kind &&
          typeof control.declaration === 'string' &&
          control.declaration.length > 0 &&
          control.before === false &&
          control.after === false &&
          control.policy === (kind === 'hook' ? 'untrusted' : 'disabled'),
      ),
    ) ||
    n.modelRequests !== 0 ||
    n.modelFailures?.length ||
    !Array.isArray(n.observations) ||
    n.observations.length !== 2
  )
    return false
  for (const [index, observation] of n.observations.entries()) {
    if (
      observation.exitCode !== 0 ||
      typeof observation.stdout !== 'string' ||
      Buffer.byteLength(observation.stdout) > 524288 ||
      typeof observation.stderr !== 'string' ||
      Buffer.byteLength(observation.stderr) > 524288 ||
      !Array.isArray(observation.input) ||
      !observation.argv?.includes('prompt-input') ||
      !observation.cwd ||
      !observation.env?.CODEX_HOME
    )
      return false
    try {
      if (JSON.stringify(JSON.parse(observation.stdout)) !== JSON.stringify(observation.input))
        return false
    } catch {
      return false
    }
    const developers = observation.input
      .filter((item) => item.role === 'developer')
      .map(messageText)
      .join('\n')
    const users = observation.input.filter((item) => item.role === 'user')
    if (
      !developers.includes(index === 0 ? baseText : profileText) ||
      developers.includes(index === 0 ? profileText : baseText) ||
      messageText(users.at(-1) ?? {}) !== prompt
    )
      return false
    if (index === 1 && !observation.argv.includes('--profile')) return false
  }
  return true
}

/** Observe the public debug command without personal state or non-loopback network access. */
export async function runDebugPromptInputCandidate() {
  const report = {
    schema: 'holi.codex-debug-prompt-input.v1',
    outcome: 'incomplete-proof',
    status: 'incomplete',
  }
  const n = (report.native = {
    observations: [],
    receipts: [],
    cleanup: { drained: false, rootRemoved: false },
  })
  const handles = []
  let root, model
  const deadline = Date.now() + 180000
  try {
    if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'))
      throw Error('Verified macOS containment required')
    n.source = {
      repository: await realpath(repository),
      commit: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repository,
        encoding: 'utf8',
      }).trim(),
      dirty: Boolean(
        execFileSync('git', ['status', '--porcelain'], {
          cwd: repository,
          encoding: 'utf8',
        }).trim(),
      ),
    }
    if (n.source.dirty) throw Error('Committed clean source required')
    root = await realpath(await mkdtemp(join(tmpdir(), 'holi807-debug-')))
    n.root = root
    for (const name of ['home', 'codex', 'xdg', 'tmp', 'vault'])
      await mkdir(join(root, name), { mode: 0o700 })
    const env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: join(root, 'home'),
      CODEX_HOME: join(root, 'codex'),
      XDG_CONFIG_HOME: join(root, 'xdg'),
      TMPDIR: join(root, 'tmp'),
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
    }
    for (const file of ['user-npmrc', 'global-npmrc']) await writeFile(join(root, file), '')
    const own = async (command, args, label, extra = {}, timeout = 30000) => {
      const child = await startOwnedPty({
        command,
        args,
        cwd: join(root, 'vault'),
        env: { ...env, ...extra },
        stateDirectory: join(root, label),
        timeoutMs: Math.min(timeout, deadline - Date.now()),
        maxOutputBytes: 524288,
      })
      handles.push(child)
      return child
    }
    const installed = await installPinnedCodex({ root, own })
    n.package = installed.package
    model = await createContextModel()
    const policy = join(root, 'loopback.sb')
    await writeFile(
      policy,
      `(version 1)\n(allow default)\n(deny network*)\n(allow network-outbound (remote tcp "localhost:${model.port}"))\n`,
    )
    const command = async (args, label) => {
      const child = await own(
        '/usr/bin/sandbox-exec',
        ['-f', policy, '--', process.execPath, ...args],
        label,
      )
      return runOwnedCommand(child, label)
    }
    n.containment = JSON.parse(
      await command(
        [
          '--input-type=module',
          '-e',
          `import net from 'node:net';const loopback=(await fetch('http://127.0.0.1:${model.port}/probe')).status===404;const external=await new Promise(resolve=>{const s=net.connect({host:'192.0.2.1',port:80});s.once('error',e=>resolve(e.code));s.once('connect',()=>{s.destroy();resolve('CONNECTED')});setTimeout(()=>{s.destroy();resolve('TIMEOUT')},1000).unref()});console.log(JSON.stringify({loopback,external}))`,
        ],
        'containment',
      ),
    )
    if (!n.containment.loopback || !['EPERM', 'EACCES'].includes(n.containment.external))
      throw Error('External network containment unproven')
    n.version = await command([installed.bin, '--version'], 'version')
    if (n.version !== 'codex-cli 0.169.0') throw Error('Native version mismatch')
    const instructions = join(root, 'model-instructions.txt')
    await writeFile(instructions, 'HOLI807_NATIVE_MODEL_INSTRUCTIONS')
    const common = `model = "gpt-5.1-codex-mini"\nmodel_provider = "holi-fixture"\nmodel_instructions_file = ${JSON.stringify(instructions)}\n[model_providers.holi-fixture]\nname = "Holi fixture"\nbase_url = "http://127.0.0.1:${model.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`
    const files = [
      [join(env.CODEX_HOME, 'config.toml'), `developer_instructions = "${baseText}"\n${common}`],
      [
        join(env.CODEX_HOME, 'fixture.config.toml'),
        `developer_instructions = "${profileText}"\n${common}`,
      ],
      [instructions, 'HOLI807_NATIVE_MODEL_INSTRUCTIONS'],
    ]
    const controls = []
    for (const kind of ['hook', 'mcp', 'plugin']) {
      const sentinel = join(root, `${kind}-executed`)
      const script = join(root, `${kind}-sentinel.mjs`)
      const text = `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(sentinel)},'unexpected')`
      files.push([script, text])
      controls.push({
        kind,
        sentinel,
        script,
        before: existsSync(sentinel),
        policy: kind === 'hook' ? 'untrusted' : 'disabled',
      })
    }
    const script = controls[0].script
    const plugin = join(env.CODEX_HOME, 'plugins/cache/fixture/sentinel/local')
    await mkdir(join(plugin, '.codex-plugin'), { recursive: true })
    const manifest = JSON.stringify({
      name: 'sentinel',
      description: 'Synthetic disabled integration control',
    })
    const pluginMcp = JSON.stringify({
      mcpServers: { sentinel: { command: process.execPath, args: [controls[2].script] } },
    })
    files.push(
      [join(plugin, '.codex-plugin/plugin.json'), manifest],
      [join(plugin, '.mcp.json'), pluginMcp],
    )
    const exclusions = `\n[mcp_servers.holi807]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(controls[1].script)}]\nenabled = false\n[plugins."sentinel@fixture"]\nenabled = false\n`
    files[0][1] += exclusions
    files[1][1] += exclusions
    const hooks = JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
              },
            ],
          },
        ],
      },
    })
    files.push([join(env.CODEX_HOME, 'hooks.json'), hooks])
    controls[0].declaration = hooks
    controls[1].declaration = exclusions
    controls[2].declaration = JSON.stringify({
      manifest,
      mcp: pluginMcp,
      config: '[plugins."sentinel@fixture"] enabled = false',
      root: plugin,
    })
    for (const [path, text] of files) await writeFile(path, text, { mode: 0o600 })
    n.integrationControls = controls
    n.fixtureFiles = files.map(([path, text]) => ({ path, text }))
    for (const [index, args] of [
      [0, [installed.bin, 'debug', 'prompt-input', prompt]],
      [1, [installed.bin, '--profile', 'fixture', 'debug', 'prompt-input', prompt]],
    ]) {
      const wrapper = `await (${captureNativeOutput.toString()})(${JSON.stringify(args)})`
      const result = JSON.parse(
        await command(['--input-type=module', '-e', wrapper], `debug-${index}`),
      )
      const raw = result.stdout
      n.observations.push({
        argv: args,
        cwd: join(root, 'vault'),
        env,
        exitCode: result.exitCode,
        stdout: raw,
        stderr: result.stderr,
        input: JSON.parse(raw),
      })
    }
    n.configUnchanged = (
      await Promise.all(files.map(async ([path, text]) => (await readFile(path, 'utf8')) === text))
    ).every(Boolean)
    n.integrationControls = controls.map((control) => ({
      ...control,
      after: existsSync(control.sentinel),
    }))
    n.sentinelsUnexecuted = n.integrationControls.every(
      (control) => !control.before && !control.after,
    )
    n.modelRequests = model.requests.length
    n.modelFailures = model.failures
    if (model.failures.length) throw Error(model.failures.join('; '))
    n.limitation =
      'debug prompt-input returns Vec<ResponseItem>, not resolved developer_instructions. It constructs an ephemeral SessionSource::Exec session; selecting developer-role text from this generated model-input snapshot does not recover the original effective configuration or establish TUI/resume equivalence. No composition, initial-TUI or resume acceptance is claimed.'
    n.sourceContract = [
      'https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/core/tests/suite/plugins.rs#L118-L243',
      'https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/cli/src/main.rs#L2125-L2232',
      'https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/core/src/prompt_debug.rs',
    ]
  } catch (error) {
    report.error = String(error)
  } finally {
    for (const child of handles) {
      try {
        n.receipts.push(await child.close())
      } catch (error) {
        report.cleanupError = String(error)
      }
    }
    n.cleanup.drained =
      !report.cleanupError &&
      n.receipts.length === handles.length &&
      n.receipts.every((receipt) => receipt.drained) &&
      handles.every((child) => !child.failure)
    if (model) {
      try {
        await model.close()
      } catch (error) {
        report.cleanupError = String(error)
      }
    }
    if (root && n.cleanup.drained && !report.cleanupError) {
      try {
        await rm(root, { recursive: true, force: true })
        n.cleanup.rootRemoved = !existsSync(root)
      } catch (error) {
        report.cleanupError = String(error)
      }
    }
    if (!report.error && !report.cleanupError) {
      const complete = {
        ...report,
        status: 'demonstrated',
        outcome: 'demonstrated-unsupported-path',
      }
      if (validateDebugPromptInputEvidence(complete)) Object.assign(report, complete)
    }
  }
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.env.HOLI_CODEX_DEBUG_EVIDENCE
  if (!output || existsSync(output))
    throw Error('Set HOLI_CODEX_DEBUG_EVIDENCE to a new file outside the checkout')
  const canonicalRepository = await realpath(repository)
  const outputPath = resolve(output)
  const outputParent = await realpath(dirname(outputPath))
  const canonicalOutput = join(outputParent, basename(outputPath))
  if (
    canonicalOutput === canonicalRepository ||
    canonicalOutput.startsWith(canonicalRepository + '/')
  )
    throw Error('Set HOLI_CODEX_DEBUG_EVIDENCE to a new file outside the checkout')
  const report = await runDebugPromptInputCandidate()
  await writeFile(canonicalOutput, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 })
  console.log(
    JSON.stringify({
      output,
      outcome: report.outcome,
      error: report.error,
      cleanup: report.native.cleanup,
    }),
  )
  process.exitCode = report.status === 'demonstrated' ? 0 : 1
}
