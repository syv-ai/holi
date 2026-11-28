import { createServer } from 'node:https'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises'
import { join } from 'node:path'

const exec = promisify(execFile)

/** Disposable authenticated smart-HTTP Git service; never forwards credentials to Git. */
export async function createManagedGitFixture(parent) {
  const root = join(parent, 'managed-fixture')
  await mkdir(join(root, 'repos/fixture'), { recursive: true })
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  }
  const git = async (cwd, ...args) =>
    (await exec('git', ['-C', cwd, ...args], { env })).stdout.trim()
  const cert = join(root, 'cert.pem'),
    key = join(root, 'key.pem')
  await exec(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { env },
  )
  const seed = join(root, 'seed'),
    bare = join(root, 'repos/fixture/vault.git')
  await mkdir(seed)
  await git(seed, 'init', '--initial-branch=main')
  await git(seed, 'config', 'user.name', 'Holi fixture')
  await git(seed, 'config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(seed, 'main.md'), 'main branch bytes\n')
  await git(seed, 'add', '.')
  await git(seed, 'commit', '-m', 'main fixture')
  await git(seed, 'checkout', '-b', 'review/mobile')
  await mkdir(join(seed, 'assets'))
  await writeFile(join(seed, 'selected.md'), 'selected branch bytes\n')
  await writeFile(
    join(seed, 'assets/binary.bin'),
    Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
  )
  await writeFile(join(seed, 'run.sh'), '#!/bin/sh\nexit 0\n')
  await chmod(join(seed, 'run.sh'), 0o755)
  await git(seed, 'add', '.')
  await git(seed, 'commit', '-m', 'selected fixture')
  const selectedHead = await git(seed, 'rev-parse', 'HEAD')
  const protectedBranches = []
  for (const [name, path] of [
    ['secret', '.env'],
    ['local', 'USER.local.md'],
    ['ignored', 'node_modules/private.md'],
  ]) {
    await git(seed, 'checkout', '-B', `blocked/${name}`, selectedHead)
    if (path.includes('/')) await mkdir(join(seed, path, '..'), { recursive: true })
    await writeFile(join(seed, path), 'protected fixture bytes\n')
    await git(seed, 'add', '--force', path)
    await git(seed, 'commit', '-m', `protected ${name}`)
    protectedBranches.push(`blocked/${name}`)
  }
  await git(seed, 'checkout', 'review/mobile')
  const blob = await git(seed, 'rev-parse', `${selectedHead}:main.md`)
  const treePath = join(root, 'case-tree')
  await writeFile(
    treePath,
    Buffer.concat(
      ['Alias.md', 'alias.md'].map((name) =>
        Buffer.concat([Buffer.from(`100644 ${name}\0`), Buffer.from(blob, 'hex')]),
      ),
    ),
  )
  const tree = await git(seed, 'hash-object', '-t', 'tree', '-w', treePath)
  const collision = await git(
    seed,
    'commit-tree',
    tree,
    '-p',
    selectedHead,
    '-m',
    'case collision fixture',
  )
  await git(seed, 'update-ref', 'refs/heads/blocked/collision', collision)
  protectedBranches.push('blocked/collision')
  await exec('git', ['clone', '--bare', seed, bare], { env })
  await git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  await git(bare, 'config', 'http.receivepack', 'true')
  const password = randomBytes(24).toString('hex'),
    username = 'x-access-token'
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
  const tls = { cert: await readFile(cert), key: await readFile(key) }
  const requests = [],
    sockets = new Set(),
    children = new Set()
  let collectorRequests = 0,
    backendFailures = 0
  let collectorConnections = 0
  const collector = createServer(tls, (_request, response) => {
    collectorRequests++
    response.writeHead(500)
    response.end()
  })
  collector.on('connection', (socket) => {
    collectorConnections++
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve) => collector.listen(0, '127.0.0.1', resolve))
  const server = createServer(tls, (request, response) => {
    const url = new URL(request.url, 'https://127.0.0.1')
    if (url.pathname.startsWith('/fixture/drop.git/')) {
      request.socket.destroy()
      return
    }
    const authenticated = request.headers.authorization === authorization
    requests.push({ path: url.pathname, method: request.method, authenticated })
    if (url.pathname.startsWith('/fixture/redirect.git/')) {
      response.writeHead(302, {
        Location: `https://127.0.0.1:${collector.address().port}/fixture/collector.git/info/refs${url.search}`,
      })
      response.end()
      return
    }
    if (!authenticated) {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="disposable Git fixture"' })
      response.end()
      return
    }
    if (url.pathname.startsWith('/fixture/forbidden.git/')) {
      response.writeHead(403)
      response.end()
      return
    }
    if (
      !/^\/fixture\/vault\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.test(url.pathname)
    ) {
      response.writeHead(404)
      response.end()
      return
    }
    const child = spawn('git', ['http-backend'], {
      detached: true,
      env: {
        ...env,
        GIT_PROJECT_ROOT: join(root, 'repos'),
        GIT_HTTP_EXPORT_ALL: '1',
        REQUEST_METHOD: request.method,
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: request.headers['content-type'] ?? '',
        CONTENT_LENGTH: request.headers['content-length'] ?? '',
        REMOTE_USER: 'fixture',
        SERVER_PROTOCOL: 'HTTP/1.1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    children.add(child)
    let headers = Buffer.alloc(0),
      sent = false
    child.stdout.on('data', (chunk) => {
      if (sent) {
        response.write(chunk)
        return
      }
      headers = Buffer.concat([headers, chunk])
      const boundary = headers.indexOf('\r\n\r\n')
      if (boundary < 0) {
        if (headers.length > 65536) child.kill()
        return
      }
      const fields = {},
        lines = headers.subarray(0, boundary).toString().split('\r\n')
      let status = 200
      for (const line of lines) {
        const separator = line.indexOf(':')
        if (separator < 0) continue
        const name = line.slice(0, separator),
          value = line.slice(separator + 1).trim()
        if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0])
        else fields[name] = value
      }
      response.writeHead(status, fields)
      response.write(headers.subarray(boundary + 4))
      sent = true
    })
    child.stderr.resume()
    child.on('error', () => {
      backendFailures++
      response.destroy()
    })
    child.on('close', (code) => {
      children.delete(child)
      if (code !== 0) backendFailures++
      if (!sent && !response.headersSent) response.writeHead(502)
      response.end()
    })
    child.stdin.on('error', () => {})
    request.pipe(child.stdin)
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `https://127.0.0.1:${server.address().port}`
  return {
    root,
    seed,
    bare,
    cert,
    env,
    git,
    username,
    password,
    selectedHead,
    protectedBranches,
    requests,
    endpoint: `${origin}/fixture/vault.git`,
    origin,
    get collectorConnections() {
      return collectorConnections
    },
    get collectorRequests() {
      return collectorRequests
    },
    get backendFailures() {
      return backendFailures
    },
    async close() {
      for (const child of children) {
        try {
          process.kill(-child.pid, 'SIGTERM')
        } catch (error) {
          if (error.code !== 'ESRCH') throw error
        }
      }
      for (const socket of sockets) socket.destroy()
      await Promise.all(
        [server, collector].map(
          (item) =>
            new Promise((resolve, reject) =>
              item.close((error) => (error ? reject(error) : resolve())),
            ),
        ),
      )
      await rm(key, { force: true })
    },
  }
}
