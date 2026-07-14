/**
 * The scenario the mirror exclusion exists for (prd/tasks.md §Task file
 * projection): a recurring task is completed, the SERVER rolls its due date
 * forward, and the rewritten record lands on disk as a foreign write.
 *
 * If task files were CRDT docs, that rewrite would open a spurious agent turn —
 * mid-turn. It must instead be a plain file update: no doc, no base, no turn,
 * no snapshot.
 *
 *   HOLI_DEV_TOKEN=<token> pnpm --filter @holi/server exec tsx ../desktop/e2e/recurrence-probe.ts
 */
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

const CDP_PORT = Number(process.env.CDP_PORT ?? 9223)
const TOKEN = process.env.HOLI_DEV_TOKEN!
const TITLE = `Recurring probe ${Date.now().toString(36).slice(-5)}`

let ws: WebSocket
let nextId = 1

function send<T = unknown>(method: string, params: unknown): Promise<T> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const onMessage = (raw: WebSocket.RawData) => {
      const msg = JSON.parse(String(raw))
      if (msg.id !== id) return
      ws.off('message', onMessage)
      if (msg.result?.exceptionDetails) reject(new Error(JSON.stringify(msg.result.exceptionDetails)))
      else resolve(msg.result?.result?.value as T)
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, method, params }))
  })
}
const evaluate = <T = unknown>(e: string): Promise<T> =>
  send<T>('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const trpc = (path: string, type: 'query' | 'mutation', input: unknown) =>
  `window.holi.trpc(${JSON.stringify({ path, type, input })}).then(e => e.ok ? e.data : Promise.reject(new Error(e.message)))`

async function main() {
  const targets = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()) as Array<{
    url: string
    webSocketDebuggerUrl: string
  }>
  const t = targets.find((x) => x.url.includes('localhost:5') || x.url.includes('index.html'))!
  ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise<void>((res, rej) => (ws.once('open', res), ws.once('error', rej)))

  await evaluate(`window.holi.auth.devSignIn(${JSON.stringify(TOKEN)})`)
  await sleep(500)
  const vaultId = await evaluate<string>(`document.querySelector('select')?.value || ''`)
  if (!vaultId) throw new Error('no active vault — is the app signed in?')

  const workRoot = join(
    homedir(),
    'Library/Application Support/@holi/desktop/working-copies',
    vaultId,
    'tasks',
  )
  const fileFor = async (id: string) => {
    const names = await readdir(workRoot).catch(() => [] as string[])
    const name = names.find((n) => n.includes(id))
    return name ? await readFile(join(workRoot, name), 'utf8') : null
  }
  const waitFor = async <T>(fn: () => Promise<T>, label: string, ms = 15_000): Promise<T> => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      const v = await fn()
      if (v) return v
      await sleep(400)
    }
    throw new Error(`timed out: ${label}`)
  }

  // A weekly task with a due date in the past — completing it must roll forward,
  // not persist `done` (nextDueCatchup lands it on-or-after today).
  const task = await evaluate<{ id: string; due: string; version: number }>(
    trpc('tasks.create', 'mutation', {
      vaultId,
      title: TITLE,
      due: '2020-01-06',
      recurrence: { frequency: 'weekly', interval: 1 },
    }),
  )
  console.log(`  · created ${task.id.slice(0, 8)} due ${task.due} v${task.version}`)

  const before = await waitFor(() => fileFor(task.id), 'the task file to be projected')
  console.log(`  ✓ projected to disk:\n${before.split('\n').map((l) => `      ${l}`).join('\n')}`)
  if (!before.includes('due: 2020-01-06')) throw new Error('the file does not carry the due date')
  if (!before.includes('recurrence:')) throw new Error('the file does not carry the recurrence')

  // Complete it. The server rolls the due date forward and pushes the new record;
  // the projector rewrites the file underneath whoever is reading it.
  const rolled = await evaluate<{ status: string; due: string; version: number }>(
    trpc('tasks.complete', 'mutation', { vaultId, taskId: task.id }),
  )
  console.log(`  · completed → status ${rolled.status}, due ${rolled.due}, v${rolled.version}`)
  if (rolled.status !== 'todo') throw new Error(`expected a roll-forward, got status ${rolled.status}`)
  if (rolled.due <= '2020-01-06') throw new Error('the due date did not roll forward')

  const after = await waitFor(
    async () => {
      const text = await fileFor(task.id)
      return text?.includes(`due: ${rolled.due}`) ? text : null
    },
    'the server-driven rewrite to land on disk',
  )
  console.log(`  ✓ the file changed under us (server-driven rewrite):\n${after.split('\n').map((l) => `      ${l}`).join('\n')}`)

  // THE INVARIANT: that rewrite was a foreign write. If task files were CRDT docs
  // it would have opened a turn. It must not have.
  const docs = await evaluate<string[]>(
    `${trpc('vaults.listDocs', 'query', { vaultId })}.then(r => r.docs.filter(d => d.path.startsWith('tasks/')).map(d => d.path))`,
  )
  if (docs.length > 0) throw new Error(`task files leaked into the doc store: ${docs.join(', ')}`)
  console.log('  ✓ no task file is a CRDT doc — the roll-forward opened no turn')

  const status = await evaluate<{ working: boolean }>('window.holi.agent.status()')
  if (status.working) throw new Error('an agent turn is open — the rewrite opened a spurious turn')
  console.log('  ✓ agent turn state is idle')

  await evaluate(trpc('tasks.delete', 'mutation', { vaultId, taskId: task.id }))
  console.log('\n  recurrence-roll invariant holds')
  ws.close()
}

main().catch((err) => {
  console.error(`\n  ✗ ${err.message}`)
  process.exit(1)
})
