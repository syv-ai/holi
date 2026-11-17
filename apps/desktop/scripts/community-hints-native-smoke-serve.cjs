const http = require('node:http')
const fs = require('node:fs')
const port = Number(process.argv[process.argv.indexOf('--port') + 1])
fs.writeFileSync(require('node:path').join(process.cwd(), '.hint-smoke-pid'), String(process.pid))
const page = `<!doctype html><html><head><meta charset="utf-8"><style>
:root{color-scheme:light dark}body{font:16px system-ui;padding:24px;margin:0}button,input,summary,a{font:inherit;margin:12px;padding:12px}section{padding:16px}#offscreen{position:absolute;top:3000px}
</style></head><body><h1>Community keyboard fixture</h1><p id="output">No activation yet</p><section>
<button id="setup">Run fixture setup</button><button disabled>Disabled fixture</button><button hidden>Hidden fixture</button>
<a href="#destination">Fixture destination</a><details><summary>Expand fixture</summary><p>Expanded content</p></details>
<button id="activate">Native button</button><input aria-label="Editable fixture" placeholder="Ordinary typing"><button id="offscreen">Offscreen fixture</button><button id="add-target">Temporary target</button><button id="overlay-toggle">Open overlay</button><div id="overlay" role="dialog" hidden><button>Overlay action</button></div><input aria-label="Composition fixture" placeholder="Composition fixture"></section>
<script>window.fixtureGeneration=performance.timeOrigin;window.fixtureClicks=0;document.querySelector('#activate').onclick=()=>{fixtureClicks++;document.querySelector('#output').textContent='Activation '+fixtureClicks};document.querySelector('#add-target').onclick=()=>{const button=document.createElement('button');button.id='dynamic-target';button.textContent='Dynamic target';document.querySelector('section').append(button);document.querySelector('#output').textContent='Temporary target added'};document.querySelector('#overlay-toggle').onclick=()=>document.querySelector('#overlay').hidden=!document.querySelector('#overlay').hidden;document.querySelector('#setup').onclick=()=>fetch('/setup',{method:'POST'}).then(()=>document.querySelector('#output').textContent='Setup complete');</script>
<script src="/holi-hints.js"></script></body></html>`
const server = http.createServer((request, response) => {
  if (request.url === '/setup' && request.method === 'POST') {
    fs.writeFileSync(
      require('node:path').join(process.cwd(), '.hint-smoke-setup'),
      'setup-complete',
    )
    response.writeHead(204).end()
    return
  }
  response.setHeader(
    'Content-Type',
    request.url === '/holi-hints.js' ? 'application/javascript' : 'text/html',
  )
  response.end(
    request.url === '/holi-hints.js' ? fs.readFileSync(process.env.HOLI_BRIDGE_SCRIPT) : page,
  )
})
server.listen(port, '127.0.0.1', () => console.log('community fixture listening', port))
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => server.close(() => process.exit()))
