import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/** Observe the existing production home/argument contract without importing personal state. */
export async function runRestrictedContext({ root, env, bin, launch, model }) {
  const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url))
  const { createServer } = await import(require.resolve('vite'))
  const loader = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('../apps/desktop', import.meta.url)),
    server: { middlewareMode: true, watch: null, ws: false },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  })
  try {
    const { jobArgs } = await loader.ssrLoadModule('/src/plugins/agent/main/codex/index.ts')
    const { prepareCodexHome } = await loader.ssrLoadModule('/src/plugins/agent/main/codex/home.ts')
    const state = join(root, 'job-state')
    const vault = join(root, 'vault')
    await mkdir(state)
    const project = join(vault, '.codex')
    await mkdir(project)
    const sentinel = join(root, 'unrelated-integration-executed')
    const script = join(root, 'unrelated-integration.mjs')
    await writeFile(
      script,
      `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(sentinel)},'unexpected')`,
    )
    await writeFile(
      join(project, 'config.toml'),
      `[mcp_servers.unrelated]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(script)}]\n`,
    )
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
    const keyEnv = { ...env, OPENAI_API_KEY: 'synthetic-fixture-key' }
    const evidence = {
      status: 'incomplete',
      launches: [],
      configs: [],
      requests: [],
      projectIntegrationExecuted: false,
    }
    let thread
    for (const [index, prompt] of [
      'HOLI764_RESTRICTED_PROMPT',
      'HOLI764_RESTRICTED_FOLLOWUP',
    ].entries()) {
      const home = prepareCodexHome(state, [vault, root], keyEnv)
      const config = await readFile(join(home, 'config.toml'), 'utf8')
      evidence.configs.push(config)
      if (
        existsSync(join(home, 'hooks.json')) ||
        config.includes('trusted_hash') ||
        config.includes('developer_instructions') ||
        config.includes('mcp_servers')
      )
        throw Error('Restricted home unexpectedly includes integrations or custom instructions')
      const args = jobArgs({ cwd: vault, prompt, ...(thread ? { resume: thread } : {}) })
      const native = await launch([bin, '--no-daemon', ...args], `restricted-${index}`, {
        ...keyEnv,
        CODEX_HOME: home,
      })
      const exit = await native.waitForExit()
      await native.close()
      evidence.launches.push({ args, home, exit, output: native.output.toString() })
      if (exit.code !== 0 || native.failure)
        throw Error(`Restricted native launch failed: ${native.output.toString().slice(-4000)}`)
      const events = native.output
        .toString()
        .split('\n')
        .flatMap((line) => {
          try {
            return [JSON.parse(line)]
          } catch {
            return []
          }
        })
      thread ??= events.find((event) => event.type === 'thread.started')?.thread_id
      if (!thread || !events.some((event) => event.type === 'turn.completed'))
        throw Error('Restricted native completion/session missing')
      const request = model.requests.find((item) => {
        const user = item.body.input?.filter((message) => message.role === 'user').at(-1)
        return (
          (typeof user?.content === 'string'
            ? user.content
            : user?.content?.map((part) => part.text ?? '').join('')) === prompt
        )
      })
      if (!request) throw Error('Restricted native request not captured')
      evidence.requests.push(request)
      if (
        evidence.requests.some((item) =>
          JSON.stringify(item.body).includes('HOLI764_BASE_INSTRUCTIONS'),
        )
      )
        throw Error('Inactive base instructions reached the restricted request')
      if (existsSync(sentinel)) throw Error('Untrusted project integration executed')
    }
    const markers = [
      'HOLI764_ADDITIVE_CONTEXT',
      'HOLI764_CONFIG_INSTRUCTIONS',
      'HOLI764_PROFILE_INSTRUCTIONS',
    ]
    const observed = evidence.requests.map((item) =>
      markers.map((marker) => JSON.stringify(item.body).includes(marker)),
    )
    if (observed.every((flags) => flags.every(Boolean))) evidence.status = 'demonstrated'
    else if (observed.every((flags) => flags.every((flag) => !flag))) {
      evidence.status = 'demonstrated-unsupported'
      evidence.limitation =
        'The existing production restricted home excludes the ordinary hook, native trust and custom/profile instructions on initial and regenerated follow-up launches. This tested integration does not deliver additive context; no claim about every possible Codex mechanism.'
    } else
      evidence.error = 'Restricted context preservation was partial or inconsistent across turns'
    return evidence
  } finally {
    await loader.close()
  }
}
