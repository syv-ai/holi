#!/usr/bin/env node
// A stand-in for `claude` in the drawer e2e: same PTY contract, same hook and
// MCP traffic real Claude Code produces, but driven by typed commands instead
// of a model. Point HOLI_CLAUDE_BIN at it.
//
//   edit <rel> <text…>   what a Write tool call looks like from Holi's side:
//                        PreToolUse hook → file write → Stop hook
//   taskfile <title…>    create a task the way the agent now does: by writing
//                        tasks/<slug>.md. No op — the projection makes the record.
//   settitle <rel> <t…>  edit a task file's title in place (an `Edit` tool call)
//   corrupt <rel>        write malformed frontmatter — the model does this
//   rm <rel>             delete a file (rm on a task file deletes the record)
//   cat <rel>            print a file, so the harness can see what the agent sees
//   task_set <id> <st>   the surviving op — completion, which a file cannot express
//   exit [code]

import { appendFile, mkdir, readFile, rm as rmFile, writeFile } from 'node:fs/promises'
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

/** A whole-file Write, hooks included — the shape of a real Write tool call. */
async function write(rel, text) {
  const abs = resolve(join(cwd, rel))
  await hook('/hook/pre-tool-use', { filePath: abs })
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, text, 'utf8')
  await hook('/hook/stop')
  out(`wrote ${rel}`)
}

const slug = (title) =>
  title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'task'

async function run(line) {
  const [command, ...rest] = line.trim().split(/\s+/)
  if (!command) return
  try {
    if (command === 'edit') {
      const [rel, ...words] = rest
      await edit(rel, words.join(' '))
    } else if (command === 'taskfile') {
      // The agent creates a task by writing a file. There is no op for this.
      const title = rest.join(' ')
      const rel = `tasks/${slug(title)}.md`
      await write(rel, `---\ntitle: ${title}\nstatus: todo\n---\n\nWritten by the agent.\n`)
    } else if (command === 'settitle') {
      const [rel, ...words] = rest
      const current = await readFile(resolve(join(cwd, rel)), 'utf8')
      await write(rel, current.replace(/^title: .*$/m, `title: ${words.join(' ')}`))
    } else if (command === 'corrupt') {
      await write(rest[0], '---\ntitle: "unterminated\nstatus: nonsense\n---\n')
    } else if (command === 'rm') {
      const abs = resolve(join(cwd, rest[0]))
      await hook('/hook/pre-tool-use', { filePath: abs })
      await rmFile(abs, { force: true })
      await hook('/hook/stop')
      out(`removed ${rest[0]}`)
    } else if (command === 'cat') {
      const text = await readFile(resolve(join(cwd, rest[0])), 'utf8').catch(() => null)
      out(`cat ${rest[0]}: ${text === null ? 'ENOENT' : JSON.stringify(text)}`)
    } else if (command === 'task_set') {
      const result = await mcp('task_set', { task_id: rest[0], status: rest[1] })
      out(`task_set: ${JSON.stringify(result.result?.content?.[0]?.text ?? result)}`)
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
