#!/usr/bin/env node
// A stand-in for `claude` in the drawer e2e: same PTY contract, same hook and
// MCP traffic real Claude Code produces, but driven by typed commands instead
// of a model. Point HOLI_CLAUDE_BIN at it.
//
//   edit <rel> <text…>   what a Write tool call looks like from Holi's side:
//                        PreToolUse hook → file write → Stop hook
//   task <title…>        an MCP tools/call to task_new
//   exit [code]

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const endpoint = process.env.HOLI_AGENT_ENDPOINT
const token = process.env.HOLI_AGENT_TOKEN
const cwd = process.cwd()

const out = (line) => process.stdout.write(`${line}\r\n`)

async function hook(path, body) {
  await fetch(`${endpoint}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body ?? {}),
  })
}

async function mcp(name, args) {
  const res = await fetch(`${endpoint}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
  return res.json()
}

async function edit(rel, text) {
  const abs = resolve(join(cwd, rel))
  await hook('/hook/pre-tool-use', { filePath: abs })
  await mkdir(dirname(abs), { recursive: true })
  await appendFile(abs, `${text}\n`, 'utf8')
  await hook('/hook/stop')
  out(`wrote ${rel}`)
}

async function run(line) {
  const [command, ...rest] = line.trim().split(/\s+/)
  if (!command) return
  try {
    if (command === 'edit') {
      const [rel, ...words] = rest
      await edit(rel, words.join(' '))
    } else if (command === 'task') {
      const result = await mcp('task_new', { title: rest.join(' ') })
      out(`task: ${JSON.stringify(result.result?.content?.[0]?.text ?? result)}`)
    } else if (command === 'exit') {
      out('bye')
      process.exit(Number(rest[0] ?? 0))
    } else {
      out(`unknown command: ${command}`)
    }
  } catch (err) {
    out(`error: ${err.message}`)
  }
}

out(`fake-claude ready (cwd=${cwd}, mcp=${endpoint ? 'up' : 'MISSING'})`)

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  // a PTY delivers Enter as \r; a pipe as \n
  let idx
  while ((idx = buffer.search(/[\r\n]/)) !== -1) {
    const line = buffer.slice(0, idx)
    buffer = buffer.slice(idx + 1)
    out(`> ${line}`) // echo, so the xterm shows life
    void run(line)
  }
})
process.stdin.on('end', () => process.exit(0))
