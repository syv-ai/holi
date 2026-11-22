import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

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

export async function stopOwnedCommunityFixture({
  installedCode,
  pluginPort,
  filename = 'slides.md',
  sleep,
  run = execFileSync,
  signal = process.kill,
}) {
  if (!installedCode) return { pid: 0, stopped: true }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename))
    throw new Error(`refusing unsafe fixture filename ${filename}`)
  const marker = join(installedCode, '.hint-smoke-pid')
  const pid = Number(await readFile(marker, 'utf8').catch(() => '0'))
  if (!(pid > 0)) return { pid: 0, stopped: true }

  try {
    signal(pid, 0)
  } catch (error) {
    if (error.code === 'ESRCH') return { pid, stopped: true }
    throw error
  }
  const command = run('ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
  }).trim()
  const cwd = run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
    encoding: 'utf8',
  })
    .split('\n')
    .find((line) => line.startsWith('n'))
    ?.slice(1)
  const expectedCommand = `${process.execPath} serve.cjs ${filename} --port ${pluginPort}`
  if (
    !command.includes(expectedCommand) ||
    cwd !== installedCode ||
    (await readFile(marker, 'utf8')) !== String(pid)
  )
    throw new Error(`refusing to signal unverified fixture PID ${pid}`)

  signal(pid, 'SIGTERM')
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      signal(pid, 0)
    } catch (error) {
      if (error.code === 'ESRCH') return { pid, stopped: true }
      throw error
    }
    await sleep(100)
  }
  try {
    signal(pid, 'SIGKILL')
  } catch (error) {
    if (error.code === 'ESRCH') return { pid, stopped: true }
    throw error
  }
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      signal(pid, 0)
    } catch (error) {
      if (error.code === 'ESRCH') return { pid, stopped: true }
      throw error
    }
    await sleep(100)
  }
  try {
    signal(pid, 0)
    return { pid, stopped: false }
  } catch (error) {
    if (error.code === 'ESRCH') return { pid, stopped: true }
    throw error
  }
}
