import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { resolveNativeBinary } from './claude-compatibility.mjs'
import { publishFixtureArtifacts } from './pi-native-tui-fixture.mjs'
import { startOwnedPty } from './pi-native-tui-process.mjs'

const repository = fileURLToPath(new URL('..', import.meta.url))
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function isolatedEnvironment({ root, home, config }) {
  return {
    PATH: '/usr/bin:/bin',
    HOME: home,
    CLAUDE_CONFIG_DIR: config,
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_DATA_HOME: join(root, 'xdg-data'),
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    TERM: 'xterm-256color',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
  }
}

/** Diagnose native trust denial; this does not establish post-trust terminal identity. */
export async function runClaudeNativeTuiFixture({
  install,
  version,
  artifactDirectory,
  timeout = 15000,
} = {}) {
  if (!install || version !== '2.1.319' || !artifactDirectory)
    throw new TypeError('Exact Claude 2.1.319 install and outside-repository artifacts required')
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 15000)
    throw new TypeError('timeout must be between 1 and 15000 milliseconds')
  const source = {
    commit: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repository,
      encoding: 'utf8',
    }).trim(),
    dirty: Boolean(
      execFileSync('git', ['status', '--porcelain'], { cwd: repository, encoding: 'utf8' }).trim(),
    ),
  }
  // Validate artifact confinement before creating a process or runtime directory.
  publishFixtureArtifacts({ artifactDirectory, result: { outcome: 'unverified', source } })
  const processes = [],
    processReceipts = [],
    inputs = [],
    requests = []
  const deadline = Date.now() + timeout
  let root, server, tui, detail, provenance, containment, denial, cleanupError
  const launch = async (command, args, env, label) => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('Overall native fixture deadline exceeded')
    const handle = await startOwnedPty({
      command: '/usr/bin/sandbox-exec',
      args: ['-f', join(root, 'policy.sb'), '--', command, ...args],
      cwd: join(root, 'vault'),
      env,
      stateDirectory: join(root, label),
      timeoutMs: remaining,
      maxOutputBytes: 262144,
    })
    processes.push(handle)
    return handle
  }
  try {
    if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'))
      throw new Error('Verified macOS Seatbelt containment required')
    const binary = await resolveNativeBinary(install, version)
    const manifest = await readFile(join(dirname(binary), 'package.json'))
    provenance = {
      package: JSON.parse(manifest).name,
      version,
      packageManifestSha256: digest(manifest),
      binarySha256: digest(await readFile(binary)),
      registry: 'https://registry.npmjs.org/',
    }
    root = await realpath(await mkdtemp(join(tmpdir(), 'holi-661-runtime-')))
    const home = join(root, 'home'),
      config = join(root, 'config')
    for (const directory of [home, config, join(root, 'vault')])
      await mkdir(directory, { mode: 0o700 })
    // Onboarding/theme preferences are not workspace trust or permission grants.
    await writeFile(
      join(config, '.claude.json'),
      JSON.stringify({
        hasCompletedOnboarding: true,
        theme: 'dark',
        autoUpdates: false,
      }),
      { mode: 0o600, flag: 'wx' },
    )
    server = createServer((request, response) => {
      request.resume()
      if (request.url !== '/probe')
        requests.push({ method: request.method, url: request.url?.slice(0, 256) })
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{}')
      if (requests.length > 16) server.closeAllConnections()
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const port = server.address().port
    await writeFile(
      join(root, 'policy.sb'),
      `(version 1)
(allow default)
(deny network*)
(allow network-outbound (remote tcp "localhost:${port}"))
(deny file-read* (subpath "/Users") (subpath "/Library/Keychains"))
(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc"))
`,
      { mode: 0o600, flag: 'wx' },
    )
    const env = isolatedEnvironment({ root, home, config })
    const probe = await launch(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
import net from 'node:net';
const local=(await fetch('http://127.0.0.1:${port}/probe')).status===404;
const denied=await new Promise(resolve=>{const s=net.connect({host:'192.0.2.1',port:80});const done=value=>{s.destroy();resolve(value)};s.once('error',e=>done(e.code));s.once('connect',()=>done('CONNECTED'));setTimeout(()=>done('TIMEOUT'),1000).unref()});
console.log(JSON.stringify({local,denied}));`,
      ],
      env,
      'containment',
    )
    const probeExit = await probe.waitForExit()
    await probe.close()
    containment = JSON.parse(stripVTControlCharacters(probe.output.toString()).trim())
    if (
      probeExit.code !== 0 ||
      !containment.local ||
      !['EPERM', 'EACCES'].includes(containment.denied)
    )
      throw new Error('Network containment not positively established')
    const versionProbe = await launch(binary, ['--version'], env, 'version')
    const versionExit = await versionProbe.waitForExit()
    await versionProbe.close()
    provenance.observedVersion = stripVTControlCharacters(versionProbe.output.toString()).trim()
    if (versionExit.code !== 0 || provenance.observedVersion !== `${version} (Claude Code)`)
      throw new Error('Native version does not match the fixture contract')
    tui = await launch(
      binary,
      [],
      {
        ...env,
        ANTHROPIC_API_KEY: 'synthetic-local-fixture-not-a-credential',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      },
      'tui',
    )
    for (;;) {
      if (tui.failure) throw tui.failure
      const plain = stripVTControlCharacters(tui.output.toString()).replace(/\s/g, '')
      if (
        plain.includes('Quicksafetycheck:Isthisaprojectyoucreatedoroneyoutrust?') &&
        plain.includes('❯No,exit') &&
        plain.includes('Yes,Itrustthisfolder')
      )
        break
      if (tui.nativeExit)
        throw new Error('Native process exited before the expected trust selector')
      if (Date.now() >= deadline) throw new Error('Native trust selector deadline exceeded')
      await delay(20)
    }
    if (requests.length) throw new Error('Unexpected model request before native trust selection')
    // This is the pinned upstream startup selector before any model content exists.
    // Confirm its selected negative choice only; never select or persist affirmative trust.
    inputs.push({
      action: 'confirm-native-default-denial',
      bytes: [13],
      outputOffset: tui.output.length,
    })
    await tui.write('\r')
    const exit = await tui.waitForExit()
    denial = { nativeSelectorObserved: true, nativeExit: exit, selected: 'No, exit' }
    if (exit.code !== 1 || requests.length) throw new Error('Native trust denial outcome mismatch')
    detail =
      'Native workspace trust denial exits. Affirmative trust is prohibited; post-trust ownership and controls remain unverified.'
  } catch (error) {
    detail = error.message.slice(0, 1000)
  } finally {
    for (const handle of processes.reverse()) {
      try {
        processReceipts.push(await handle.close())
      } catch (error) {
        cleanupError ??= error
      }
    }
    if (server?.listening) {
      try {
        await new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
          server.closeAllConnections()
        })
      } catch (error) {
        cleanupError ??= error
      }
    }
    if (root && !cleanupError) {
      try {
        await rm(root, { recursive: true, force: true })
      } catch (error) {
        cleanupError = error
      }
    }
  }
  const output = tui?.output ?? Buffer.alloc(0)
  const result = {
    outcome: 'unverified',
    source,
    detail,
    provenance,
    containment,
    denial,
    nativeLaunched: Boolean(tui),
    inputs,
    requests,
    ownership: { currentSession: null, targets: [] },
    remaining: [
      'post-trust typing, cancellation and shortcuts',
      'native session identity through navigation/resume',
      'native link/control provenance and consumed integration',
    ],
    output: { bytes: output.length, sha256: digest(output), artifact: 'terminal-output.bin' },
    cleanup: {
      processes: processReceipts,
      runtimeRemoved: !root || !existsSync(root),
      serverClosed: !server?.listening,
      ...(cleanupError ? { error: cleanupError.message, retainedRuntime: root } : {}),
    },
  }
  publishFixtureArtifacts({ artifactDirectory, result, terminalOutput: output })
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [install, version, artifactDirectory] = process.argv.slice(2)
  try {
    const receipt = await runClaudeNativeTuiFixture({ install, version, artifactDirectory })
    process.stdout.write(`${JSON.stringify(receipt)}\n`)
  } catch (error) {
    process.stderr.write(`${error.message.slice(0, 1000)}\n`)
  }
  process.exitCode = 1
}
