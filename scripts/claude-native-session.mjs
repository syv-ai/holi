import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { realpath, readFile } from 'node:fs/promises'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOwnedProcesses } from '../apps/desktop/scripts/owned-processes.mjs'

const bounded = (value, max = 4000) => String(value ?? '').slice(-max)
const expected = 'HOLI_NATIVE_LOOPBACK_OK'

export async function runClaudeNativeSession({ bin, timeout = 60_000 } = {}) {
  if (!bin) throw new Error('An exact native Claude binary path is required')
  if (process.platform !== 'darwin')
    throw new Error('Native Claude probe requires macOS sandbox-exec containment')
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 60_000)
    throw new Error('timeout must be between 1 and 60000ms')
  const executable = await realpath(bin)
  const digest = createHash('sha256')
    .update(await readFile(executable))
    .digest('hex')
  const root = await mkdtemp(join(tmpdir(), 'holi-claude-native-'))
  const home = join(root, 'home')
  const cwd = join(root, 'vault')
  const processes = createOwnedProcesses()
  let server
  let serverClosed = false
  let requestCount = 0
  const requests = []
  let version = ''
  let turnOutput = ''
  const cleanup = async () => {
    await processes.stopAll(500, 1500)
    if (server && !serverClosed) await new Promise((resolve) => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
  try {
    await Promise.all([mkdir(home), mkdir(cwd)])
    server = createServer(async (req, res) => {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname
      requestCount++
      requests.push({ method: req.method, path: pathname, status: 404 })
      const request = requests.at(-1)
      console.error(`native synthetic request ${req.method} ${pathname}`)
      if (requestCount > 8) {
        res.writeHead(429).end()
        return
      }
      if (req.method === 'POST' && pathname === '/v1/messages') {
        let body = ''
        for await (const chunk of req) {
          body += chunk
          if (body.length > 32_000_000) {
            res.writeHead(413).end()
            return
          }
        }
        request.status = 200
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        for (const event of [
          {
            type: 'message_start',
            message: {
              id: 'msg_loopback',
              type: 'message',
              role: 'assistant',
              model: 'synthetic',
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 3, output_tokens: 0 },
            },
          },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: expected } },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 5 },
          },
          { type: 'message_stop' },
        ])
          res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        res.end()
        return
      }
      res.end()
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const { port } = server.address()
    const profile = `(version 1) (allow default) (deny network*) (allow network-outbound (remote tcp "localhost:${port}")) (allow network-inbound (local tcp "localhost:${port}"))`
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      ANTHROPIC_API_KEY: 'sk-ant-loopback-only',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      NO_COLOR: '1',
    }
    const invoke = async (args) =>
      processes.run('/usr/bin/sandbox-exec', ['-p', profile, executable, ...args], {
        cwd,
        env,
        timeoutMs: timeout,
        label: 'native Claude probe',
      })
    version = (await invoke(['--version'])).output
    const result = await invoke([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      'Reply with the exact text received from your model.',
    ])
    turnOutput = bounded(result.output, 16_000)
    const events = turnOutput
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)]
        } catch {
          return []
        }
      })
    const final = events.find((event) => event.type === 'result')
    return {
      version: bounded(version),
      binary: executable,
      sha256: digest,
      requests,
      result: final ?? null,
      success: Boolean(
        final?.subtype === 'success' &&
        final?.is_error === false &&
        final?.result === expected &&
        requests.some(
          (item) => item.method === 'POST' && item.path === '/v1/messages' && item.status === 200,
        ),
      ),
    }
  } catch (error) {
    throw new Error(
      `${error.message}\nNative requests: ${JSON.stringify(requests)}\nFinal native output: ${bounded(turnOutput || error.output || error.message, 4000)}`,
    )
  } finally {
    await cleanup()
  }
}
