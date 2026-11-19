import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startOwnedPty } from './pi-native-tui-process.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageName = '@earendil-works/pi-coding-agent'
const supportedVersion = '1.5.2'
// Reviewed against the official npm tarball's SHA-512, not a version-shaped executable.
const reviewedBundleDigest = 'c08ad70f102c06cb05809284d0ecc698c52320da4bf58e124c681b0b068747aa'
const tarballIntegrity =
  'sha512-mUWI04rqF1Vd/m1q+Ps1XeWsTXEVvRUnsmRa83I3Dzua0Tx5bYS93imeqtIfrXf7PkkaR6ERz+AuQhIJlom5yA=='
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const plain = (bytes) =>
  bytes.toString().replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g, '')

class FixtureError extends Error {
  constructor(message, outcome = 'unverified') {
    super(message)
    this.outcome = outcome
  }
}

/** Inspect package bytes without executing producer code. */
export async function verifyPiProvenance({ bin, expectedVersion }) {
  if (!bin || !expectedVersion) throw new Error('Pi binary and exact expected version are required')
  let executable
  try {
    executable = realpathSync(bin)
  } catch {
    throw new FixtureError('Pi package provenance unavailable')
  }
  let directory = dirname(executable),
    manifest,
    manifestPath
  for (let depth = 0; depth < 8; depth++) {
    manifestPath = join(directory, 'package.json')
    try {
      const candidate = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (candidate.name === packageName) {
        manifest = candidate
        break
      }
    } catch {}
    directory = dirname(directory)
  }
  if (!manifest) throw new FixtureError('Pi package provenance unavailable')
  if (manifest.version !== expectedVersion || executable !== join(directory, 'dist/bundle/cli.js'))
    throw new FixtureError('Pi package identity/version or entrypoint mismatch', 'mismatch')
  const files = []
  const collect = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) collect(path)
      else if (entry.name.endsWith('.js')) files.push(path)
    }
  }
  collect(join(directory, 'dist/bundle'))
  const digest = createHash('sha256')
    .update(readFileSync(manifestPath))
    .update(readFileSync(executable))
  for (const path of files.sort())
    digest.update(path.slice(directory.length + 1)).update(readFileSync(path))
  return {
    executable,
    packageDirectory: directory,
    package: packageName,
    version: manifest.version,
    packageDigest: digest.digest('hex'),
    packageSource: manifest.repository,
    sourceCommit: manifest.gitHead ?? null,
    sourceCommitAvailable: Boolean(manifest.gitHead),
  }
}

function sourceEvidence(directory) {
  const core = 'dist/bundle/chunks/chunk-VEJDBY3O.js'
  const trust = 'dist/bundle/chunks/chunk-MMDXLZVS.js'
  return [
    [
      core,
      'function formatProjectTrustPrompt(',
      'Project trust has a native selector; cancelling returns untrusted.',
    ],
    [
      trust,
      'function getProjectTrustOptions(',
      'Trust and Do not trust are distinct native choices.',
    ],
    [
      core,
      'async showExtensionConfirm(',
      'Extension confirmations are native Yes/No selectors classified as permission UI.',
    ],
    [
      core,
      'async _beforeToolCall(',
      'Extension tool_call handlers can block a tool; exceptions also block execution.',
    ],
    [
      core,
      'async function executePreparedToolCall(',
      'Prepared core tools execute directly; extensions supply optional per-tool policy.',
    ],
    [core, '"app.clear":', 'The default Ctrl+C binding clears the native editor.'],
  ].map(([file, marker, meaning]) => {
    const bytes = readFileSync(join(directory, file)),
      text = bytes.toString(),
      index = text.indexOf(marker)
    if (index < 0)
      throw new FixtureError(`Reviewed Pi source marker missing: ${marker}`, 'mismatch')
    return {
      file,
      sha256: sha256(bytes),
      byteOffset: Buffer.byteLength(text.slice(0, index)),
      meaning,
      excerpt: text.slice(index, index + 900),
    }
  })
}

export function isolatedEnvironment({ home, root, profile }) {
  return {
    PATH: process.env.PATH ?? '',
    HOME: home,
    PI_CODING_AGENT_DIR: profile,
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_DATA_HOME: join(root, 'xdg-data'),
    TMPDIR: root,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    PI_OFFLINE: '1',
    NO_COLOR: '1',
    OPENAI_API_KEY: 'local-only-fixture-key',
  }
}

/** A held first model response and complete recovery responses, all synthetic. */
export function createLocalModelServer() {
  const requests = [],
    streams = []
  let count = 0
  const server = createServer((request, response) => {
    if (++count > 20) {
      response.writeHead(429).end()
      return
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    const chunks = []
    let bytes = 0,
      rejected = false
    request.on('error', () => {})
    response.on('error', () => {})
    request.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > 65536) {
        rejected = true
        response.writeHead(413).end()
        request.destroy()
      } else chunks.push(chunk)
    })
    request.on('end', () => {
      if (rejected || response.destroyed) return
      let body
      try {
        body = JSON.parse(Buffer.concat(chunks).toString())
      } catch {
        response.writeHead(400).end()
        return
      }
      if (
        !body ||
        !Array.isArray(body.messages) ||
        !['fixture-model', 'fixture-model-two'].includes(body.model)
      ) {
        response.writeHead(400).end()
        return
      }
      requests.push(body)
      const stream = { ordinal: requests.length, started: true, closed: false, completed: false }
      streams.push(stream)
      response.on('close', () => {
        stream.closed = true
      })
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'close',
      })
      const content =
        stream.ordinal === 1
          ? 'Held-open synthetic response.'
          : 'Native fixture says hello. allow this tool [1] Yes [2] No. https://example.invalid/fixture'
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
      if (stream.ordinal === 1) return
      stream.completed = true
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
      )
      response.end('data: [DONE]\n\n')
    })
  })
  server.requestTimeout = 5000
  server.headersTimeout = 5000
  server.keepAliveTimeout = 100
  return { server, requests, streams }
}

async function waitFor(handle, predicate, label, timeout = 10000) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (handle?.failure) throw handle.failure
    if (handle?.nativeExit) throw new FixtureError(`Pi exited while waiting for ${label}`)
    if (Date.now() >= deadline) throw new FixtureError(`Timed out waiting for ${label}`)
    await delay(20)
  }
  if (handle?.failure) throw handle.failure
}

/** Credential-free native proof. Renderer hint discovery is a later consumer. */
export async function runPiNativeTuiFixture({
  bin,
  expectedVersion,
  artifactDirectory,
  timeout = 45000,
}) {
  if (!bin || !expectedVersion || !artifactDirectory || !Number.isFinite(timeout) || timeout <= 0)
    throw new Error(
      'Pi binary, exact expected version, outside-repository artifacts and positive timeout required',
    )
  const artifacts = resolve(artifactDirectory)
  if (artifacts === repositoryRoot || artifacts.startsWith(`${repositoryRoot}/`))
    throw new Error('Native Pi TUI artifacts must be stored outside the repository')
  mkdirSync(artifacts, { recursive: true, mode: 0o700 })
  const processes = [],
    processReceipts = [],
    actions = [],
    inputs = []
  const deadline = Date.now() + timeout
  let root,
    fixture,
    tui,
    provenance,
    evidence,
    error,
    cleanupError,
    scenarioPassed = false
  const source = {
    commit: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }).trim(),
    dirty: Boolean(
      execFileSync('git', ['status', '--porcelain'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
      }).trim(),
    ),
  }
  try {
    // No producer or setup subprocess runs on platforms without verified containment.
    if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'))
      throw new FixtureError('Native TUI proof requires verified macOS Seatbelt containment')
    if (expectedVersion !== supportedVersion)
      throw new FixtureError('This fixture pins upstream Pi 1.5.2', 'mismatch')
    provenance = await verifyPiProvenance({ bin, expectedVersion })
    if (provenance.packageDigest !== reviewedBundleDigest)
      throw new FixtureError(
        'Upstream Pi bundle does not match the reviewed official npm release',
        'mismatch',
      )
    const approvalSource = sourceEvidence(provenance.packageDirectory)
    root = mkdtempSync(join(tmpdir(), 'holi-660-runtime-'))
    const home = join(root, 'home'),
      profile = join(root, 'profile'),
      vault = join(root, 'vault')
    for (const path of [home, profile, vault]) mkdirSync(path, { mode: 0o700 })
    fixture = createLocalModelServer()
    await new Promise((resolveListen, reject) => {
      fixture.server.once('error', reject)
      fixture.server.listen(0, '127.0.0.1', resolveListen)
    })
    const port = fixture.server.address().port
    const sandbox = join(root, 'loopback.sb')
    writeFileSync(
      sandbox,
      `(version 1)\n(allow default)\n(deny network*)\n(allow network-outbound (remote tcp "localhost:${port}"))\n`,
    )
    const env = isolatedEnvironment({ home, root, profile })
    const launch = async (args, label, budget = timeout) => {
      budget = Math.min(budget, deadline - Date.now())
      if (budget <= 0) throw new FixtureError('Overall native fixture deadline exceeded')
      const handle = await startOwnedPty({
        command: '/usr/bin/sandbox-exec',
        args: ['-f', sandbox, '--', process.execPath, ...args],
        cwd: vault,
        env,
        stateDirectory: join(root, label),
        timeoutMs: budget,
      })
      processes.push(handle)
      return handle
    }
    const command = async (args, label) => {
      const handle = await launch(args, label, 5000)
      const exit = await handle.waitForExit()
      await handle.close()
      if (handle.failure) throw handle.failure
      if (exit.code !== 0 || exit.signal !== null)
        throw new FixtureError(`${label} failed: ${plain(handle.output).slice(-2000)}`)
      return plain(handle.output).trim()
    }
    // This subprocess has the same network policy as the version probe and TUI.
    const probe = JSON.parse(
      await command(
        [
          '--input-type=module',
          '-e',
          `import net from 'node:net'; const loopback=(await fetch('http://127.0.0.1:${port}/probe')).status===404;
const external=await new Promise(resolve=>{const s=net.connect({host:'192.0.2.1',port:80});s.once('error',e=>resolve(e.code));s.once('connect',()=>{s.destroy();resolve('CONNECTED')});setTimeout(()=>{s.destroy();resolve('TIMEOUT')},1000).unref()});console.log(JSON.stringify({loopback,external}));`,
        ],
        'containment',
      ),
    )
    if (!probe.loopback || !['EPERM', 'EACCES'].includes(probe.external))
      throw new FixtureError(`Containment not proven: ${JSON.stringify(probe)}`)
    const observedVersion = await command([provenance.executable, '--version'], 'version')
    if (observedVersion !== expectedVersion)
      throw new FixtureError(`Native version mismatch: ${observedVersion}`, 'mismatch')
    const models = ['fixture-model', 'fixture-model-two'].map((id) => ({
      id,
      name: id,
      contextWindow: 8192,
      maxTokens: 256,
    }))
    writeFileSync(
      join(profile, 'models.json'),
      JSON.stringify({
        providers: {
          openai: {
            api: 'openai-completions',
            baseUrl: `http://127.0.0.1:${port}/v1`,
            apiKey: 'local-only-fixture-key',
            models,
          },
        },
      }),
    )
    writeFileSync(
      join(profile, 'settings.json'),
      JSON.stringify({
        defaultProvider: 'openai',
        defaultModel: 'fixture-model',
        enableInstallTelemetry: false,
        enableAnalytics: false,
      }),
    )
    const extension = join(vault, '.pi/extensions')
    mkdirSync(extension, { recursive: true })
    const sentinel = join(vault, 'extension-executed')
    writeFileSync(
      join(extension, 'fixture.ts'),
      `import {writeFileSync} from 'node:fs'; export default function(){writeFileSync(${JSON.stringify(sentinel)},'unexpected')}`,
    )
    tui = await launch(
      [
        provenance.executable,
        '--model',
        'openai/fixture-model',
        '--models',
        'openai/fixture-model,openai/fixture-model-two',
        '--session-dir',
        join(profile, 'sessions'),
        '--no-tools',
        '--no-extensions',
        '--no-skills',
        '--no-prompt-templates',
        '--no-context-files',
        '--no-mcp',
      ],
      'tui',
    )
    const send = async (label, bytes) => {
      const input = { label, bytes: [...Buffer.from(bytes)], beforeBytes: tui.output.length }
      inputs.push(input)
      await tui.write(bytes)
      await delay(150)
      input.afterBytes = tui.output.length
    }
    await waitFor(
      tui,
      () => plain(tui.output).includes('Trust project folder?'),
      'native project trust selector',
    )
    await send('deny-project-trust', '\u001b')
    await waitFor(
      tui,
      () => plain(tui.output).includes('Use /trust to save a trust decision'),
      'native editor after trust cancellation',
    )
    if (existsSync(sentinel)) throw new FixtureError('Untrusted project extension executed')
    actions.push({
      action: 'project-trust-cancel',
      status: 'pass',
      nativeSelectorObserved: true,
      extensionExecuted: false,
    })
    await send('plain-f-input', 'f held-open cancellation\r')
    await waitFor(
      tui,
      () =>
        fixture.streams[0]?.started && plain(tui.output).includes('Held-open synthetic response.'),
      'active native response',
    )
    if (fixture.streams[0].closed || fixture.streams[0].completed)
      throw new FixtureError('Cancellation stream was not active')
    await send('escape-cancel', '\u001b')
    await waitFor(tui, () => fixture.streams[0].closed, 'native stream cancellation')
    actions.push({
      action: 'escape-cancels-active-response',
      status: 'pass',
      stream: { ...fixture.streams[0] },
    })
    await send('draft-to-clear', 'DISPOSABLE_DRAFT_MUST_BE_CLEARED')
    await send('ctrl-c-clear', '\u0003')
    await send('recovery', 'f native recovery\r')
    await waitFor(
      tui,
      () =>
        fixture.requests.length === 2 && plain(tui.output).includes('Native fixture says hello.'),
      'native recovery',
    )
    const lastUser = (body) => {
      const content = body.messages.filter((message) => message.role === 'user').at(-1)?.content
      if (typeof content === 'string') return content
      if (Array.isArray(content) && content.every((part) => part.type === 'text'))
        return content.map((part) => part.text).join('')
      throw new FixtureError('Unexpected non-text native prompt content')
    }
    if (
      lastUser(fixture.requests[0]) !== 'f held-open cancellation' ||
      lastUser(fixture.requests[1]) !== 'f native recovery'
    )
      throw new FixtureError(
        `Native input or Ctrl+C draft clearing mismatch: ${JSON.stringify(fixture.requests.map(lastUser))}`,
      )
    actions.push({
      action: 'plain-f-and-ctrl-c-clear-recovery',
      status: 'pass',
      submitted: fixture.requests.map(lastUser),
    })
    const cycleStart = tui.output.length
    await send('ctrl-p-cycle', '\u0010')
    await waitFor(
      tui,
      () => plain(tui.output.subarray(cycleStart)).includes('Switched to fixture-model-two'),
      'native model cycle',
    )
    actions.push({
      action: 'native-model-cycle',
      status: 'pass',
      model: 'fixture-model-two',
      byteOffset: cycleStart,
    })
    await send('native-exit', '\u0004')
    const exit = await tui.waitForExit()
    await tui.close()
    if (tui.failure) throw tui.failure
    if (exit.code !== 0 || exit.signal !== null)
      throw new FixtureError(`Unexpected native exit: ${JSON.stringify(exit)}`)
    if (existsSync(sentinel))
      throw new FixtureError('Project extension ran after trust cancellation')
    const output = tui.output.toString()
    const terminalLinks = [
      ...output.matchAll(/\u001b\]8;[^;]*;([^\u0007\u001b]+)(?:\u0007|\u001b\\)/g),
    ].map((match) => match[1])
    evidence = {
      provenance: {
        ...provenance,
        observedVersion,
        officialTarballIntegrity: tarballIntegrity,
        officialTarball:
          'https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-1.5.2.tgz',
      },
      scenario: 'native-interactive-pi-tui',
      source,
      actions,
      inputs,
      nativeExit: exit,
      transport: {
        policy:
          'Seatbelt inherited by native children; deny all network except fixture loopback port',
        probe,
        modelRequests: fixture.requests.length,
        models: fixture.requests.map((request) => request.model),
      },
      nativeControls: {
        projectTrust: 'Native selector observed and cancelled with Escape; no affirmative input.',
        keyboardOnly: ['editor clear', 'cancel response', 'cycle model', 'exit'],
        osc8Links: terminalLinks,
      },
      approval: {
        sourceEvidence: approvalSource,
        defaultToolPolicy:
          'Core prepared tools execute directly; extension tool_call handlers can block or ask through native UI.',
        runtime:
          'Project trust denial exercised. Tools and extensions disabled; extension confirmation and per-tool extension policy not exercised.',
      },
      unsupported: [
        'No mouse/hint target geometry or renderer presentation epoch proof in this PTY fixture.',
        'Approval-looking model text is transcript content, never a control target.',
        'Extension-provided permission UI and arbitrary user profiles remain untested.',
      ],
      ownership:
        'Fixture-owned PTY and upstream native process; persisted synthetic sessions, not a renderer session binding.',
      output: {
        bytes: tui.output.length,
        artifact: 'terminal-output.bin',
        sha256: sha256(tui.output),
      },
    }
    scenarioPassed = true
  } catch (caught) {
    error = caught
  } finally {
    for (const process of processes.reverse()) {
      try {
        processReceipts.push(await process.close())
      } catch (caught) {
        cleanupError ??= caught
      }
    }
    if (fixture) {
      try {
        await new Promise((resolveClose, reject) => {
          fixture.server.close((caught) => (caught ? reject(caught) : resolveClose()))
          fixture.server.closeAllConnections()
        })
      } catch (caught) {
        cleanupError ??= caught
      }
    }
    if (root && !cleanupError) {
      try {
        rmSync(root, { recursive: true, force: true })
      } catch (caught) {
        cleanupError = caught
      }
    }
  }
  if (tui) writeFileSync(join(artifacts, 'terminal-output.bin'), tui.output)
  const cleanup = {
    processes: processReceipts,
    runtimeRemoved: !root || !existsSync(root),
    serverClosed: !fixture || !fixture.server.listening,
    ...(cleanupError ? { error: cleanupError.message, retainedRuntimePath: root } : {}),
  }
  const result = {
    schemaVersion: 2,
    outcome: scenarioPassed && !cleanupError ? 'pass' : (error?.outcome ?? 'unverified'),
    ...(error || cleanupError ? { detail: (error ?? cleanupError).message } : {}),
    source,
    evidence,
    cleanup,
  }
  writeFileSync(join(artifacts, 'receipt.json'), JSON.stringify(result, null, 2))
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [bin, expectedVersion, artifactDirectory] = process.argv.slice(2)
    const result = await runPiNativeTuiFixture({ bin, expectedVersion, artifactDirectory })
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (result.outcome !== 'pass') process.exitCode = 1
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
