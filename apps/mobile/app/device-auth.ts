export type DeviceAuthHttp = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export type DeviceAuthOptions = {
  clientId: string
  fetch: DeviceAuthHttp
  now?: () => number
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  signal?: AbortSignal
}

export type DeviceAuthorization = { userCode: string; verificationUri: string; expiresIn: number; token: string }

const endpoint = 'https://github.com/login/device/code'
const tokenEndpoint = 'https://github.com/login/oauth/access_token'

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('GitHub authorization returned an invalid response')
  return value as Record<string, unknown>
}

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

const defaultWait = (milliseconds: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(new Error('Authorization cancelled'))
  const timer = setTimeout(done, milliseconds)
  function done() { signal.removeEventListener('abort', abort); resolve() }
  function abort() { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('Authorization cancelled')) }
  signal.addEventListener('abort', abort, { once: true })
})

/** Runs GitHub's public OAuth device flow. A caller may cancel with signal. */
export async function authorizeWithGitHub(options: DeviceAuthOptions): Promise<DeviceAuthorization> {
  if (!options.clientId) throw new Error('GitHub OAuth client ID is required')
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) controller.abort()
  const signal = controller.signal
  const wait = options.wait ?? defaultWait
  const now = options.now ?? Date.now
  const request = async (url: string, body: URLSearchParams) => {
    if (signal.aborted) throw new Error('Authorization cancelled')
    let response
    try {
      response = await options.fetch(url, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(), signal })
    } catch {
      if (signal.aborted) throw new Error('Authorization cancelled')
      throw new Error('GitHub authorization request failed')
    }
    if (signal.aborted) throw new Error('Authorization cancelled')
    if (!response.ok) throw new Error(`GitHub authorization HTTP error (${response.status})`)
    try { return record(await response.json()) } catch { throw new Error('GitHub authorization returned an invalid response') }
  }
  try {
    const device = await request(endpoint, new URLSearchParams({ client_id: options.clientId, scope: 'repo' }))
    const deviceCode = safeString(device.device_code)
    const userCode = safeString(device.user_code)
    const verificationUri = safeString(device.verification_uri)
    const expiresIn = device.expires_in
    const interval = device.interval
    if (!deviceCode || !userCode || !verificationUri || typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0 || (interval !== undefined && (typeof interval !== 'number' || !Number.isFinite(interval) || interval < 0))) throw new Error('GitHub authorization returned an invalid response')
    const expiresAt = now() + expiresIn * 1000
    let delay = (typeof interval === 'number' ? interval : 5) * 1000
    while (now() < expiresAt) {
      await wait(Math.min(delay, Math.max(0, expiresAt - now())), signal)
      if (signal.aborted) throw new Error('Authorization cancelled')
      const result = await request(tokenEndpoint, new URLSearchParams({ client_id: options.clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }))
      const error = safeString(result.error)
      if (error === 'authorization_pending') continue
      if (error === 'slow_down') { delay += 5000; continue }
      if (error === 'access_denied') throw new Error('GitHub authorization was denied')
      if (error === 'expired_token') throw new Error('GitHub authorization expired')
      const token = safeString(result.access_token)
      if (!token) throw new Error('GitHub authorization returned an invalid response')
      if (signal.aborted) throw new Error('Authorization cancelled')
      return { userCode, verificationUri, expiresIn, token }
    }
    throw new Error('GitHub authorization expired')
  } finally {
    options.signal?.removeEventListener('abort', abort)
  }
}
