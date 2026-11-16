// A credential-free process standing in for Codex, not for Holi's hosts.
// It uses only its supplied cwd/home, and stays alive until the test releases it.
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const kind = process.argv[2]
const home = process.env.CODEX_HOME
const input = await readFile('input.md', 'utf8')
const config = await readFile(join(home, 'config.toml'), 'utf8')
const state = `${input}:${kind}:private state`
await writeFile(join(home, 'provider-state'), state)
await writeFile(`${kind}.md`, `${input}:${kind}:started`)
const lines = createInterface({ input: process.stdin })
process.stdout.write('fixture-ready\n')
for await (const line of lines) {
  if (line !== 'finish') continue
  // A second vault's startup/teardown must not remove or replace either.
  if ((await readFile('input.md', 'utf8')) !== input) throw new Error('input was replaced')
  if ((await readFile(join(home, 'config.toml'), 'utf8')) !== config)
    throw new Error('config was replaced')
  if ((await readFile(join(home, 'provider-state'), 'utf8')) !== state)
    throw new Error('private state was replaced')
  await writeFile(`${kind}.md`, `${input}:${kind}:finished`)
  process.stdout.write(`${input}:${kind}:output after other vault stopped\n`)
  if (kind === 'job')
    process.stdout.write(
      `${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 5 } })}\n`,
    )
  break
}
lines.close()
