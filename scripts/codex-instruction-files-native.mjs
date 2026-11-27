import { existsSync } from 'node:fs'
import { mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { runNativeContextFixture } from './codex-context-native-runtime.mjs'

/** Capture instruction discovery in native terminals and production restricted jobs. */
export async function runNativeInstructionFilesFixture() {
  return runNativeContextFixture(
    async ({ root, env, bin, launch, model, evidence, wait, send, delay }) => {
      evidence.scenario = 'instruction-files'
      const result = { sources: [], scenarios: [], controls: [] }
      evidence.instructionFiles = result
      const loader = await createServer({
        configFile: false,
        root: fileURLToPath(new URL('../apps/desktop', import.meta.url)),
        server: { middlewareMode: true, watch: null, ws: false },
        appType: 'custom',
        optimizeDeps: { noDiscovery: true },
      })
      try {
        const { jobArgs, fenceArgs } = await loader.ssrLoadModule(
          '/src/plugins/agent/main/codex/index.ts',
        )
        const { prepareCodexHome } = await loader.ssrLoadModule(
          '/src/plugins/agent/main/codex/home.ts',
        )
        const vault = join(root, 'vault')
        const profile = join(root, 'profile-instructions.txt')
        const provider = `model = "gpt-5.1-codex-mini"\nmodel_provider = "holi-fixture"\n[model_providers.holi-fixture]\nname = "Holi fixture"\nbase_url = "http://127.0.0.1:${model.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`
        const ordinaryConfig = `developer_instructions = "HOLI788_CONFIG_INSTRUCTIONS"\nmodel_instructions_file = ${JSON.stringify(profile)}\n${provider}\n[projects.${JSON.stringify(vault)}]\ntrust_level = "untrusted"\n`
        const sources = [
          [profile, 'HOLI788_PROFILE_INSTRUCTIONS'],
          [join(env.CODEX_HOME, 'config.toml'), ordinaryConfig],
          [join(env.CODEX_HOME, 'fixture.config.toml'), ordinaryConfig],
          [join(env.CODEX_HOME, 'AGENTS.md'), 'HOLI788_IGNORED_FALLBACK'],
          [join(env.CODEX_HOME, 'AGENTS.override.md'), 'HOLI788_GLOBAL_INSTRUCTIONS'],
          [join(vault, 'AGENTS.md'), 'HOLI788_PROJECT_INSTRUCTIONS'],
        ]
        for (const [path, text] of sources) {
          await writeFile(path, text)
          result.sources.push({ path, before: text })
        }
        const project = join(vault, '.codex')
        await mkdir(project)
        const sentinel = join(root, 'unrelated-integration-executed')
        const script = join(root, 'unrelated-integration.mjs')
        await writeFile(
          script,
          `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(sentinel)},'unexpected')`,
        )
        const projectConfig = `[mcp_servers.unrelated]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(script)}]\n[plugins."unrelated@fixture"]\nenabled = true\n`
        await writeFile(join(project, 'config.toml'), projectConfig)
        await writeFile(
          join(project, 'hooks.json'),
          JSON.stringify({
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
          }),
        )
        result.projectConfig = projectConfig
        const ordinaryHome = join(root, 'ordinary-managed')
        await mkdir(ordinaryHome)
        for (const name of ['config.toml', 'fixture.config.toml'])
          await writeFile(join(ordinaryHome, name), ordinaryConfig)
        const keyEnv = { ...env, OPENAI_API_KEY: 'synthetic-fixture-key' }
        const lastUser = (body) => {
          const user = body.input?.filter((item) => item.role === 'user').at(-1)
          return typeof user?.content === 'string'
            ? user.content
            : user?.content?.map((part) => part.text ?? '').join('')
        }
        const state = join(root, 'instruction-state')
        await mkdir(state)
        for (const mode of ['ordinary', 'fenced', 'exec']) {
          let session
          for (const phase of ['initial', 'resume']) {
            const home =
              mode === 'ordinary'
                ? ordinaryHome
                : prepareCodexHome(join(state, mode), [vault, root], keyEnv)
            const config = await readFile(
              join(home, mode === 'ordinary' ? 'fixture.config.toml' : 'config.toml'),
              'utf8',
            )
            const guidance = `HOLI788_GUIDANCE:${mode}:${phase}`
            const prompt = `HOLI788_PROMPT:${mode}:${phase}`
            const files = [
              { path: join(home, 'AGENTS.md'), text: 'HOLI788_IGNORED_FALLBACK' },
              {
                path: join(home, 'AGENTS.override.md'),
                text: `${mode === 'ordinary' ? 'HOLI788_GLOBAL_INSTRUCTIONS\n' : ''}${guidance}`,
              },
            ]
            for (const file of files) await writeFile(file.path, file.text)
            const args =
              mode === 'exec'
                ? jobArgs({ cwd: vault, prompt, ...(session ? { resume: session } : {}) })
                : [
                    '--no-alt-screen',
                    ...(mode === 'ordinary' ? ['--profile', 'fixture'] : fenceArgs(vault)),
                    ...(session ? ['resume', session] : []),
                  ]
            const label = `instructions-${mode}-${phase}`
            const child = await launch([bin, '--no-daemon', ...args], label, {
              ...keyEnv,
              CODEX_HOME: home,
            })
            let sessionRecord, sessionPath
            if (mode === 'exec') {
              const exit = await child.waitForExit()
              if (exit.code !== 0 || child.failure)
                throw Error(`${label}: native exec failed: ${child.output.toString().slice(-4000)}`)
              const events = child.output
                .toString()
                .split('\n')
                .flatMap((line) => {
                  try {
                    return [JSON.parse(line)]
                  } catch {
                    return []
                  }
                })
              const observed = events.find((item) => item.type === 'thread.started')?.thread_id
              if (
                !observed ||
                !events.some((item) => item.type === 'turn.completed') ||
                (session && observed !== session)
              )
                throw Error(`${label}: exact-thread completion missing`)
              session = observed
            } else {
              await wait(
                child,
                (text) =>
                  child.output.toString().includes('state=idle:app=codex') ||
                  (text.includes('Folder access') &&
                    text.includes('Open restricted') &&
                    text.includes('Opening will not change saved trust.')),
                `${label} native startup`,
              )
              if (!child.output.toString().includes('state=idle:app=codex')) {
                await delay(1100)
                await send(child, `${label}-open-restricted-without-saving-trust`, '\r')
                await wait(
                  child,
                  () => child.output.toString().includes('state=idle:app=codex'),
                  `${label} restricted editor idle`,
                )
              }
              await send(child, `${label}-prompt`, prompt)
              await wait(child, (text) => text.includes(prompt), `${label} draft`)
              await delay(250)
              const offset = child.output.length
              await send(child, `${label}-submit`, '\r')
              await wait(
                child,
                () => model.requests.some((item) => lastUser(item.body) === prompt),
                `${label} request`,
              )
              await wait(
                child,
                () =>
                  child.output.toString().slice(offset).includes('Holi context fixture finished.'),
                `${label} completion`,
              )
              const entries = await readdir(join(home, 'sessions'), { recursive: true })
              if (entries.length > 256) throw Error('Native session discovery bound exceeded')
              const logs = entries.filter((name) => name.endsWith('.jsonl'))
              if (logs.length !== 1) throw Error('Native session identity ambiguous')
              sessionPath = join(home, 'sessions', logs[0])
              const file = await open(sessionPath, 'r')
              try {
                const bytes = Buffer.alloc(262144)
                const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
                const line = bytes.subarray(0, bytesRead).toString().split('\n')[0]
                sessionRecord = JSON.parse(line)
              } finally {
                await file.close()
              }
              const observed = sessionRecord.payload?.id
              if (!observed || (session && observed !== session))
                throw Error('Native terminal resume changed session')
              session = observed
            }
            const requestIndex = model.requests.findIndex((item) => lastUser(item.body) === prompt)
            if (requestIndex < 0 || !/^[0-9a-f-]{36}$/.test(session))
              throw Error(`${label}: native request/session missing`)
            result.scenarios.push({
              mode,
              phase,
              home,
              session,
              sessionPath,
              sessionRecord,
              prompt,
              guidance,
              requestIndex,
              files,
              config,
              args,
              launchLabel: label,
              transcript: child.output.toString(),
            })
            await child.close()
            result.scenarios.at(-1).configAfter = await readFile(
              join(home, mode === 'ordinary' ? 'fixture.config.toml' : 'config.toml'),
              'utf8',
            )
            if (existsSync(sentinel)) throw Error('Untrusted integration executed')
          }
        }
        for (const source of result.sources) {
          source.after = await readFile(source.path, 'utf8')
          if (source.before !== source.after) throw Error('Original instruction source changed')
        }
        result.controls.push({ path: sentinel, executed: existsSync(sentinel) })
        if (model.failures.length) throw Error(model.failures.join('; '))
        // The artifact validator independently derives preservation, roles and the candidate result.
        evidence.status = 'observed'
        evidence.classification = 'incomplete-proof'
      } finally {
        await loader.close()
      }
    },
  )
}
