// Drive the running Holi window over CDP.
//   node cdp.mjs '<js expression>'   evaluate in the renderer
//   node cdp.mjs --focus             bring the window to front (fires BrowserWindow 'focus')
const list = await (await fetch('http://127.0.0.1:9333/json/list')).json()
const page = list.find((t) => t.type === 'page')
if (!page) { console.error('no page'); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
const arg = process.argv[2]
await new Promise((r) => (ws.onopen = r))
const done = new Promise((resolve) => {
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    if (msg.id !== 1) return
    if (arg === '--focus') { console.log('focused'); return resolve() }
    const r = msg.result?.result
    if (msg.result?.exceptionDetails) {
      console.log('EXCEPTION:', msg.result.exceptionDetails.exception?.description ?? '?')
    } else {
      console.log(typeof r?.value === 'string' ? r.value : JSON.stringify(r?.value ?? r?.description ?? null))
    }
    resolve()
  }
})
if (arg === '--focus') ws.send(JSON.stringify({ id: 1, method: 'Page.bringToFront' }))
else ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: arg, awaitPromise: true, returnByValue: true } }))
await done
ws.close()
