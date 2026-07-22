// Drive the running Holi window over CDP.
//   node cdp.mjs '<js expression>'   evaluate in the renderer
//   node cdp.mjs --focus             bring the window to front (fires BrowserWindow 'focus')
//   node cdp.mjs --type '<text>'     insert text as real input at the caret
//
// `--type` exists because the editor cannot be driven any other way: the
// EditorView lives inside EditorPane's effect closure and is never exposed, so
// there is no handle to dispatch a transaction through. `Input.insertText` goes
// in at the browser level, which is also the more honest test — it exercises
// CodeMirror's own input handling rather than reaching past it.
const list = await (await fetch('http://127.0.0.1:9333/json/list')).json()
const page = list.find((t) => t.type === 'page')
if (!page) { console.error('no page'); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
const [arg, arg2] = process.argv.slice(2)
await new Promise((r) => (ws.onopen = r))
const done = new Promise((resolve) => {
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    if (msg.id !== 1) return
    if (arg === '--focus') { console.log('focused'); return resolve() }
    if (arg === '--type') { console.log('typed'); return resolve() }
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
else if (arg === '--type') ws.send(JSON.stringify({ id: 1, method: 'Input.insertText', params: { text: arg2 } }))
else ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: arg, awaitPromise: true, returnByValue: true } }))
await done
ws.close()
