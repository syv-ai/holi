const { spawn } = require('node:child_process')
const { existsSync, renameSync, writeFileSync, writeSync } = require('node:fs')
const { join } = require('node:path')

const [role, dir, nonce, stdio] = process.argv.slice(2)
const aborted = () => !existsSync(dir) || existsSync(join(dir, 'abort'))
const expires = performance.now() + 45_000 // Failure-only backstop; never evidence.
function ready() {
  writeFileSync(join(dir, `${role}.tmp`), JSON.stringify({ pid: process.pid, nonce }))
  renameSync(join(dir, `${role}.tmp`), join(dir, `${role}.json`))
}

if (role === 'grandchild') process.on('SIGTERM', () => {})
if (aborted()) process.exit(2)
ready()
let descendant
setInterval(() => {
  if (aborted() || performance.now() >= expires) process.exit(2)
  if (role !== 'root') return
  // The test holds the root HANDLE before permitting any descendant to start.
  if (!descendant && existsSync(join(dir, 'start-grandchild'))) {
    descendant = spawn(process.execPath, [__filename, 'grandchild', dir, nonce, stdio], {
      stdio,
      windowsHide: true,
    })
    descendant.on('error', () => process.exit(3))
  }
  for (const code of [0, 37]) {
    if (!existsSync(join(dir, `release-${code}`))) continue
    writeSync(1, 'fixture stdout\n')
    writeSync(2, 'fixture stderr\n')
    process.exit(code)
  }
}, 20)
