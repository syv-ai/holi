import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'

const [kind, receipt, stdio, code] = process.argv.slice(2)
const input = await readFile('input.md', 'utf8')
const tail = `fixture-tail:${input}\n`
let piTail = ''
if (kind !== 'pi') await writeFile(`${receipt}.payload`, tail)
const child = spawn(
  process.execPath,
  [
    '-e',
    `
  const fs = require('node:fs');
  process.on('SIGTERM', () => fs.writeFileSync(process.argv[1] + '.term', 'TERM'));
  fs.writeFileSync(process.argv[1], String(process.pid));
  const file = process.argv[1];
  let sent = false;
  setInterval(() => {
    if (!sent && fs.existsSync(file + '.tail')) {
      sent = true;
      process.stdout.write(fs.readFileSync(file + '.payload'));
    }
  }, 10);
`,
    receipt,
  ],
  { stdio },
)
child.unref()
// No root exit or readiness acknowledgement before the handler is installed.
for (let i = 0; ; i++) {
  try {
    if (await readFile(receipt, 'utf8')) break
  } catch (error) {
    if (error.code !== 'ENOENT' || i === 300) throw error
  }
  await delay(10)
}
const send = (event) => process.stdout.write(`${JSON.stringify(event)}\n`)
process.stdout.write('fixture-ready\n')
const lines = createInterface({ input: process.stdin })
for await (const line of lines) {
  if (line === 'ping') {
    if (kind === 'pty') await writeFile('pty-turn.md', input)
    process.stdout.write(`fixture-ping:${input}\n`)
    continue
  }
  if (line === 'exit') {
    if (stdio === 'ignore') {
      process.stdout.write(kind === 'pi' ? piTail : tail)
    }
    if (kind === 'job' || kind === 'fenced') await writeFile('output.md', input)
    if (kind === 'job')
      send({ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 5 } })
    await new Promise((resolve) => process.stdout.write('', resolve))
    process.exit(Number(code))
  }
  if (kind !== 'pi') continue
  const request = JSON.parse(line)
  if (request.type === 'get_session_stats') {
    send({ type: 'response', command: request.type, id: request.id, success: true, data: {} })
    continue
  }
  if (request.type !== 'prompt' && request.type !== 'steer' && request.type !== 'follow_up')
    continue
  if (request.message === 'hold') {
    piTail =
      [
        { type: 'response', command: request.type, id: request.id, success: true },
        { type: 'agent_start' },
        {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: `fixture-tail:${input}` },
        },
        ...(code === '0' ? [{ type: 'agent_settled' }] : []),
      ]
        .map((event) => JSON.stringify(event))
        .join('\n') + '\n'
    await writeFile(`${receipt}.payload`, piTail)
    continue
  }
  if (request.message !== 'reply') continue
  send({ type: 'response', command: request.type, id: request.id, success: true })
  send({ type: 'agent_start' })
  send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: input } })
  send({ type: 'agent_settled' })
}
