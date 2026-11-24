import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const nativeReasons = new Set([
  'invalid-observation-request',
  'fixture-ownership',
  'process-identity',
  'process-changed',
  'missing-start-identity',
  'screen-capture-permission',
  'accessibility-permission',
  'evidence-directory',
  'evidence-already-exists',
  'ambiguous-accessibility-window',
  'blocking-modal',
  'connections-panel-not-asserted',
  'connections-panel-changed',
  'ambiguous-capture-window',
  'image-encoding',
  'image-output',
  'window-capture-failed',
])

async function privateDirectory(path) {
  const info = await lstat(path)
  return (
    info.isDirectory() &&
    !info.isSymbolicLink() &&
    info.uid === process.getuid() &&
    (info.mode & 0o077) === 0
  )
}

async function endpointAt(profile) {
  if (!(await privateDirectory(profile))) throw new Error('unsafe endpoint')
  const file = await open(
    join(profile, 'cli-endpoint.json'),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  )
  try {
    const info = await file.stat()
    if (
      !info.isFile() ||
      info.uid !== process.getuid() ||
      (info.mode & 0o077) !== 0 ||
      info.size > 8192
    )
      throw new Error('unsafe endpoint')
    const endpoint = JSON.parse(await file.readFile('utf8'))
    if (
      endpoint.host !== '127.0.0.1' ||
      !Number.isInteger(endpoint.port) ||
      endpoint.port < 1 ||
      endpoint.port > 65535 ||
      !/^[a-f0-9]{64}$/.test(endpoint.token)
    )
      throw new Error('unsafe endpoint')
    return endpoint
  } finally {
    await file.close()
  }
}

/** Bind the shipped app's backend and visible Google panel to one owned first launch. */
export async function observeFirstTargetConnections({
  run,
  helper,
  fixtureRoot,
  bundlePath,
  teamIdentifier,
  pid,
  notBeforeMicros,
  expectedStartMicros,
  profile,
  vaultPath,
  remote,
  evidenceDirectory,
  email,
  signal,
}) {
  let identity
  const failed = (outcome, reason) => ({
    outcome,
    reason,
    ...(identity ? { pid, startMicros: identity.startMicros, signatureVerified: true } : {}),
    backendBoundToTarget: false,
    googleConnectionsPanelAsserted: false,
    screenshot: null,
  })
  const request = { fixtureRoot, bundlePath, teamIdentifier, pid, notBeforeMicros }
  async function native(action) {
    const result = await run(helper, [], {
      input: JSON.stringify({
        ...request,
        action,
        expectedStartMicros: identity?.startMicros ?? expectedStartMicros,
        email,
        evidenceDirectory,
      }),
      signal,
      timeoutMs: 30_000,
      label: 'owned first-target observer',
    })
    return JSON.parse(result.output)
  }
  async function sameIdentity() {
    const result = await native('identify')
    return (
      result.outcome === 'identified' &&
      result.pid === pid &&
      result.startMicros === identity.startMicros &&
      result.signatureVerified === true &&
      result.uid === process.getuid()
    )
  }
  async function listenerState(endpoint) {
    let result
    try {
      result = await run(
        '/usr/sbin/lsof',
        ['-nP', '-a', `-iTCP@127.0.0.1:${endpoint.port}`, '-sTCP:LISTEN', '-Fp'],
        { signal, timeoutMs: 10_000, label: 'owned first-target listener' },
      )
    } catch (error) {
      if (error.exitCode === 1) return 'absent'
      throw error
    }
    const owners = new Set(
      [...result.output.matchAll(/^p(\d+)$/gm)].map((match) => Number(match[1])),
    )
    if (!owners.size) return 'absent'
    return owners.size === 1 && owners.has(pid) ? 'owned' : 'foreign'
  }
  try {
    const root = await realpath(fixtureRoot)
    const evidence = await realpath(evidenceDirectory)
    const vault = await realpath(vaultPath)
    if (!(await privateDirectory(profile)) || !(await privateDirectory(evidenceDirectory)))
      return failed('ownership-refused', 'unsafe-endpoint-descriptor')
    const localProfile = await realpath(profile)
    const rel = relative(root, evidence)
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || !(await privateDirectory(evidence)))
      return failed('ownership-refused', 'evidence-directory')
    request.fixtureRoot = root
    const initial = await native('identify')
    if (
      initial.outcome !== 'identified' ||
      initial.pid !== pid ||
      initial.signatureVerified !== true ||
      initial.uid !== process.getuid() ||
      !Number.isSafeInteger(initial.startMicros) ||
      initial.startMicros < notBeforeMicros ||
      initial.startMicros !== expectedStartMicros
    )
      return failed('ownership-refused', 'process-identity')
    identity = initial
    let endpoint
    let usedEndpoint
    let overview
    const deadline = Date.now() + 30_000
    const pause = () => delay(200, undefined, { signal })
    while (Date.now() < deadline && !overview) {
      if (!(await sameIdentity())) return failed('ownership-refused', 'process-changed')
      try {
        endpoint = await endpointAt(localProfile)
      } catch (error) {
        if (error.code !== 'ENOENT')
          return failed('ownership-refused', 'unsafe-endpoint-descriptor')
        await pause()
        continue
      }
      if (
        usedEndpoint &&
        (usedEndpoint.port !== endpoint.port || usedEndpoint.token !== endpoint.token)
      )
        return failed('ownership-refused', 'endpoint-changed')
      const listener = await listenerState(endpoint)
      if (listener === 'foreign') return failed('ownership-refused', 'backend-listener')
      if (listener === 'absent') {
        await pause()
        continue
      }
      const latest = await endpointAt(localProfile)
      if (latest.port !== endpoint.port || latest.token !== endpoint.token) {
        if (usedEndpoint) return failed('ownership-refused', 'endpoint-changed')
        await pause()
        continue
      }
      if (!(await sameIdentity())) return failed('ownership-refused', 'process-changed')
      // Released .276's authenticated machine CLI transport resolves this exact vault.
      const form = new URLSearchParams({ cwd: vault })
      for (const value of ['google', 'accounts', '--json', '--vault', remote])
        form.append('argv', value)
      const timeout = AbortSignal.timeout(Math.max(1, Math.min(15_000, deadline - Date.now())))
      usedEndpoint = endpoint
      const response = await fetch(`http://127.0.0.1:${endpoint.port}/cli`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'x-holi-cli-token': endpoint.token,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      if (!(await sameIdentity()) || (await listenerState(endpoint)) !== 'owned')
        return failed('ownership-refused', 'backend-listener-changed')
      const current = await endpointAt(localProfile)
      if (current.port !== endpoint.port || current.token !== endpoint.token)
        return failed('ownership-refused', 'endpoint-changed')
      if (!response.ok) {
        const message = await response.text()
        const starting =
          response.status === 422 &&
          (message === 'holi: unknown vault target; check --vault owner/repo' ||
            message ===
              'holi google.accounts: vault is closed; open it in Holi before running this command')
        if (!starting) return failed('observation-unavailable', 'target-cli-refused')
        await pause()
        continue
      }
      overview = await response.json()
    }
    if (!overview) return failed('observation-unavailable', 'backend-startup-timeout')
    if (
      overview.remote !== remote ||
      overview.state !== 'connected' ||
      overview.account?.email !== email ||
      overview.client?.source !== 'own'
    )
      return failed('assertion-failed', 'google-account-not-connected')
    const observed = await native('observe')
    if (observed.outcome !== 'observed') {
      const outcomes = new Set([
        'precondition-unavailable',
        'observation-unavailable',
        'assertion-failed',
        'ownership-refused',
      ])
      const result = failed(
        outcomes.has(observed.outcome) ? observed.outcome : 'observation-unavailable',
        nativeReasons.has(observed.reason) ? observed.reason : 'invalid-native-result',
      )
      result.backendBoundToTarget = true
      if (
        typeof observed.permissions?.screenCapture === 'boolean' &&
        typeof observed.permissions?.accessibility === 'boolean'
      )
        result.permissions = {
          screenCapture: observed.permissions.screenCapture,
          accessibility: observed.permissions.accessibility,
        }
      return result
    }
    if (
      observed.pid !== pid ||
      observed.startMicros !== identity.startMicros ||
      observed.signatureVerified !== true ||
      observed.googleConnectionsPanelAsserted !== true ||
      !Number.isSafeInteger(observed.windowId) ||
      observed.windowId <= 0 ||
      observed.permissions?.screenCapture !== true ||
      observed.permissions?.accessibility !== true ||
      observed.screenshot !== 'first-target-google-connected.png' ||
      !(await sameIdentity()) ||
      (await listenerState(endpoint)) !== 'owned'
    )
      return failed('ownership-refused', 'invalid-native-result')
    const image = await open(
      join(evidence, observed.screenshot),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    )
    try {
      const info = await image.stat()
      if (
        !info.isFile() ||
        info.uid !== process.getuid() ||
        (info.mode & 0o077) !== 0 ||
        info.size < 8 ||
        info.size > 20_000_000
      )
        return failed('ownership-refused', 'unsafe-image')
      const header = Buffer.alloc(8)
      await image.read(header, 0, 8, 0)
      if (!header.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        return failed('observation-unavailable', 'invalid-image')
    } finally {
      await image.close()
    }
    return {
      outcome: 'observed',
      pid,
      startMicros: identity.startMicros,
      signatureVerified: true,
      backendBoundToTarget: true,
      googleConnectionsPanelAsserted: true,
      windowId: observed.windowId,
      screenshot: observed.screenshot,
      permissions: { screenCapture: true, accessibility: true },
    }
  } catch {
    return failed('observation-unavailable', 'first-target-observation-failed')
  }
}
