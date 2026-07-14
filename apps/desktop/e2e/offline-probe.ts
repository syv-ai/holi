/**
 * The offline reconcile, in the real app (D39, D40 — plan
 * 2026-07-14-offline-task-reconcile.md).
 *
 * The app keeps RUNNING while the server dies. A task file is edited and another
 * is `rm`ed with nowhere to send them. When the server comes back, the SSE client
 * reconnects and the projector reconciles: the edit reaches the record, and the
 * delete is retried rather than the file being resurrected. No app restart.
 *
 * Two phases, because the middle of it is a server kill:
 *
 *   HOLI_DEV_TOKEN=<t> pnpm --filter @holi/server exec tsx ../desktop/e2e/offline-probe.ts setup
 *   <kill the server, edit/rm the files, restart the server>
 *   HOLI_DEV_TOKEN=<t> pnpm --filter @holi/server exec tsx ../desktop/e2e/offline-probe.ts verify
 */
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

const CDP_PORT = Number(process.env.CDP_PORT ?? 9223)
const TOKEN = process.env.HOLI_DEV_TOKEN!
const STATE = '/tmp/holi-offline-probe.json'
const PHASE = process.argv[2]

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

async function connect() {
  const targets = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()) as Array<{
    url: string
    webSocketDebuggerUrl: string
  }>
  const t = targets.find((x) => x.url.includes('localhost:5') || x.url.includes('index.html'))!
  ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise<void>((res, rej) => (ws.once('open', res), ws.once('error', rej)))
  await evaluate(`window.holi.auth.devSignIn(${JSON.stringify(TOKEN)})`)
  await sleep(600)
  const vaultId = await evaluate<string>(`document.querySelector('select')?.value || ''`)
  if (!vaultId) throw new Error('no active vault — is the app signed in?')
  const tasksDir = join(
    homedir(),
    'Library/Application Support/@holi/desktop/working-copies',
    vaultId,
    'tasks',
  )
  return { vaultId, tasksDir }
}

const fileNameFor = async (dir: string, id: string) =>
  (await readdir(dir).catch(() => [] as string[])).find((n) => n.includes(id)) ?? null

async function waitFor<T>(fn: () => Promise<T>, label: string, ms = 45_000): Promise<T> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const v = await fn()
    if (v) return v
    await sleep(500)
  }
  throw new Error(`timed out: ${label}`)
}

async function setup() {
  const { vaultId, tasksDir } = await connect()
  const run = Date.now().toString(36).slice(-5)

  const edited = await evaluate<{ id: string }>(
    trpc('tasks.create', 'mutation', {
      vaultId,
      title: `Offline edit ${run}`,
      priority: 'low',
      due: '2030-01-01',
    }),
  )
  const removed = await evaluate<{ id: string }>(
    trpc('tasks.create', 'mutation', { vaultId, title: `Offline rm ${run}` }),
  )

  const editedFile = await waitFor(() => fileNameFor(tasksDir, edited.id), 'the edit-target file')
  const removedFile = await waitFor(() => fileNameFor(tasksDir, removed.id), 'the rm-target file')

  await writeFile(
    STATE,
    JSON.stringify({ vaultId, tasksDir, run, edited: edited.id, removed: removed.id, editedFile, removedFile }),
  )
  console.log(`  ✓ created and projected two tasks`)
  console.log(`      edit target: tasks/${editedFile}`)
  console.log(`      rm target:   tasks/${removedFile}`)
  ws.close()
}

async function verify() {
  const s = JSON.parse(await readFile(STATE, 'utf8'))
  const { vaultId, tasksDir, run, edited, removed, removedFile } = s
  await connect()

  // The app has been disconnected; its SSE client is backing off. Reconnect fires
  // reconcile(), and only then can either change reach the record.
  console.log('  · waiting for the app to reconnect and reconcile…')

  const rec = await waitFor(
    async () => {
      const t = await evaluate<{ title: string; priority?: string; due?: string } | null>(
        trpc('tasks.get', 'query', { vaultId, taskId: edited }),
      ).catch(() => null)
      return t && t.title === `Edited while offline ${run}` ? t : null
    },
    'the offline EDIT to reach the record',
  )
  console.log(`  ✓ the offline edit landed: title = "${rec.title}"`)
  if (rec.priority !== 'low') throw new Error(`priority was clobbered: ${rec.priority}`)
  if (rec.due !== '2030-01-01') throw new Error(`due was clobbered: ${rec.due}`)
  console.log(`  ✓ fields the writer never touched survived (priority=low, due=2030-01-01)`)

  await waitFor(
    async () => {
      const t = await evaluate<unknown | null>(
        trpc('tasks.get', 'query', { vaultId, taskId: removed }),
      ).catch(() => 'gone')
      return t === null || t === 'gone' ? 'gone' : null
    },
    'the offline DELETE to reach the record',
  )
  console.log('  ✓ the offline rm reached the record — the task is deleted')

  await sleep(1500) // give any (wrong) re-materialization time to appear
  if (existsSync(join(tasksDir, removedFile)))
    throw new Error('the deleted task file was RESURRECTED — D40 regressed')
  console.log('  ✓ the file was not resurrected')

  console.log('\n  ALL OFFLINE-RECONCILE CHECKS PASSED')
  ws.close()
}

const main = PHASE === 'setup' ? setup : verify
main().catch((err) => {
  console.error(`\n  ✗ ${err.message}`)
  process.exit(1)
})
