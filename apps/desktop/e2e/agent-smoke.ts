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
/** Unique per run: the dev vault is persistent, so a fixed title would let the
 * task assertions pass on a record an earlier run left behind (it did). */
const RUN = Date.now().toString(36).slice(-5)
const TASK_TITLE = `E2E task ${RUN}`
const RENAMED_TITLE = `E2E renamed ${RUN}`

const slug = (title: string) =>
  title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'task'

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

  // 6. the agent creates a task by WRITING A FILE — no op. The projection makes
  //    the record. (The title is unique per run: the dev vault is persistent, and
  //    a fixed title would let this pass on a task left behind by an earlier run.)
  const listTasks = `${trpc('tasks.list', 'query', { vaultId, filter: {} })}`
  const findTask = (title: string) =>
    `${listTasks}.then(ts => ts.find(t => t.title === ${JSON.stringify(title)}) ?? null)`

  await evaluate(`window.holi.agent.write(${JSON.stringify(`taskfile ${TASK_TITLE}\r`)})`)
  const created = await waitUntil(
    () => evaluate<{ id: string; version: number } | null>(findTask(TASK_TITLE)),
    'the task file to become a record',
  )
  pass(`6. agent wrote tasks/*.md → record created (no op), id ${created.id.slice(0, 8)}`)

  // The projection rewrites the agent's `tasks/<slug>.md` at the canonical,
  // id-suffixed path. 6d reads that exact path, so if the rewrite had not
  // happened, 6d would time out — no separate assertion needed.
  const canonical = `tasks/${slug(TASK_TITLE)}-${created.id}.md`

  // 6c. NO SPURIOUS TURN. Task files are not CRDT docs: the write above must not
  //     have created a doc, taken a snapshot, or opened a bridge turn. This is
  //     the whole point of the mirror exclusion.
  const leaked = await evaluate<string[]>(
    `${trpc('vaults.listDocs', 'query', { vaultId })}.then(r => r.docs.filter(d => d.path.startsWith('tasks/')).map(d => d.path))`,
  )
  if (leaked.length > 0) {
    throw new Error(`task files leaked into the doc store as CRDT notes: ${leaked.join(', ')}`)
  }
  pass('6c. no task file became a CRDT doc (mirror exclusion holds)')

  // 6d. file → record: an Edit of the title is a per-field patch, and the file
  //     moves to the new slug.
  await evaluate(`window.holi.agent.write(${JSON.stringify(`settitle ${canonical} ${RENAMED_TITLE}\r`)})`)
  const renamed = await waitUntil(
    () => evaluate<{ id: string; version: number } | null>(findTask(RENAMED_TITLE)),
    'the title edit to patch the record',
  )
  if (renamed.id !== created.id) throw new Error('title edit created a new task instead of patching')
  if (renamed.version <= created.version) throw new Error('version did not advance on the patch')
  pass(`6d. file edit → per-field patch (version ${created.version} → ${renamed.version})`)

  // 6e. rm on a task file deletes the record — the note symmetry, for records.
  const renamedRel = `tasks/${slug(RENAMED_TITLE)}-${created.id}.md`
  await evaluate(`window.holi.agent.write(${JSON.stringify(`rm ${renamedRel}\r`)})`)
  await waitUntil(
    () => evaluate<boolean>(`${findTask(RENAMED_TITLE)}.then(t => t === null)`),
    'rm to delete the record',
  )
  pass('6e. rm tasks/*.md → record deleted')

  // 7. kill tears the session down
  await evaluate('window.holi.agent.kill()')
  await waitUntil(
    () => evaluate<boolean>('window.holi.agent.status().then(s => !s.running)'),
    'the session to stop',
  )
  pass('7. session killed')

  console.log(`\n${checks.length} checkpoints passed`)
  ws.close()
}

main().catch((err) => {
  console.error(`\n✗ ${checks.length}/7 — ${err instanceof Error ? err.message : err}`)
  ws?.close()
  process.exit(1)
})
