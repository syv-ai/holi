// ABI sanity check: run with the Electron binary as node
// (ELECTRON_RUN_AS_NODE=1 pnpm exec electron scripts/check-node-pty.cjs)
// so a bad rebuild fails here instead of at app boot.
const pty = require('node-pty')

const child = pty.spawn('/bin/echo', ['node-pty-ok'], {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
})

let output = ''
child.onData((chunk) => {
  output += chunk
})

child.onExit(() => {
  if (output.includes('node-pty-ok')) {
    console.log('node-pty OK')
    process.exit(0)
  }
  console.error(`node-pty produced unexpected output: ${JSON.stringify(output)}`)
  process.exit(1)
})

setTimeout(() => {
  console.error('node-pty check timed out')
  process.exit(1)
}, 5000)
