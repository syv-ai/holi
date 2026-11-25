import { createServer as createHttpServer } from 'node:http'
import { createServer as createTlsServer } from 'node:https'
import { connect as tcpConnect } from 'node:net'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const fixtureHosts = new Set([
  'api.github.com',
  'oauth2.googleapis.com',
  'gmail.googleapis.com',
  'www.googleapis.com',
])
const updaterHosts = [
  /^github\.com$/,
  /(?:^|\.)githubusercontent\.com$/,
  /(?:^|\.)githubassets\.com$/,
  /^objects\.githubusercontent\.com$/,
  /^release-assets\.githubusercontent\.com$/,
]
const forbidden = (host) =>
  !host ||
  host.includes('@') ||
  host.endsWith('.') ||
  host === 'localhost' ||
  host === '::1' ||
  host.startsWith('127.') ||
  host.startsWith('10.') ||
  host.startsWith('192.168.') ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
  host === '0.0.0.0' ||
  host.includes(':')
const json = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** Create isolated local providers for a controlled native connection-upgrade run. */
export async function createUpgradeProviders(root) {
  const owned = new Set()
  const servers = new Set()
  let closed = false
  const stats = { requests: [] }
  await mkdir(root, { recursive: true })
  const temp = await mkdtemp(join(root, '.holi-upgrade-provider-'))
  const caKey = join(temp, 'ca.key'),
    caCert = join(temp, 'ca.pem'),
    key = join(temp, 'leaf.key'),
    cert = join(temp, 'leaf.pem'),
    ext = join(temp, 'leaf.ext')
  await writeFile(
    ext,
    `subjectAltName=${[...fixtureHosts].map((h) => `DNS:${h}`).join(',')}\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n`,
  )
  const openssl = (...args) => {
    const result = spawnSync('/usr/bin/openssl', args, { cwd: temp, stdio: 'ignore' })
    if (result.status !== 0) throw new Error('Unable to create local provider certificates')
  }
  try {
    openssl(
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      caKey,
      '-out',
      caCert,
      '-days',
      '2',
      '-subj',
      '/CN=Holi Upgrade Fixture CA',
    )
    openssl(
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      join(temp, 'leaf.csr'),
      '-subj',
      '/CN=api.github.com',
    )
    openssl(
      'x509',
      '-req',
      '-in',
      join(temp, 'leaf.csr'),
      '-CA',
      caCert,
      '-CAkey',
      caKey,
      '-CAcreateserial',
      '-out',
      cert,
      '-days',
      '2',
      '-extfile',
      ext,
    )
    const [tlsKey, tlsCert] = await Promise.all([readFile(key), readFile(cert)])
    const origin = createTlsServer({ key: tlsKey, cert: tlsCert }, async (req, res) => {
      const host = (req.headers.host || '').split(':')[0].toLowerCase()
      const path = new URL(req.url, `https://${host}`).pathname
      const method = req.method || 'GET'
      stats.requests.push({ method, path })
      if (host === 'api.github.com') {
        if (method !== 'GET') return json(res, { message: 'fixture is read-only' }, 405)
        if (path.startsWith('/repos/syv-ai/holi/releases')) {
          try {
            const upstream = await fetch(`https://api.github.com${req.url}`, {
              headers: { 'user-agent': 'holi-upgrade-fixture' },
              signal: AbortSignal.timeout(30000),
            })
            res.writeHead(upstream.status, {
              'content-type': upstream.headers.get('content-type') || 'application/json',
            })
            res.end(Buffer.from(await upstream.arrayBuffer()))
          } catch {
            json(res, { message: 'public release request unavailable' }, 502)
          }
          return
        }
        if (path === '/user') return json(res, { id: 565, login: 'holi-upgrade-fixture' })
        if (path === '/user/orgs' || path === '/user/repos') return json(res, [])
        const m = path.match(
          /^\/repos\/fixture-upgrade-565\/([\w-]+)(?:\/(collaborators|commits|contributors))?$/,
        )
        if (m)
          return m[2]
            ? json(res, [])
            : json(res, {
                id: 565,
                name: m[1],
                full_name: `fixture-upgrade-565/${m[1]}`,
                owner: { login: 'fixture-upgrade-565', type: 'User', avatar_url: '' },
                private: true,
                size: 1,
                default_branch: 'main',
                permissions: { admin: true, push: true, pull: true },
                clone_url: `https://github.com/fixture-upgrade-565/${m[1]}.git`,
              })
      }
      if (host === 'oauth2.googleapis.com') {
        if (method !== 'POST' || path !== '/token')
          return json(res, { error: 'invalid_request' }, 400)
        let body = ''
        req.on('data', (chunk) => {
          body += chunk
          if (body.length > 8192) req.destroy()
        })
        req.on('end', () => {
          const form = new URLSearchParams(body)
          const valid =
            form.get('client_id') === 'synthetic-test.apps.googleusercontent.com' &&
            form.get('refresh_token') === 'holi-upgrade-fixture-refresh-never-valid'
          if (!valid || form.get('grant_type') !== 'refresh_token')
            return json(res, { error: 'invalid_grant' }, 400)
          json(res, {
            access_token: 'fixture-access-token',
            token_type: 'Bearer',
            expires_in: 3600,
          })
        })
        return
      }
      if (method !== 'GET') return json(res, {}, 405)
      if (host === 'www.googleapis.com' && path === '/calendar/v3/users/me/calendarList')
        return json(res, { items: [] })
      if (host === 'gmail.googleapis.com' && path.endsWith('/profile'))
        return json(res, {
          emailAddress: 'holi-upgrade-fixture@example.invalid',
          historyId: '1',
          messagesTotal: 0,
          threadsTotal: 0,
        })
      if (host === 'gmail.googleapis.com' && path.endsWith('/labels'))
        return json(res, { labels: [] })
      if (
        host === 'gmail.googleapis.com' &&
        (path.endsWith('/threads') || path.endsWith('/history'))
      )
        return json(
          res,
          path.endsWith('/history')
            ? { history: [], historyId: '1' }
            : { threads: [], resultSizeEstimate: 0 },
        )
      json(res, { error: 'not_found' }, 404)
    })
    servers.add(origin)
    await new Promise((resolve, reject) => {
      origin.once('error', reject)
      origin.listen(0, '127.0.0.1', resolve)
    })
    const port = origin.address().port
    const proxy = createHttpServer()
    servers.add(proxy)
    proxy.on('connect', (req, client, head) => {
      const [host, portText] = req.url.split(':')
      const destPort = Number(portText)
      if (
        forbidden(host) ||
        destPort !== 443 ||
        (!fixtureHosts.has(host) && !updaterHosts.some((re) => re.test(host)))
      ) {
        client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
        return
      }
      if (fixtureHosts.has(host)) {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        const upstream = tcpConnect(port, '127.0.0.1')
        owned.add(client)
        owned.add(upstream)
        client.on('error', () => upstream.destroy())
        upstream.on('error', () => client.destroy())
        client.on('close', () => owned.delete(client))
        upstream.on('close', () => owned.delete(upstream))
        if (head.length) upstream.write(head)
        client.pipe(upstream).pipe(client)
      } else {
        const upstream = tcpConnect(destPort, host)
        owned.add(client)
        owned.add(upstream)
        upstream.once('connect', () => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          if (head.length) upstream.write(head)
          client.pipe(upstream).pipe(client)
        })
        upstream.on('error', () => client.destroy())
        client.on('error', () => upstream.destroy())
        client.on('close', () => owned.delete(client))
        upstream.on('close', () => owned.delete(upstream))
      }
    })
    await new Promise((resolve, reject) => {
      proxy.once('error', reject)
      proxy.listen(0, '127.0.0.1', resolve)
    })
    const proxyUrl = `http://127.0.0.1:${proxy.address().port}`
    return {
      env: {
        HTTP_PROXY: proxyUrl,
        HTTPS_PROXY: proxyUrl,
        NO_PROXY: 'localhost,127.0.0.1',
        NODE_USE_ENV_PROXY: '1',
        NODE_EXTRA_CA_CERTS: caCert,
      },
      stats,
      async close() {
        if (closed) return
        closed = true
        for (const socket of owned) socket.destroy()
        owned.clear()
        await Promise.all(
          [...servers].map(
            (server) =>
              new Promise((resolve) => {
                server.close(() => resolve())
                server.closeAllConnections?.()
              }),
          ),
        )
        await rm(temp, { recursive: true, force: true })
      },
    }
  } catch (error) {
    for (const socket of owned) socket.destroy()
    await Promise.all(
      [...servers].map(
        (server) =>
          new Promise((resolve) => {
            server.close(() => resolve())
            server.closeAllConnections?.()
          }),
      ),
    )
    await rm(temp, { recursive: true, force: true })
    throw error
  }
}
