import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startOwnedPty } from './pi-native-tui-process.mjs'
import { createContextModel } from './codex-context-model.mjs'
import { installPinnedCodex } from './codex-native-install.mjs'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const clean = (text) =>
  text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')

/** Own isolated native setup, bounded observation and verified cleanup for a context scenario. */
export async function runNativeContextFixture(scenario) {
  const evidence = {
    scenario: 'initialTUI',
    status: 'incomplete',
    classification: 'setup-unavailable',
    consent: [],
    trustChanges: [],
    hooks: [],
    requests: [],
    argv: [],
    receipts: [],
    drainage: false,
  }
  const handles = []
  let root, model
  const deadline = Date.now() + 180000
  try {
    if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'))
      throw Error('Verified macOS containment required')
    evidence.source = {
      repository: await realpath(repositoryRoot),
      commit: execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8',
        cwd: repositoryRoot,
      }).trim(),
      dirty: Boolean(
        execFileSync('git', ['status', '--porcelain'], {
          encoding: 'utf8',
          cwd: repositoryRoot,
        }).trim(),
      ),
    }
    root = await realpath(await mkdtemp(join(tmpdir(), 'holi764-native-')))
    evidence.root = root
    for (const name of ['home', 'person', 'xdg', 'tmp', 'vault'])
      await mkdir(join(root, name), { mode: 0o700 })
    const env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: join(root, 'home'),
      CODEX_HOME: join(root, 'person'),
      XDG_CONFIG_HOME: join(root, 'xdg'),
      TMPDIR: join(root, 'tmp'),
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
    }
    await writeFile(join(root, 'user-npmrc'), '')
    await writeFile(join(root, 'global-npmrc'), '')
    const own = async (command, args, label, extra = {}, timeout = 30000) => {
      const child = await startOwnedPty({
        command,
        args,
        cwd: join(root, 'vault'),
        env: { ...env, ...extra },
        stateDirectory: join(root, label),
        timeoutMs: Math.min(timeout, deadline - Date.now()),
        maxOutputBytes: 524288,
        terminalSize: { rows: 50, columns: 240 },
      })
      handles.push(child)
      evidence.argv.push({
        label,
        command,
        args,
        cwd: join(root, 'vault'),
        codeHome: extra.CODEX_HOME ?? env.CODEX_HOME,
      })
      return child
    }
    const { bin, package: pkg } = await installPinnedCodex({ root, own })
    evidence.package = pkg
    model = await createContextModel()
    evidence.modelPort = model.port
    evidence.requests = model.requests
    const policy = join(root, 'loopback.sb')
    await writeFile(
      policy,
      `(version 1)\n(allow default)\n(deny network*)\n(allow network-outbound (remote tcp "localhost:${model.port}"))\n`,
    )
    const launch = (args, label, extra = {}) =>
      own('/usr/bin/sandbox-exec', ['-f', policy, '--', process.execPath, ...args], label, extra)
    const command = async (args, label) => {
      const child = await launch(args, label)
      if ((await child.waitForExit()).code !== 0)
        throw Error(`${label} failed: ${clean(child.output.toString()).slice(-4000)}`)
      await child.close()
      return clean(child.output.toString()).trim()
    }
    evidence.containment = JSON.parse(
      await command(
        [
          '--input-type=module',
          '-e',
          `import net from 'node:net';const loopback=(await fetch('http://127.0.0.1:${model.port}/probe')).status===404;const external=await new Promise(resolve=>{const s=net.connect({host:'192.0.2.1',port:80});s.once('error',e=>resolve(e.code));s.once('connect',()=>{s.destroy();resolve('CONNECTED')});setTimeout(()=>{s.destroy();resolve('TIMEOUT')},1000).unref()});console.log(JSON.stringify({loopback,external}))`,
        ],
        'containment',
      ),
    )
    if (
      !evidence.containment.loopback ||
      !['EPERM', 'EACCES'].includes(evidence.containment.external)
    )
      throw Error('External network containment unproven')
    evidence.version = await command([bin, '--version'], 'version')
    if (evidence.version !== 'codex-cli 0.169.0') throw Error('Native version mismatch')
    evidence.classification = 'incomplete-proof'
    const replies = new WeakMap()
    const wait = async (child, predicate, label) => {
      const until = Math.min(deadline, Date.now() + 12000)
      const answered = replies.get(child) ?? { cursors: 0, devices: 0, colors: 0 }
      replies.set(child, answered)
      while (Date.now() < until) {
        if (child.failure) throw child.failure
        const output = child.output.toString()
        if (predicate(clean(output))) return
        if (child.nativeExit) throw Error(`${label}: native exited`)
        const count = (sequence) => output.split(sequence).length - 1
        if (count('\u001b[6n') > answered.cursors) {
          answered.cursors = count('\u001b[6n')
          await child.write('\u001b[1;1R')
        }
        if (count('\u001b[c') > answered.devices) {
          answered.devices = count('\u001b[c')
          await child.write('\u001b[?1;2c')
        }
        if (count('\u001b]11;?') > answered.colors) {
          answered.colors = count('\u001b]11;?')
          await child.write(
            '\u001b]10;rgb:ffff/ffff/ffff\u001b\\\u001b]11;rgb:0000/0000/0000\u001b\\',
          )
        }
        await delay(100)
      }
      throw Error(`Native observation deadline: ${label}`)
    }
    const send = async (child, label, bytes) => {
      evidence.consent.push({ label, offset: child.output.length, bytes: [...Buffer.from(bytes)] })
      await child.write(bytes)
    }
    await scenario({ root, env, bin, launch, model, evidence, wait, send, delay })
  } catch (error) {
    evidence.error = String(error)
    evidence.status = 'incomplete'
    if (evidence.classification !== 'setup-unavailable')
      evidence.classification = 'incomplete-proof'
  } finally {
    for (const child of handles) {
      try {
        evidence.receipts.push(await child.close())
      } catch (error) {
        evidence.cleanupError = String(error)
      }
    }
    evidence.outputs = handles.map((child, index) => ({
      launch: evidence.argv[index],
      transcript: child.output.toString(),
      failure: child.failure?.message,
      exit: child.nativeExit,
    }))
    evidence.drainage =
      !evidence.cleanupError &&
      evidence.receipts.length === handles.length &&
      evidence.receipts.every((receipt) => receipt.drained)
    if (model) {
      try {
        await model.close()
        evidence.modelClosed = true
      } catch (error) {
        evidence.cleanupError = String(error)
      }
    }
    if (root && evidence.drainage && !evidence.cleanupError) {
      try {
        await rm(root, { recursive: true, force: true })
        evidence.rootRemoved = !existsSync(root)
      } catch (error) {
        evidence.cleanupError = String(error)
        evidence.rootRemoved = false
      }
    }
    if (!root) evidence.rootRemoved = true
    if (!evidence.drainage || !evidence.rootRemoved || handles.some((child) => child.failure)) {
      evidence.status = 'incomplete'
      evidence.classification = 'incomplete-proof'
    }
  }
  return evidence
}
