import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'

export function observeChild(child) {
  let exit = null
  let spawnFailure = null
  const closed = new Promise((resolve) => {
    child.once('error', (error) => {
      spawnFailure = error.message
      resolve({ error: error.message })
    })
    child.once('close', (code, signal) => {
      exit = { code, signal }
      resolve(exit)
    })
  })
  return {
    closed,
    get exit() {
      return exit
    },
    get spawnFailure() {
      return spawnFailure
    },
  }
}

export function startupDiagnostic(label, childState, logs) {
  return `Timed out: ${label}; childExit=${JSON.stringify(childState.exit)}; spawnFailure=${childState.spawnFailure}; logs=${logs}`
}

export async function stopOwnedCommunityFixture({ installedCode, pluginPort, sleep }) {
  if (!installedCode) return { pid: 0, stopped: true }
  const marker = `${installedCode}/.hint-smoke-pid`
  const pid = Number(await readFile(marker, 'utf8').catch(() => '0'))
  if (!(pid > 0)) return { pid: 0, stopped: true }

  try {
    process.kill(pid, 0)
  } catch (error) {
    if (error.code === 'ESRCH') return { pid, stopped: true }
    throw error
  }
  const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
  }).trim()
  const cwd = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
    encoding: 'utf8',
  })
    .split('\n')
    .find((line) => line.startsWith('n'))
    ?.slice(1)
  const expectedCommand = `${process.execPath} serve.cjs slides.md --port ${pluginPort}`
  if (
    !command.includes(expectedCommand) ||
    cwd !== installedCode ||
    (await readFile(marker, 'utf8')) !== String(pid)
  )
    throw new Error(`refusing to signal unverified fixture PID ${pid}`)

  process.kill(pid, 'SIGTERM')
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error.code === 'ESRCH') return { pid, stopped: true }
      throw error
    }
    await sleep(100)
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    if (error.code === 'ESRCH') return { pid, stopped: true }
    throw error
  }
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error.code === 'ESRCH') return { pid, stopped: true }
      throw error
    }
    await sleep(100)
  }
  try {
    process.kill(pid, 0)
    return { pid, stopped: false }
  } catch (error) {
    if (error.code === 'ESRCH') return { pid, stopped: true }
    throw error
  }
}
