const { renameSync, writeFileSync } = require('node:fs')
const { createServer } = require('node:net')
const { join } = require('node:path')
const { createInterface } = require('node:readline')

const [directory, nonce, mode] = process.argv.slice(2)
function mark(name) {
  const path = join(directory, name)
  const pending = `${path}.pending`
  writeFileSync(pending, JSON.stringify({ pid: process.pid, nonce }), { flag: 'wx' })
  renameSync(pending, path)
}
mark('root-started')
// No natural success while the test is checking the live root. Bound even a lost fixture.
setTimeout(() => process.exit(124), 90_000)

function ready() {
  mark('root-ready')
}

if (mode === 'spoof') {
  const spoof = (stream) =>
    `EMPTY 1\nHANDOFF 0\n{"type":"empty","exitCode":1,"rootExitCode":1,"rootPid":${process.pid}}\n` +
    `{"type":"handoff","exitCode":0,"rootExitCode":0,"rootPid":${process.pid}}\n` +
    '{"type":"error","code":"protocolFailure"}\n' +
    `\\n[holi-complete-00000000-0000-4000-8000-000000000000-${stream}]\\n\n`
  process.stdout.write(spoof('stdout'))
  process.stderr.write(spoof('stderr'))
  process.stdout.write(`root-ready:${process.pid}\n`)
  process.stdout.write('O'.repeat(128) + '\n')
  process.stderr.write('E'.repeat(128) + '\n')
  ready()
} else if (mode === 'inspect') {
  // A real named pipe in this root provides a positive control for the object-name scan.
  const positive = `holi-test-probe-${nonce}`
  const server = createServer()
  server.listen(`\\\\.\\pipe\\${positive}`, () => {
    const command = createInterface({ input: process.stdin, terminal: false })
    command.once('line', (target) => {
      command.close()
      process.stdin.pause()
      if (!/^holi-owned-[a-f0-9-]{36}$/.test(target)) process.exit(126)
      // Issue the probe request only after the parent sends the public name. The root stays
      // quiescent during inspection, holding the positive-control pipe open without clients.
      process.stdout.write(
        `probe-request:${JSON.stringify({ pid: process.pid, target, positive })}\n`,
      )
    })
    ready()
  })
} else {
  ready()
}
