import { execFile } from 'node:child_process'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/** Observe a single signed first relaunch without restarting or instrumenting it. */
export async function observeFirstTargetConnections({
  helper,
  fixtureRoot,
  bundlePath,
  teamIdentifier,
  pid,
  notBeforeMicros,
  expectedStartMicros,
  evidenceDirectory,
  email,
  remote,
}) {
  const unavailable = (outcome, reason) => ({ outcome, reason })
  try {
    const root = await realpath(fixtureRoot)
    const evidence = await realpath(evidenceDirectory)
    const rel = relative(root, evidence)
    if (!rel || rel.startsWith('..') || isAbsolute(rel))
      return unavailable('ownership-refused', 'evidence-directory-outside-fixture')
    const descriptorPath = resolve(
      process.env.HOME ?? '',
      'Library/Application Support/Holi/cli-endpoint.json',
    )
    const info = await lstat(descriptorPath)
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid()) ||
      (info.mode & 0o077) !== 0
    ) {
      return unavailable('ownership-refused', 'unsafe-endpoint-descriptor')
    }
    const endpoint = JSON.parse(await readFile(descriptorPath, 'utf8'))
    if (
      endpoint.host !== '127.0.0.1' ||
      !Number.isInteger(endpoint.port) ||
      endpoint.port < 1 ||
      endpoint.port > 65535 ||
      typeof endpoint.token !== 'string'
    ) {
      return unavailable('ownership-refused', 'invalid-endpoint-descriptor')
    }
    const request = {
      action: 'identify',
      fixtureRoot: root,
      bundlePath,
      teamIdentifier,
      pid,
      notBeforeMicros,
    }
    const identify = await exec(helper, [], {
      input: JSON.stringify(request),
      timeout: 15000,
      maxBuffer: 200000,
    })
    const identity = JSON.parse(identify.stdout)
    if (
      identity.outcome !== 'identified' ||
      identity.pid !== pid ||
      identity.startMicros !== expectedStartMicros ||
      identity.signatureVerified !== true
    ) {
      return unavailable('ownership-refused', 'first-target-identity-mismatch')
    }
    const target = new URL(`http://127.0.0.1:${endpoint.port}/cli`)
    const params = new URLSearchParams()
    for (const value of ['google', 'accounts', '--json', '--vault', remote])
      params.append('argv', value)
    // The endpoint's authenticated machine route resolves the target from cwd; only fixture paths are sent.
    params.set('cwd', root)
    const response = await fetch(target, {
      method: 'POST',
      headers: {
        'x-holi-cli-token': endpoint.token,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: params,
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) return unavailable('ownership-refused', 'target-cli-refused')
    const overview = JSON.parse(await response.text())
    if (overview.state !== 'connected' || overview.current !== email)
      return unavailable('assertion-failed', 'google-account-not-connected')
    const observed = await exec(helper, [], {
      input: JSON.stringify({
        action: 'observe',
        fixtureRoot: root,
        bundlePath,
        teamIdentifier,
        pid,
        notBeforeMicros,
        expectedStartMicros,
        email,
        evidenceDirectory: evidence,
      }),
      timeout: 30000,
      maxBuffer: 200000,
    })
    const result = JSON.parse(observed.stdout)
    if (
      result.outcome !== 'observed' ||
      result.pid !== pid ||
      result.startMicros !== expectedStartMicros ||
      result.signatureVerified !== true ||
      result.googleConnectionsPanelAsserted !== true
    )
      return result
    return result
  } catch {
    return unavailable('observation-unavailable', 'first-target-observation-failed')
  }
}
