import type { SpawnOptions } from 'node:child_process'
import { launchPlan, spawnProgram } from './launch'
import { notStartedOwnedChild, spawnOwnedLaunch } from './owned-process-launch'
import type { ManagedOwnedChild } from './owned-program-lifetime'

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
): ManagedOwnedChild {
  if (process.platform !== 'win32') {
    return spawnProgram(bin, args, { ...options, detached: true })
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
    return notStartedOwnedChild(failure)
  }
  return spawnOwnedLaunch(plan, options, parentPid)
}
