// ABI sanity check: run with the Electron binary as node
// (ELECTRON_RUN_AS_NODE=1 pnpm exec electron scripts/check-node-pty.cjs)
// so a bad rebuild fails here instead of at app boot.
const pty = require('node-pty')

// cmd.exe has no /bin/echo to spawn.
const [file, args] =
  process.platform === 'win32'
    ? [process.env.ComSpec || 'cmd.exe', ['/c', 'echo', 'node-pty-ok']]
    : ['/bin/echo', ['node-pty-ok']]

const child = pty.spawn(file, args, {
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
