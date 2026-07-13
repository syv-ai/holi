/**
 * Agent-drawer e2e (spec §Testing): drives the real desktop app over CDP with
 * a fake `claude` in the PTY, proving the whole slice-2 loop —
 * drawer → PTY → hooks → bridge → CRDT → editor, and MCP → server.
 *
 * Run (from apps/desktop, with db + server up and a dev token):
 *   HOLI_CLAUDE_BIN=$PWD/e2e/fake-claude.mjs pnpm exec electron-vite dev -- --remote-debugging-port=9223
 *   HOLI_DEV_TOKEN=<token> pnpm --filter @holi/server exec tsx ../desktop/e2e/agent-smoke.ts
 */
import WebSocket from 'ws'

const CDP_PORT = Number(process.env.CDP_PORT ?? 9223)
const TOKEN = process.env.HOLI_DEV_TOKEN
const DOC = 'e2e-drawer.md'
const FIRST_LINE = 'hello from fake claude'
const SECOND_LINE = 'second line while open'
const TASK_TITLE = 'E2E drawer task'

let ws: WebSocket
let nextId = 1

function send<T = unknown>(method: string, params: unknown): Promise<T> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const onMessage = (raw: WebSocket.RawData) => {
      const msg = JSON.parse(String(raw))
      if (msg.id !== id) return
      ws.off('message', onMessage)
      // CDP nests the value: msg.result.result.value
      if (msg.result?.exceptionDetails) {
        reject(new Error(JSON.stringify(msg.result.exceptionDetails.exception ?? msg.result.exceptionDetails)))
      } else resolve(msg.result?.result?.value as T)
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

const evaluate = <T = unknown>(expression: string): Promise<T> =>
  send<T>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitUntil<T>(fn: () => Promise<T>, label: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value) return value
      last = value
    } catch (err) {
      last = err instanceof Error ? err.message : err
    }
    await sleep(400)
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`)
}

/** Renderer-side tRPC through the preload bridge. */
const trpc = (path: string, type: 'query' | 'mutation', input: unknown) =>
  `window.holi.trpc(${JSON.stringify({ path, type, input })}).then(e => e.ok ? e.data : Promise.reject(new Error(e.message)))`

async function connect(): Promise<void> {
  const targets = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()) as Array<{
    url: string
    webSocketDebuggerUrl: string
  }>
  const target = targets.find((t) => t.url.includes('localhost:5') || t.url.includes('index.html'))
  if (!target) throw new Error(`no renderer target among: ${targets.map((t) => t.url).join(', ')}`)
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
}

const checks: string[] = []
const pass = (label: string) => {
  checks.push(label)
  console.log(`  ✓ ${label}`)
}

async function main(): Promise<void> {
  if (!TOKEN) throw new Error('HOLI_DEV_TOKEN is required (pnpm --filter @holi/server exec tsx scripts/seed-dev.ts)')
  await connect()

  // 1. signed in, vault active
  await evaluate(`window.holi.auth.devSignIn(${JSON.stringify(TOKEN)})`)
  await evaluate('location.reload()')
  await sleep(2500)
  const vaultId = await waitUntil(
    () => evaluate<string>(`document.querySelector('select')?.value || ''`),
    'a vault to be active',
  )
  pass(`1. signed in, vault ${vaultId} active`)

  // 2. the drawer starts a session: PTY + MCP up
  const started = await evaluate<{ ok: boolean; message?: string }>(
    `window.holi.agent.start(${JSON.stringify({ vaultId })})`,
  )
  if (!started.ok) throw new Error(`agent.start failed: ${started.message}`)
  await waitUntil(() => evaluate<boolean>('window.holi.agent.status().then(s => s.running)'), 'the session to run')
  pass('2. agent session running (PTY + MCP up)')

  // 3. an agent file write is adopted as a vault doc
  await evaluate(`window.holi.agent.write(${JSON.stringify(`edit ${DOC} ${FIRST_LINE}\r`)})`)
  await waitUntil(
    () =>
      evaluate<boolean>(
        `${trpc('vaults.listDocs', 'query', { vaultId })}.then(r => r.docs.some(d => d.path === ${JSON.stringify(DOC)}))`,
      ),
    `${DOC} to be adopted as a doc`,
  )
  pass(`3. agent-created ${DOC} adopted as a vault doc`)

  // 4. opening it in the editor shows the agent's text (relay sync)
  await evaluate(`
    (() => {
      const el = [...document.querySelectorAll('button, div, span, li')]
        .find(e => e.textContent?.trim() === ${JSON.stringify(DOC)} && e.children.length === 0)
      if (!el) throw new Error('doc not in the file tree')
      el.click()
    })()
  `)
  await waitUntil(
    () => evaluate<boolean>(`(document.querySelector('.cm-content')?.textContent ?? '').includes(${JSON.stringify(FIRST_LINE)})`),
    'the editor to show the agent text',
  )
  pass('4. editor opened the doc with the agent’s content')

  // 5. a second agent edit lands live in the open editor (hook turn → merge)
  await evaluate(`window.holi.agent.write(${JSON.stringify(`edit ${DOC} ${SECOND_LINE}\r`)})`)
  await waitUntil(
    () => evaluate<boolean>(`(document.querySelector('.cm-content')?.textContent ?? '').includes(${JSON.stringify(SECOND_LINE)})`),
    'the live editor to pick up the second edit',
  )
  pass('5. second agent edit appeared live in the open editor')

  // 6. an MCP op reaches the server with the user's identity
  await evaluate(`window.holi.agent.write(${JSON.stringify(`task ${TASK_TITLE}\r`)})`)
  await waitUntil(
    () =>
      evaluate<boolean>(
        `${trpc('tasks.list', 'query', { vaultId, filter: {} })}.then(ts => ts.some(t => t.title === ${JSON.stringify(TASK_TITLE)}))`,
      ),
    'the MCP-created task to exist',
  )
  pass('6. task created through the bearer-gated MCP server')

  // 7. kill tears the session down
  await evaluate('window.holi.agent.kill()')
  await waitUntil(
    () => evaluate<boolean>('window.holi.agent.status().then(s => !s.running)'),
    'the session to stop',
  )
  pass('7. session killed')

  console.log(`\n${checks.length}/7 checkpoints passed`)
  ws.close()
}

main().catch((err) => {
  console.error(`\n✗ ${checks.length}/7 — ${err instanceof Error ? err.message : err}`)
  ws?.close()
  process.exit(1)
})
