import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const bounded = (value, max = 2000) => String(value ?? '').slice(0, max)

/** Run native Claude Code against a synthetic, loopback-only Anthropic endpoint.
 * Returns observed HTTP request and Claude's actual stream-json events. */
export async function runClaudeNativeSession({ bin, timeout = 60_000 } = {}) {
  if (!bin) throw new Error('An exact native Claude binary path is required')
  const root = await mkdtemp(join(tmpdir(), 'holi-claude-native-'))
  const home = join(root, 'home')
  const cwd = join(root, 'vault')
  await Promise.all([mkdir(home), mkdir(cwd)])
  let observed
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !['/v1/messages', '/v1/messages/'].includes(req.url)) {
      res.writeHead(404).end()
      return
    }
    let body = ''
    for await (const chunk of req) body += chunk
    observed = { path: req.url, body: bounded(body, 16_000) }
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
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'HOLI_NATIVE_LOOPBACK_OK' },
      },
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
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
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
  try {
    const version = await run(bin, ['--version'], { cwd, env, timeout })
    const output = await run(
      bin,
      [
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        'Reply with the exact text received from your model.',
      ],
      { cwd, env, timeout },
    )
    const events = output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
    const serialized = JSON.stringify(events)
    return {
      version: bounded(version),
      request: observed,
      events,
      success: Boolean(
        observed &&
        serialized.includes('HOLI_NATIVE_LOOPBACK_OK') &&
        serialized.includes('end_turn'),
      ),
    }
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
}

function run(bin, args, { cwd, env, timeout }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let timer
    const kill = () => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 1000).unref()
    }
    timer = setTimeout(kill, timeout)
    child.stdout.on('data', (data) => {
      out += data.toString()
      if (out.length > 128_000) kill()
    })
    child.stderr.on('data', (data) => {
      err += data.toString()
      if (err.length > 16_000) err = err.slice(-16_000)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      code === 0 ? resolve(out) : reject(new Error(`Claude exited ${code}: ${bounded(err || out)}`))
    })
  })
}
