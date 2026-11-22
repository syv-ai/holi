import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import { join } from 'node:path'
import { runCommand } from './host-checks.mjs'

const USER = 'holi-fixture'
const PASSWORD = 'disposable-fixture-password'
const COMMAND_TIMEOUT = 30_000

function signalChildGroup(child, signal) {
  if (!child.pid) return
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch {
    // A child may have exited; keep draining the remaining owned groups.
  }
}

function closeServer(server, sockets) {
  for (const socket of sockets) socket.destroy()
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

export async function createGitFixture(
  artifacts,
  runId,
  { execute = runCommand, spawnBackend = spawn } = {},
) {
  let root
  const servers = []
  const sockets = new Set()
  const children = new Set()
  const commandTasks = new Set()
  const requestTasks = new Set()
  const abortController = new AbortController()
  let closed = false
  let manifestPath
  let setupFailure
  let advanced = false
  let authChallenges = 0
  let backendFailures = 0
  const activeRequests = new Set()
  const git = (cwd, ...args) => {
    const task = runCommand('git', args, {
      cwd,
      timeout: COMMAND_TIMEOUT,
      signal: abortController.signal,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    })
    commandTasks.add(task)
    task.finally(() => commandTasks.delete(task)).catch(() => {})
    return task
  }
  const stopChildren = async () => {
    const owned = [...children]
    for (const child of owned) signalChildGroup(child, 'SIGTERM')
    if (owned.length) await new Promise((resolve) => setTimeout(resolve, 250))
    for (const child of owned) signalChildGroup(child, 'SIGKILL')
    await Promise.all(owned.map((child) => child.closed))
  }
  const close = async () => {
    if (closed) return
    closed = true
    try {
      abortController.abort()
      const stoppingChildren = stopChildren()
      for (const request of activeRequests) request.destroy(new Error('Fixture shutting down'))
      for (const socket of sockets) socket.destroy()
      await Promise.all([...requestTasks, ...commandTasks].map((task) => task.catch(() => {})))
      await stoppingChildren
      await stopChildren()
      await Promise.all(servers.map((server) => closeServer(server, sockets)))
      await Promise.all([...requestTasks, ...commandTasks].map((task) => task.catch(() => {})))
    } finally {
      try {
        if (manifestPath) {
          await writeFile(
            manifestPath,
            JSON.stringify(
              {
                runId,
                completed: !setupFailure && backendFailures === 0,
                ...(setupFailure ? { failure: String(setupFailure) } : {}),
                authChallenges,
                remoteAdvanced: advanced,
                backendFailures,
                tlsChallengesOnlyOnSimulator: true,
              },
              null,
              2,
            ),
          )
        }
      } finally {
        if (root) await rm(root, { recursive: true, force: true })
      }
    }
  }
  try {
    root = await mkdtemp(join(artifacts, `git-${runId}-`))
    const cert = join(root, 'fixture-ca.pem')
    const key = join(root, 'fixture-key.pem')
    const invalidCert = join(root, 'invalid-cert.pem')
    const invalidKey = join(root, 'invalid-key.pem')
    const repoRoot = join(root, 'repos')
    const work = join(root, 'seed')
    await mkdir(repoRoot)
    await mkdir(work)
    const san = 'subjectAltName=DNS:localhost,IP:127.0.0.1'
    await execute(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-keyout',
        key,
        '-out',
        cert,
        '-subj',
        '/CN=Holi owned simulator fixture',
        '-addext',
        san,
      ],
      { cwd: root, timeout: COMMAND_TIMEOUT },
    )
    await execute(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-keyout',
        invalidKey,
        '-out',
        invalidCert,
        '-subj',
        '/CN=invalid Holi TLS fixture',
      ],
      { cwd: root, timeout: COMMAND_TIMEOUT },
    )
    const bare = join(repoRoot, 'fixture.git')
    await git(root, 'init', '--bare', '--initial-branch=fixture-start', bare)
    await git(work, 'init', '--initial-branch=fixture-start')
    await writeFile(join(work, 'note.md'), 'HTTPS native clone\n')
    await writeFile(join(work, 'fixture.dat'), 'non-note fixture\n')
    await writeFile(join(work, 'fixture.bin'), Buffer.from([0, 1, 2, 0xff, 0x80]))
    await writeFile(join(work, 'executable.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    await git(work, 'add', '.')
    await git(
      work,
      '-c',
      'user.name=Holi Fixture',
      '-c',
      'user.email=fixture@invalid',
      'commit',
      '-m',
      'seed fixture',
    )
    await git(work, 'push', bare, 'HEAD:refs/heads/fixture-start')
    await git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/fixture-start')

    const auth = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`
    const server = createServer(
      { key: await readFile(key), cert: await readFile(cert) },
      (request, response) => {
        activeRequests.add(request)
        response.once('close', () => activeRequests.delete(request))
        response.once('finish', () => activeRequests.delete(request))
        const task = (async () => {
          if (request.headers.authorization !== auth) {
            authChallenges++
            response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Holi disposable fixture"' })
            response.end()
            return
          }
          const chunks = []
          for await (const chunk of request) chunks.push(chunk)
          const pathInfo = new URL(request.url, 'https://localhost').pathname
          const query = new URL(request.url, 'https://localhost').searchParams.toString()
          const output = await new Promise((resolve, reject) => {
            const child = spawnBackend('git', ['http-backend'], {
              cwd: root,
              detached: process.platform !== 'win32',
              env: {
                ...process.env,
                GIT_CONFIG_NOSYSTEM: '1',
                GIT_CONFIG_GLOBAL: '/dev/null',
                GIT_PROJECT_ROOT: repoRoot,
                GIT_HTTP_EXPORT_ALL: '1',
                PATH_INFO: pathInfo,
                QUERY_STRING: query,
                REQUEST_METHOD: request.method,
                CONTENT_TYPE: request.headers['content-type'] ?? '',
                CONTENT_LENGTH: String(Buffer.concat(chunks).length),
                REMOTE_USER: USER,
                REMOTE_ADDR: '127.0.0.1',
                SERVER_PROTOCOL: 'HTTP/1.1',
                GATEWAY_INTERFACE: 'CGI/1.1',
                HTTPS: 'on',
              },
              stdio: ['pipe', 'pipe', 'pipe'],
            })
            let resolveClosed
            child.closed = new Promise((resolve) => {
              resolveClosed = resolve
            })
            children.add(child)
            child.once('close', () => {
              children.delete(child)
              resolveClosed()
            })
            const outputs = []
            let stderr = ''
            let done = false
            let killTimer
            const finish = (error, value) => {
              if (done) return
              done = true
              clearTimeout(timer)
              clearTimeout(killTimer)
              if (error) reject(error)
              else resolve(value)
            }
            const terminate = (error) => {
              if (done) return
              done = true
              clearTimeout(timer)
              kill('SIGTERM')
              killTimer = setTimeout(() => {
                kill('SIGKILL')
                child.closed.then(() => reject(error))
              }, 250)
              killTimer.unref()
            }
            const kill = (signal) => signalChildGroup(child, signal)
            const timer = setTimeout(
              () => terminate(new Error('Timed out: git http-backend')),
              COMMAND_TIMEOUT,
            )
            timer.unref()
            child.stdout.on('data', (chunk) => outputs.push(chunk))
            child.stderr.on('data', (chunk) => {
              stderr = (stderr + chunk).slice(-4000)
            })
            child.stdin.on('error', (error) => terminate(error))
            child.on('error', (error) => terminate(error))
            child.on('close', (code) => {
              if (done) return
              if (code === 0) finish(null, Buffer.concat(outputs))
              else finish(new Error(`git http-backend exited ${code}: ${stderr}`))
            })
            child.stdin.end(Buffer.concat(chunks))
          })
          const split = output.indexOf('\r\n\r\n')
          if (split < 0) throw new Error('git http-backend returned malformed CGI output')
          const headers = output.subarray(0, split).toString().split('\r\n')
          let status = 200
          for (const line of headers) {
            const colon = line.indexOf(':')
            if (colon < 0) continue
            const name = line.slice(0, colon).trim()
            const value = line.slice(colon + 1).trim()
            if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10)
            else response.setHeader(name, value)
          }
          if (!advanced && request.method === 'POST' && pathInfo.endsWith('/git-upload-pack')) {
            advanced = true
            await writeFile(
              join(work, 'remote-update.txt'),
              'host advanced remote after native clone\n',
            )
            await git(work, 'add', '.')
            await git(
              work,
              '-c',
              'user.name=Holi Fixture',
              '-c',
              'user.email=fixture@invalid',
              'commit',
              '-m',
              'host advancement',
            )
            await git(work, 'push', bare, 'HEAD:refs/heads/fixture-start')
          }
          response.writeHead(status)
          response.end(output.subarray(split + 4))
        })()
        requestTasks.add(task)
        task
          .catch((error) => {
            if (closed) return
            backendFailures++
            if (!response.headersSent) response.writeHead(500)
            response.end()
            console.error(`Git fixture request failed: ${error.message}`)
          })
          .finally(() => requestTasks.delete(task))
          .catch(() => {})
      },
    )
    servers.push(server)
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const url = `https://127.0.0.1:${server.address().port}/fixture.git`
    const invalidServer = createServer(
      { key: await readFile(invalidKey), cert: await readFile(invalidCert) },
      (_request, response) => response.end(),
    )
    servers.push(invalidServer)
    invalidServer.on('connection', (socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    await new Promise((resolve, reject) => {
      invalidServer.once('error', reject)
      invalidServer.listen(0, '127.0.0.1', resolve)
    })
    const invalidUrl = `https://127.0.0.1:${invalidServer.address().port}/fixture.git`
    manifestPath = join(artifacts, 'git-fixture.json')
    await writeFile(
      manifestPath,
      JSON.stringify({ runId, url, invalidUrl, tlsChallengesOnlyOnSimulator: true }, null, 2),
    )
    return {
      root,
      cert,
      url,
      invalidUrl,
      username: USER,
      password: PASSWORD,
      get authChallengeCount() {
        return authChallenges
      },
      get remoteAdvanced() {
        return advanced
      },
      get backendFailures() {
        return backendFailures
      },
      close,
    }
  } catch (error) {
    setupFailure = error
    try {
      await close()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Git fixture setup and rollback failed')
    }
    throw error
  }
}
