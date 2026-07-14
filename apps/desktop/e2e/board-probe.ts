/**
 * The board, live, in the real app (prd/tasks.md §Board UX).
 *
 * Asserts against the **DOM**, not the atoms — the point is the whole chain:
 *
 *   a task FILE edited on disk  ->  projector  ->  tRPC  ->  record
 *     ->  SSE (main)  ->  IPC push  ->  renderer  ->  the card moves
 *
 * and the card's one affordance:
 *
 *   click the checkbox  ->  tasks.complete  ->  server rolls the recurrence
 *     ->  the task comes BACK to Todo with a new due date (it does not go Done)
 *
 *   HOLI_DEV_TOKEN=<t> pnpm --filter @holi/server exec tsx ../desktop/e2e/board-probe.ts
 */
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

const CDP_PORT = Number(process.env.CDP_PORT ?? 9223)
const TOKEN = process.env.HOLI_DEV_TOKEN!
const RUN = Date.now().toString(36).slice(-5)
const TITLE = `Board probe ${RUN}`
const RETITLED = `Retitled by file ${RUN}`

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

async function waitFor<T>(fn: () => Promise<T>, label: string, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const v = await fn().catch(() => null as T)
    if (v) return v
    await sleep(400)
  }
  throw new Error(`timed out: ${label}`)
}

/** The card as the USER sees it: its column, and whether its title is on screen. */
const cardColumn = (title: string) => `(() => {
  const cells = [...document.querySelectorAll('[data-cell]')]
  const hit = cells.find(c => c.textContent.includes(${JSON.stringify(title)}))
  return hit ? hit.getAttribute('data-cell') : null
})()`

async function main() {
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
  if (!vaultId) throw new Error('no active vault')

  // Show the board.
  await evaluate(
    `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'board')?.click()`,
  )
  await sleep(400)
  const onBoard = await evaluate<boolean>(`!!document.querySelector('[data-cell]')`)
  if (!onBoard) throw new Error('the board did not render')
  console.log('  ✓ the board renders')

  // A recurring task, overdue — so it also proves the `overdue` + p1 virtual labels.
  const task = await evaluate<{ id: string; due: string }>(
    trpc('tasks.create', 'mutation', {
      vaultId,
      title: TITLE,
      due: '2020-01-06',
      priority: 'high',
      recurrence: { frequency: 'weekly', interval: 1 },
    }),
  )

  // It must appear WITHOUT a refetch — this is the SSE → IPC → renderer push.
  const col = await waitFor(() => evaluate<string | null>(cardColumn(TITLE)), 'the card to appear')
  console.log(`  ✓ the card arrived by push (no refetch), in cell: ${col}`)
  if (!col.startsWith('todo')) throw new Error(`expected the card in todo, got ${col}`)

  const chips = await evaluate<string>(`(() => {
    const card = [...document.querySelectorAll('[data-task]')]
      .find(c => c.textContent.includes(${JSON.stringify(TITLE)}))
    return [...card.querySelectorAll('span')].map(s => s.textContent).join(' ')
  })()`)
  if (!chips.includes('overdue')) throw new Error(`no overdue chip — got: ${chips}`)
  if (!chips.includes('p1')) throw new Error(`no p1 chip — got: ${chips}`)
  console.log('  ✓ virtual labels render (overdue, p1) — computed, never stored (D41)')

  // ---- the agent's path: edit the FILE on disk, watch the board follow.
  const tasksDir = join(
    homedir(),
    'Library/Application Support/@holi/desktop/working-copies',
    vaultId,
    'tasks',
  )
  const name = await waitFor(
    async () => (await readdir(tasksDir)).find((n) => n.includes(task.id)) ?? null,
    'the task file to be projected',
  )
  const text = await readFile(join(tasksDir, name), 'utf8')
  await writeFile(join(tasksDir, name), text.replace(`title: ${TITLE}`, `title: ${RETITLED}`), 'utf8')

  await waitFor(() => evaluate<string | null>(cardColumn(RETITLED)), 'the card to follow the FILE edit')
  console.log('  ✓ a task FILE edited on disk moved the card — file → record → SSE → board')

  // ---- the card's one affordance: complete a RECURRING task.
  // Scope to the CARD, not the cell: a cell holds many cards, and grabbing the cell's
  // first checkbox completes whichever task happens to sit at the top of the column.
  const clicked = await evaluate<boolean>(`(() => {
    const card = [...document.querySelectorAll('[data-task]')]
      .find(c => c.textContent.includes(${JSON.stringify(RETITLED)}))
    if (!card) return false
    card.querySelector('input[type=checkbox]').click()
    return true
  })()`)
  if (!clicked) throw new Error('could not find the card to complete')

  const rolled = await waitFor(
    async () => {
      const r = await evaluate<{ status: string; due: string }>(
        trpc('tasks.get', 'query', { vaultId, taskId: task.id }),
      )
      return r && r.due > '2020-01-06' ? r : null
    },
    'the recurrence to roll forward',
  )
  if (rolled.status !== 'todo')
    throw new Error(`a recurring task must ROLL, not persist done — got ${rolled.status}`)
  console.log(`  ✓ the checkbox rolled the recurrence: status=todo, due ${rolled.due} (was 2020-01-06)`)

  const back = await waitFor(
    () => evaluate<string | null>(cardColumn(RETITLED)),
    'the rolled task to come back to Todo on the board',
  )
  if (!back.startsWith('todo')) throw new Error(`expected it back in todo, got ${back}`)
  console.log('  ✓ and the card came back to Todo — it never went to Done')

  // ---- drag: one drop is one patch (D42). Synthesize the HTML5 drag events.
  const dragged = await evaluate<boolean>(`(() => {
    const card = [...document.querySelectorAll('[data-task]')]
      .find(c => c.textContent.includes(${JSON.stringify(RETITLED)}))
    const target = document.querySelector('[data-cell="doing:(no area)"]')
    if (!card || !target) return false
    const dt = new DataTransfer()
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }))
    return true
  })()`)
  if (!dragged) throw new Error('could not synthesize the drag')

  const moved = await waitFor(
    async () => {
      const r = await evaluate<{ status: string }>(trpc('tasks.get', 'query', { vaultId, taskId: task.id }))
      return r?.status === 'doing' ? r : null
    },
    'the drag to reach the record',
  )
  console.log(`  ✓ dragging the card to Doing set status=${moved.status} on the record`)

  const cellNow = await waitFor(
    () => evaluate<string | null>(cardColumn(RETITLED)),
    'the card to settle in Doing',
  )
  if (!cellNow.startsWith('doing')) throw new Error(`expected the card in doing, got ${cellNow}`)
  console.log('  ✓ and the board shows it there')

  console.log('\n  ALL BOARD CHECKS PASSED')
  ws.close()
}

main().catch((err) => {
  console.error(`\n  ✗ ${err.message}`)
  process.exit(1)
})
