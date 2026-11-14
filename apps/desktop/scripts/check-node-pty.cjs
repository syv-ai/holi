// ABI sanity check: run with the Electron binary as node
// (ELECTRON_RUN_AS_NODE=1 pnpm exec electron scripts/check-node-pty.cjs)
// so a bad rebuild fails here instead of at app boot.
const pty = require('node-pty')

const child = pty.spawn(
  process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : process.execPath,
  process.platform === 'win32'
    ? ['/d', '/c', 'echo node-pty-ok && set /p reply=']
    : [
        '-e',
        'process.stdout.write("node-pty-ok\\n");process.stdin.on("data",()=>process.exit(0));process.stdin.resume()',
      ],
  { name: 'xterm-256color', cols: 80, rows: 24 },
)

let output = ''
let acknowledged = false
child.onData((chunk) => {
  output += chunk
  if (!acknowledged && output.includes('node-pty-ok')) {
    acknowledged = true
    child.write('done\r')
  }
})

child.onExit(({ exitCode }) => {
  if (output.includes('node-pty-ok')) {
    console.log('node-pty OK')
    process.exit(0)
  }
  console.error(`node-pty exited ${exitCode} with unexpected output: ${JSON.stringify(output)}`)
  process.exit(1)
})

setTimeout(() => {
  console.error('node-pty check timed out')
  process.exit(1)
}, 5000)
