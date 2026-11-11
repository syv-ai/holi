import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const git = promisify(execFile)

/**
 * `count` commits on top of HEAD, each rewriting `path` with its own number, as
 * one `git fast-import`. Committing them one by one is two process spawns each,
 * which on CI's slow runner took a single test past its time limit.
 */
export async function commitChanges(cwd: string, path: string, count: number): Promise<void> {
  const out = async (...args: string[]) => (await git('git', args, { cwd })).stdout.trim()
  const branch = await out('symbolic-ref', '--short', 'HEAD')
  const head = await out('rev-parse', 'HEAD')
  const at = Math.floor(Date.now() / 1000)
  const data = (text: string) => `data ${Buffer.byteLength(text)}\n${text}\n`
  let stream = ''
  for (let i = 0; i < count; i++) {
    stream += `commit refs/heads/${branch}\n`
    stream += `committer Ada Holm <ada@syv.ai> ${at + i} +0000\n`
    stream += data(`data ${i}`)
    if (i === 0) stream += `from ${head}\n`
    stream += `M 100644 inline ${path}\n`
    stream += data(`${i}\n`)
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', ['fast-import', '--quiet'], {
      cwd,
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    let errors = ''
    child.stderr.on('data', (chunk: Buffer) => (errors += chunk.toString()))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`git fast-import failed: ${errors}`)),
    )
    child.stdin.end(stream)
  })
  await out('reset', '--hard', '--quiet', branch)
}
