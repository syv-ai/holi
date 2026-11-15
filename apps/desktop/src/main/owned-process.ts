import { ChildProcess, type SpawnOptions } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { launchPlan, spawnProgram } from './launch'
import { spawnOwnedLaunch } from './owned-process-launch'

/**
 * Start a managed program whose lifetime includes every descendant it creates.
 * Windows runs the planned command in a kill-on-close Job Object; other
 * platforms retain detached process-group behavior.
 */
export function spawnOwnedProgram(
  bin: string,
  args: readonly string[],
  options: SpawnOptions,
  parentPid = process.pid,
): ChildProcess {
  if (process.platform !== 'win32') {
    return spawnProgram(bin, [...args], { ...options, detached: true })
  }
  const launchEnv = { ...(options.env ?? process.env) }
  const planningEnv = { ...launchEnv }
  for (const key of Object.keys(planningEnv)) {
    if (key.toUpperCase() === 'HOLI_OWNED_PROCESS_TRACE') delete planningEnv[key]
  }
  let plan
  try {
    plan = launchPlan(bin, args, {
      env: planningEnv,
      platform: 'win32',
      cwd: typeof options.cwd === 'string' ? options.cwd : process.cwd(),
    })
  } catch (failure) {
    const failed = new ChildProcess()
    const input = new PassThrough()
    const output = new PassThrough()
    const errors = new PassThrough()
    input.on('error', () => undefined)
    failed.stdin = input
    failed.stdout = output
    failed.stderr = errors
    process.nextTick(() => {
      failed.emit('error', failure as Error)
      input.destroy()
      output.end()
      errors.end()
      failed.emit('close', null, null)
    })
    return failed
  }
  return spawnOwnedLaunch(plan, options, parentPid)
}
