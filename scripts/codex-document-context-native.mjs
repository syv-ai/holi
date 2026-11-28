#!/usr/bin/env node
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { startOwnedPty } from './pi-native-tui-process.mjs'
import { createContextModel } from './codex-context-model.mjs'
import { schema, validateDocumentContextProof } from './codex-document-context.mjs'

const pause = (ms) => new Promise((done) => setTimeout(done, ms))
const clean = (s) =>
  s
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
const hash = (s) => createHash('sha256').update(s).digest('hex')
const text = (message) =>
  typeof message?.content === 'string'
    ? message.content
    : (message?.content ?? []).map((part) => part.text ?? '').join('')

/** Capture native developer context without using a person's configuration or credentials. */
export async function runNativeDocumentContext({ binary = process.env.CODEX_BIN, output } = {}) {
  if (!binary || !output) throw Error('Supply CODEX_BIN and an explicit output directory')
  if (process.platform !== 'darwin')
    throw Error('This fixture requires macOS sandbox-exec containment')
  await access('/usr/bin/sandbox-exec')
  binary = await realpath(binary)
  await access(binary)
  const executable = await readFile(binary)
  if (
    !['cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(
      executable.subarray(0, 4).toString('hex'),
    )
  ) {
    throw Error('CODEX_BIN must name the native Mach-O executable, not a JavaScript launcher')
  }
  output = resolve(output)
  // Never overwrite a previous proof or its failure diagnostics.
  await mkdir(output, { recursive: false, mode: 0o700 })
  const proof = {
    schema,
    status: 'incomplete',
    provenance: { binary, binaryHash: hash(executable), launches: [] },
    consent: {},
    cleanup: { receipts: [], serverClosed: false, rootRemoved: false },
  }
  let root, model
  const children = []
  const deadline = Date.now() + 180000
  try {
    root = await realpath(await mkdtemp(join(tmpdir(), 'holi808-context-')))
    const dirs = Object.fromEntries(
      ['home', 'codex', 'vault', 'tmp', 'xdg'].map((name) => [name, join(root, name)]),
    )
    for (const path of Object.values(dirs)) await mkdir(path, { mode: 0o700 })
    const env = {
      PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
      HOME: dirs.home,
      CODEX_HOME: dirs.codex,
      XDG_CONFIG_HOME: dirs.xdg,
      TMPDIR: dirs.tmp,
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
    }
    model = await createContextModel()
    const policy = join(root, 'network.sb')
    await writeFile(
      policy,
      `(version 1)\n(allow default)\n(deny network*)\n(allow network-outbound (remote tcp "localhost:${model.port}"))\n`,
    )
    const launch = async (command, args, label) => {
      const invocation = {
        command: '/usr/bin/sandbox-exec',
        args: ['-f', policy, '--', command, ...args],
        cwd: dirs.vault,
        env,
      }
      const child = await startOwnedPty({
        ...invocation,
        stateDirectory: join(root, label),
        timeoutMs: Math.max(1, deadline - Date.now()),
        maxOutputBytes: 1048576,
        terminalSize: { rows: 50, columns: 240 },
      })
      children.push(child)
      proof.provenance.launches.push(invocation)
      return child
    }
    const command = async (executable, args, label) => {
      const child = await launch(executable, args, label)
      const exit = await child.waitForExit()
      if (exit.code !== 0)
        throw Error(`${label} failed: ${clean(child.output.toString()).slice(-3000)}`)
      await child.close()
      return clean(child.output.toString()).trim()
    }
    proof.containment = JSON.parse(
      await command(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import net from 'node:net';const loopback=(await fetch('http://127.0.0.1:${model.port}/probe')).status===404;const external=await new Promise(done=>{const s=net.connect({host:'192.0.2.1',port:80});s.once('error',e=>done(e.code));s.once('connect',()=>{s.destroy();done('CONNECTED')});setTimeout(()=>{s.destroy();done('TIMEOUT')},1000).unref()});console.log(JSON.stringify({loopback,external}))`,
        ],
        'containment',
      ),
    )
    if (!proof.containment.loopback || !['EPERM', 'EACCES'].includes(proof.containment.external))
      throw Error('External network denial was not demonstrated')
    proof.provenance.version = await command(binary, ['--version'], 'version')
    if (proof.provenance.version !== 'codex-cli 0.169.0')
      throw Error(`Expected codex-cli 0.169.0; observed ${proof.provenance.version}`)
    proof.provenance.commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    const nonce = randomUUID()
    proof.expected = {
      developer: `HOLI808_PROFILE_${nonce}`,
      excluded: `HOLI808_BASE_${nonce}`,
      model: `HOLI808_MODEL_${nonce}`,
      project: `HOLI808_PROJECT_${nonce}`,
    }
    proof.prompt = `HOLI808_USER_${nonce}`
    const document = join(dirs.vault, 'document.md')
    const initialMarker = `document.md HOLI808_INITIAL_${nonce}`
    const resumedMarker = `document.md HOLI808_RESUMED_${nonce}`
    await writeFile(document, initialMarker)
    const modelFile = join(root, 'model.txt')
    await writeFile(modelFile, proof.expected.model)
    const projectFile = join(dirs.vault, 'AGENTS.md')
    await writeFile(projectFile, proof.expected.project)
    const config = join(dirs.codex, 'config.toml')
    const profile = join(dirs.codex, 'fixture.config.toml')
    const settings = `model = "gpt-5.1-codex-mini"\nmodel_provider = "holi-fixture"\nmodel_instructions_file = ${JSON.stringify(modelFile)}\n[model_providers.holi-fixture]\nname = "Holi fixture"\nbase_url = "http://127.0.0.1:${model.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`
    await writeFile(
      config,
      `developer_instructions = ${JSON.stringify(proof.expected.excluded)}\n${settings}`,
    )
    await writeFile(
      profile,
      `developer_instructions = ${JSON.stringify(proof.expected.developer)}\n${settings}`,
    )
    proof.provenance.config = {
      base: await readFile(config, 'utf8'),
      profile: await readFile(profile, 'utf8'),
    }
    const answers = new WeakMap()
    const wait = async (child, predicate, label) => {
      const until = Math.min(deadline, Date.now() + 18000)
      const answered = answers.get(child) ?? new Map()
      answers.set(child, answered)
      while (Date.now() < until) {
        if (child.failure) throw child.failure
        const raw = child.output.toString()
        if (predicate(clean(raw))) return
        if (child.nativeExit) throw Error(`${label}: process exited`)
        for (const [query, response] of [
          ['\u001b[6n', '\u001b[1;1R'],
          ['\u001b[c', '\u001b[?1;2c'],
          [
            '\u001b]11;?',
            '\u001b]10;rgb:ffff/ffff/ffff\u001b\\\u001b]11;rgb:0000/0000/0000\u001b\\',
          ],
        ]) {
          const count = raw.split(query).length - 1
          if (count > (answered.get(query) ?? 0)) {
            await child.write(response)
            answered.set(query, count)
          }
        }
        await pause(100)
      }
      throw Error(`Native observation deadline: ${label}`)
    }
    const argv = ['--no-daemon', '--no-alt-screen', '--profile', 'fixture']
    const turn = async (label, extra = []) => {
      const start = model.requests.length
      const child = await launch(binary, [...argv, ...extra], label)
      await wait(
        child,
        () => child.output.toString().includes('state=idle:app=codex'),
        `${label} idle`,
      )
      await child.write(proof.prompt)
      await wait(child, (s) => s.includes(proof.prompt), `${label} draft`)
      await pause(250)
      await child.write('\r')
      const request = () =>
        model.requests
          .slice(start)
          .find(
            ({ body }) =>
              text(body.input?.filter((item) => item.role === 'user').at(-1)) === proof.prompt,
          )
      await wait(child, () => Boolean(request()), `${label} model request`)
      await wait(child, (s) => s.includes('Holi context fixture finished.'), `${label} completion`)
      const capture = { request: request().body }
      await child.close()
      return capture
    }
    proof.baseline = await turn('baseline')
    const events = join(root, 'hook-events.jsonl')
    const hook = join(root, 'document-hook.mjs')
    await writeFile(
      hook,
      `import{appendFileSync,readFileSync}from'node:fs';let input='';for await(const c of process.stdin)input+=c;const event=JSON.parse(input);appendFileSync(${JSON.stringify(events)},JSON.stringify(event)+'\\n');console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:readFileSync(${JSON.stringify(document)},'utf8')}}));`,
    )
    await writeFile(
      join(dirs.codex, 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: 'startup|resume',
              hooks: [
                {
                  type: 'command',
                  command: `${JSON.stringify(process.execPath)} ${JSON.stringify(hook)}`,
                },
              ],
            },
          ],
        },
      }),
    )
    const approval = await launch(binary, argv, 'consent')
    await wait(
      approval,
      (s) => s.includes('Hooks need review') && s.includes('1 hook is new or changed.'),
      'single hook review',
    )
    await pause(1100)
    await approval.write('\r')
    await wait(approval, (s) => s.includes('Lifecycle hooks from config'), 'native hook list')
    await approval.write('\r')
    await wait(
      approval,
      (s) => s.includes(hook) && s.includes('t trust') && s.includes('User config'),
      'exact owned hook',
    )
    if (existsSync(events)) throw Error('Hook executed without native consent')
    proof.consent.before = await readFile(profile, 'utf8')
    await approval.write('t')
    await wait(
      approval,
      (s) => s.includes('Trusted') && s.includes('Turn hooks on or off'),
      'native trust publication',
    )
    proof.consent.after = await readFile(profile, 'utf8')
    proof.consent.transcript = clean(approval.output.toString())
    proof.consent.hook = hook
    await approval.close()
    const hookEvents = async () =>
      (await readFile(events, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    proof.initial = await turn('initial')
    const initialEvent = (await hookEvents()).filter((event) => event.source === 'startup').at(-1)
    if (!initialEvent?.session_id) throw Error('Initial native session identity missing')
    proof.initial.conversationId = initialEvent.session_id
    proof.initial.marker = initialMarker
    await writeFile(document, resumedMarker)
    proof.resumed = await turn('resume', ['resume', initialEvent.session_id])
    const resumedEvent = (await hookEvents()).filter((event) => event.source === 'resume').at(-1)
    proof.resumed.conversationId = resumedEvent?.session_id
    proof.resumed.marker = resumedMarker
    proof.events = await hookEvents()
    proof.sourcesUnchanged =
      (await readFile(projectFile, 'utf8')) === proof.expected.project &&
      (await readFile(modelFile, 'utf8')) === proof.expected.model &&
      (await readFile(config, 'utf8')) === proof.provenance.config.base
    if (model.failures.length) throw Error(model.failures.join('; '))
  } catch (error) {
    proof.error = String(error)
  } finally {
    proof.transcripts = children.map((child, index) => ({
      index,
      text: clean(child.output.toString()),
      failure: child.failure?.message,
    }))
    for (const child of children) {
      try {
        proof.cleanup.receipts.push(await child.close())
      } catch (error) {
        proof.cleanup.error = String(error)
      }
    }
    if (model) {
      try {
        await model.close()
        proof.cleanup.serverClosed = true
      } catch (error) {
        proof.cleanup.error = String(error)
      }
    }
    if (
      root &&
      !proof.cleanup.error &&
      proof.cleanup.receipts.every((receipt) => receipt.drained)
    ) {
      try {
        await rm(root, { recursive: true, force: true })
        proof.cleanup.rootRemoved = !existsSync(root)
      } catch (error) {
        proof.cleanup.error = String(error)
      }
    }
    proof.validation = validateDocumentContextProof(proof)
    if (!proof.error && proof.validation.valid) proof.status = 'demonstrated'
    await writeFile(join(output, 'proof.json'), JSON.stringify(proof, null, 2), { mode: 0o600 })
  }
  return proof
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runNativeDocumentContext({ output: process.argv[2] })
    .then((proof) => {
      console.log(
        JSON.stringify({ status: proof.status, error: proof.error, validation: proof.validation }),
      )
      process.exitCode = proof.status === 'demonstrated' ? 0 : 1
    })
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
}
