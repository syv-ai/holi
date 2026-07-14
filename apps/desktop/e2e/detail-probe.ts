/**
 * The detail view + the presence heartbeat, in the real app (board slice 2).
 *
 * The heartbeat only means anything if **someone else** sees it, so this probe becomes
 * that someone else: it opens its OWN subscription to the vault's SSE stream — a second
 * client, exactly like a teammate's app — and asserts the `presence` frame shows up
 * there when the user types.
 *
 * It also pins the rule that makes presence bearable: the heartbeat is driven by
 * **edits, not focus**. Opening a task must NOT light up a teammate's card.
 *
 *   HOLI_DEV_TOKEN=<t> pnpm --filter @holi/server exec tsx ../desktop/e2e/detail-probe.ts
 */
import WebSocket from 'ws'

const CDP_PORT = Number(process.env.CDP_PORT ?? 9223)
const API = process.env.HOLI_API ?? 'http://127.0.0.1:4000'
const TOKEN = process.env.HOLI_DEV_TOKEN!
const RUN = Date.now().toString(36).slice(-5)
const TITLE = `Detail probe ${RUN}`
const BODY = 'typed into the description'

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
    await sleep(300)
  }
  throw new Error(`timed out: ${label}`)
}

/** A second client on the vault's SSE stream — i.e. the teammate. */
type Frame = { channel: string; data: Record<string, unknown> }
async function subscribe(vaultId: string, sink: Frame[]): Promise<void> {
  const res = await fetch(`${API}/events/${vaultId}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  if (!res.ok || !res.body) throw new Error(`SSE subscribe failed: ${res.status}`)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buf += dec.decode(value, { stream: true })
      let sep: number
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, sep)
        buf = buf.slice(sep + 2)
        let channel = ''
        const lines: string[] = []
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) channel = line.slice(6).trim()
          else if (line.startsWith('data:')) lines.push(line.slice(5).trim())
        }
        if (channel && lines.length) {
          try {
            sink.push({ channel, data: JSON.parse(lines.join('\n')) })
          } catch {
            /* ignore */
          }
        }
      }
    }
  })()
}

/** Type into a React-controlled field: set the value through the native setter, then
 * dispatch `input`, or React never learns about it. */
const typeInto = (selector: string, text: string) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  if (!el) return false
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set
  setter.call(el, ${JSON.stringify(text)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return true
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

  const frames: Frame[] = []
  await subscribe(vaultId, frames)
  console.log('  ✓ subscribed to the vault stream as a second client (the "teammate")')

  await evaluate(
    `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'board')?.click()`,
  )
  await sleep(300)

  const task = await evaluate<{ id: string }>(
    trpc('tasks.create', 'mutation', { vaultId, title: TITLE }),
  )
  await waitFor(
    () => evaluate<boolean>(`!!document.querySelector('[data-task="${task.id}"]')`),
    'the card to appear',
  )

  // ---- open the detail view by clicking the card
  await evaluate(`document.querySelector('[data-task="${task.id}"]').click()`)
  const open = await waitFor(
    () => evaluate<boolean>(`!!document.querySelector('[data-task-detail="${task.id}"]')`),
    'the detail view to open',
  )
  if (!open) throw new Error('the detail view did not open')
  console.log('  ✓ clicking the card opens the detail view')

  // ---- merely opening it must NOT announce you are editing
  const presenceCount = () => frames.filter((f) => f.channel === 'presence').length
  await sleep(2500)
  if (presenceCount() > 0)
    throw new Error('a heartbeat fired on FOCUS — opening a task must not light up a teammate’s card')
  console.log('  ✓ opening a task sends NO heartbeat — presence is edit-driven, not focus-driven')

  // ---- now type. THIS is editing.
  const typed = await evaluate<boolean>(typeInto('[data-detail-description]', BODY))
  if (!typed) throw new Error('could not find the description field')

  const beat = await waitFor(async () => frames.find((f) => f.channel === 'presence') ?? null, 'a presence frame to reach the teammate')
  console.log(`  ✓ typing announced presence to the other client: ${JSON.stringify(beat.data)}`)
  if (beat.data.taskId !== task.id) throw new Error('the heartbeat named the wrong task')
  if (!beat.data.name) throw new Error('the heartbeat carries no identity to display')
  if ('actor' in beat.data)
    throw new Error('the heartbeat carries an `actor` field — a user and their agent are ONE identity (D37)')
  console.log('  ✓ it carries the user’s identity, and no `actor` field (D37)')

  // ---- and the edit itself lands (debounced)
  const saved = await waitFor(
    async () => {
      const r = await evaluate<{ description?: string }>(
        trpc('tasks.get', 'query', { vaultId, taskId: task.id }),
      )
      return r?.description === BODY ? r : null
    },
    'the debounced description to save',
  )
  console.log(`  ✓ the description saved: "${saved.description}"`)

  // ---- the heartbeat stops on its own. A heartbeat that stops arriving IS the release.
  const before = presenceCount()
  await sleep(6000)
  const after = presenceCount()
  if (after > before)
    throw new Error(`heartbeats kept firing after typing stopped (${before} -> ${after})`)
  console.log('  ✓ the heartbeat stopped when the typing did — expiry is the release')

  console.log('\n  ALL DETAIL + PRESENCE CHECKS PASSED')
  ws.close()
  process.exit(0)
}

main().catch((err) => {
  console.error(`\n  ✗ ${err.message}`)
  process.exit(1)
})
