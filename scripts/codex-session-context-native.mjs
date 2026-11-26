import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startOwnedPty } from './pi-native-tui-process.mjs'
import { createContextModel } from './codex-context-model.mjs'
import { runRestrictedContext } from './codex-context-restricted.mjs'
import { installPinnedCodex } from './codex-native-install.mjs'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const clean = (text) =>
  text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')

/** Exercise native consent and capture initial-session context without personal configuration. */
export async function runNativeInitialFixture() {
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
    const hook = join(root, 'owned-context-hook.mjs')
    const hookEvents = join(root, 'hook-events.jsonl')
    await writeFile(
      hook,
      `import{appendFileSync}from'node:fs';let input='';for await(const c of process.stdin)input+=c;appendFileSync(${JSON.stringify(hookEvents)},JSON.stringify(JSON.parse(input))+'\\n',{mode:0o600});console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:'HOLI764_ADDITIVE_CONTEXT:'+JSON.parse(input).source}}))`,
    )
    const config = join(env.CODEX_HOME, 'fixture.config.toml')
    const profileInstructions = join(root, 'profile-instructions.txt')
    await writeFile(profileInstructions, 'HOLI764_PROFILE_INSTRUCTIONS')
    await writeFile(
      config,
      `model = "gpt-5.1-codex-mini"\nmodel_provider = "holi-fixture"\ndeveloper_instructions = "HOLI764_CONFIG_INSTRUCTIONS"\nmodel_instructions_file = ${JSON.stringify(profileInstructions)}\n[model_providers.holi-fixture]\nname = "Holi fixture"\nbase_url = "http://127.0.0.1:${model.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`,
    )
    await writeFile(
      join(env.CODEX_HOME, 'config.toml'),
      (await readFile(config, 'utf8')).replace(
        'HOLI764_CONFIG_INSTRUCTIONS',
        'HOLI764_BASE_INSTRUCTIONS',
      ),
    )
    await writeFile(
      join(env.CODEX_HOME, 'hooks.json'),
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
    const approval = await launch(
      [bin, '--no-daemon', '--no-alt-screen', '--profile', 'fixture'],
      'consent',
    )
    await wait(
      approval,
      (text) => text.includes('Hooks need review') && text.includes('1 hook is new or changed.'),
      'single-hook startup review',
    )
    const send = async (child, label, bytes) => {
      evidence.consent.push({ label, offset: child.output.length, bytes: [...Buffer.from(bytes)] })
      await child.write(bytes)
    }
    // Codex 0.169.0 drains protected-screen input after drawing, for up to one second.
    await delay(1100)
    await send(approval, 'review-hooks', '\r')
    await wait(approval, (text) => text.includes('Lifecycle hooks from config'), 'hook events')
    await send(approval, 'review-session-start', '\r')
    await wait(
      approval,
      (text) => text.includes(hook) && text.includes('t trust') && text.includes('User config'),
      'exact owned hook command',
    )
    if (existsSync(hookEvents)) throw Error('Untrusted hook executed before consent')
    const before = await readFile(config, 'utf8')
    await send(approval, 'trust-exact-owned-hook', 't')
    await wait(
      approval,
      (text) => text.includes('Trusted') && text.includes('Turn hooks on or off'),
      'native trust publication',
    )
    const after = await readFile(config, 'utf8')
    if (before.includes('trusted_hash') || !after.includes('trusted_hash = "sha256:'))
      throw Error('Native trust publication missing')
    evidence.trustChanges.push({ before, after })
    evidence.approvalTranscript = approval.output.toString()
    await approval.close()
    const initial = await launch(
      [bin, '--no-daemon', '--no-alt-screen', '--profile', 'fixture'],
      'initial',
    )
    await wait(
      initial,
      () => initial.output.toString().includes('state=idle:app=codex'),
      'native editor idle',
    )
    const prompt = 'HOLI764_UNCHANGED_USER_PROMPT'
    await send(initial, 'type-synthetic-prompt', prompt)
    await wait(initial, (text) => text.includes(prompt), 'native draft')
    await delay(250)
    await send(initial, 'submit-synthetic-prompt', '\r')
    await wait(initial, () => existsSync(hookEvents), 'trusted startup execution')
    const lastUserText = (body) => {
      const user = body.input?.filter((item) => item.role === 'user').at(-1)
      return typeof user?.content === 'string'
        ? user.content
        : user?.content?.map((part) => part.text ?? '').join('')
    }
    const primaryRequest = () =>
      model.requests.find((request) => lastUserText(request.body) === prompt)
    await wait(initial, () => Boolean(primaryRequest()), 'native model request')
    await wait(
      initial,
      (text) => text.includes('Holi context fixture finished.'),
      'synthetic turn completion',
    )
    evidence.initialTranscript = initial.output.toString()
    evidence.hooks = (await readFile(hookEvents, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const request = primaryRequest().body
    const text = JSON.stringify(request)
    const userText = lastUserText(request)
    if (
      !text.includes('HOLI764_ADDITIVE_CONTEXT') ||
      !text.includes('HOLI764_CONFIG_INSTRUCTIONS') ||
      !text.includes('HOLI764_PROFILE_INSTRUCTIONS') ||
      userText !== prompt ||
      !evidence.hooks.some((event) => event.source === 'startup')
    )
      throw Error('Native input/context preservation not demonstrated')
    if (model.failures.length) throw Error(model.failures.join('; '))
    evidence.initial = { status: 'demonstrated', request, hooks: [...evidence.hooks] }
    await initial.close()
    const session = evidence.hooks.find((event) => event.source === 'startup').session_id
    if (!/^[0-9a-f-]{36}$/.test(session)) throw Error('Native session identity missing')
    const resume = await launch(
      [bin, '--no-daemon', '--no-alt-screen', '--profile', 'fixture', 'resume', session],
      'resume',
    )
    await wait(
      resume,
      () => resume.output.toString().includes('state=idle:app=codex'),
      'resumed editor idle',
    )
    const resumePrompt = 'HOLI764_RESUME_PROMPT'
    await send(resume, 'type-resume-prompt', resumePrompt)
    await wait(resume, (text) => text.includes(resumePrompt), 'resumed draft')
    await delay(250)
    await send(resume, 'submit-resume-prompt', '\r')
    const resumedRequest = () =>
      model.requests.find((item) => lastUserText(item.body) === resumePrompt)
    await wait(resume, () => Boolean(resumedRequest()), 'resumed model request')
    await wait(
      resume,
      (text) => text.includes('Holi context fixture finished.'),
      'resumed turn completion',
    )
    evidence.hooks = (await readFile(hookEvents, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    if (
      !evidence.hooks.some((event) => event.source === 'resume' && event.session_id === session) ||
      !JSON.stringify(resumedRequest().body).includes('HOLI764_ADDITIVE_CONTEXT:resume') ||
      !JSON.stringify(resumedRequest().body).includes('HOLI764_CONFIG_INSTRUCTIONS') ||
      !JSON.stringify(resumedRequest().body).includes('HOLI764_PROFILE_INSTRUCTIONS')
    )
      throw Error('Fresh resume context not demonstrated')
    evidence.resume = {
      status: 'demonstrated',
      session,
      request: resumedRequest().body,
      transcript: resume.output.toString(),
    }
    await resume.close()
    const declarationPath = join(env.CODEX_HOME, 'hooks.json')
    const declaration = JSON.parse(await readFile(declarationPath, 'utf8'))
    const deniedSentinel = join(root, 'denied-hook-executed')
    const deniedScript = join(root, 'denied-hook.mjs')
    await writeFile(
      deniedScript,
      `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(deniedSentinel)},'unexpected')`,
    )
    declaration.hooks.SessionStart.push({
      matcher: 'startup|resume',
      hooks: [
        {
          type: 'command',
          command: `${JSON.stringify(process.execPath)} ${JSON.stringify(deniedScript)}`,
        },
      ],
    })
    evidence.negativeControls = []
    for (const changed of [false, true]) {
      if (changed) declaration.hooks.SessionStart[0].hooks[0].command += ' --changed'
      await writeFile(declarationPath, JSON.stringify(declaration))
      const beforeEvents = (await readFile(hookEvents, 'utf8')).trim().split('\n').length
      const label = changed ? 'modified-hook' : 'unrelated-hook'
      const child = await launch(
        [bin, '--no-daemon', '--no-alt-screen', '--profile', 'fixture'],
        label,
      )
      await wait(child, (text) => text.includes('Hooks need review'), `${label} native review`)
      await delay(1100)
      await send(child, `deny-${label}`, '\u001b')
      await wait(
        child,
        () => child.output.toString().includes('state=idle:app=codex'),
        `${label} idle`,
      )
      const controlPrompt = `HOLI764_${label}_PROMPT`
      await send(child, `type-${label}`, controlPrompt)
      await wait(child, (text) => text.includes(controlPrompt), `${label} draft`)
      await delay(250)
      await send(child, `submit-${label}`, '\r')
      const controlRequest = () =>
        model.requests.find((item) => lastUserText(item.body) === controlPrompt)
      await wait(child, () => Boolean(controlRequest()), `${label} request`)
      await wait(
        child,
        (text) => text.includes('Holi context fixture finished.'),
        `${label} completion`,
      )
      const events = (await readFile(hookEvents, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      const hasContext = JSON.stringify(controlRequest().body).includes('HOLI764_ADDITIVE_CONTEXT')
      if (
        existsSync(deniedSentinel) ||
        hasContext === changed ||
        (changed && events.length !== beforeEvents)
      )
        throw Error(`${label} denial did not preserve native trust`)
      evidence.negativeControls.push({
        label,
        status: 'demonstrated',
        request: controlRequest().body,
        beforeEvents,
        afterEvents: events.length,
        deniedHookExecuted: false,
        transcript: child.output.toString(),
      })
      await child.close()
    }
    evidence.restricted = await runRestrictedContext({ root, env, bin, launch, model })
    evidence.status = ['demonstrated', 'demonstrated-unsupported'].includes(
      evidence.restricted.status,
    )
      ? 'demonstrated'
      : 'incomplete'
    evidence.classification =
      evidence.status === 'incomplete'
        ? 'incomplete-proof'
        : evidence.restricted.status === 'demonstrated'
          ? 'supported'
          : 'demonstrated-unsupported-path'
  } catch (error) {
    evidence.error = String(error)
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
