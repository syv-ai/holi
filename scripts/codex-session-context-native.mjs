import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runNativeContextFixture } from './codex-context-native-runtime.mjs'
import { runRestrictedContext } from './codex-context-restricted.mjs'

/** Exercise native consent and capture initial-session context without personal configuration. */
export async function runNativeInitialFixture() {
  return runNativeContextFixture(
    async ({ root, env, bin, launch, model, evidence, wait, send, delay }) => {
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
      const approval = await launch(
        [bin, '--no-daemon', '--no-alt-screen', '--profile', 'fixture'],
        'consent',
      )
      await wait(
        approval,
        (text) => text.includes('Hooks need review') && text.includes('1 hook is new or changed.'),
        'single-hook startup review',
      )
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
        !evidence.hooks.some(
          (event) => event.source === 'resume' && event.session_id === session,
        ) ||
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
        const hasContext = JSON.stringify(controlRequest().body).includes(
          'HOLI764_ADDITIVE_CONTEXT',
        )
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
    },
  )
}
