/**
 * The PostToolUse validator, driven as a real process.
 *
 * It is a `.mjs` shipped in the binary and run by Claude Code, so the only
 * honest test is the one that spawns it and reads what it says. The property
 * that matters most is the negative one: it must be **silent** on a correct
 * write. A hook that talks every time is a hook the agent learns to ignore,
 * and then it is not a feedback loop, it is noise.
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const HOOK = fileURLToPath(
  new URL('../src/main/agent/hooks/vault-app-check.mjs', import.meta.url),
)

interface Run {
  stdout: string
  code: number | null
}

/** Bare `node` is broken in this environment — spawn the running interpreter. */
function runHook(payload: unknown): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], { env: { PATH: process.env.PATH ?? '' } })
    let stdout = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
    child.on('error', reject)
    child.on('close', (code) => resolve({ stdout, code }))
    child.stdin.end(JSON.stringify(payload))
  })
}

let root: string
const dirs: string[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'holi-app-check-'))
  dirs.push(root)
})

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

/** Write a file into an app and report it as a `Write` the agent just made. */
async function wrote(rel: string, content: string): Promise<Run> {
  const abs = join(root, '.holi/apps', rel)
  await mkdir(join(abs, '..'), { recursive: true })
  await writeFile(abs, content)
  return runHook({ tool_name: 'Write', tool_input: { file_path: abs, content } })
}

/** The advisory text the hook produced, or '' when it stayed quiet. */
function said(run: Run): string {
  if (run.stdout.trim() === '') return ''
  const parsed = JSON.parse(run.stdout) as {
    hookSpecificOutput?: { additionalContext?: string }
  }
  return parsed.hookSpecificOutput?.additionalContext ?? ''
}

const REGISTERED = 'name: retro\n'

/** An app that is finished, so registration never becomes the reported problem. */
async function finished(id = 'retro'): Promise<void> {
  const dir = join(root, '.holi/apps', id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'app.yaml'), REGISTERED)
  await writeFile(join(dir, 'index.html'), '<!doctype html><h1>hi</h1>\n')
}

describe('it never blocks, and it is quiet when there is nothing to say', () => {
  it('exits 0 and says nothing for a valid script', async () => {
    await finished()
    const run = await wrote('retro/app.js', 'const a = 1\nconsole.log(a)\n')
    expect(run.code).toBe(0)
    expect(said(run)).toBe('')
  })

  it('exits 0 even when it has plenty to say', async () => {
    await finished()
    const run = await wrote('retro/app.js', 'const a = (\nlocalStorage.setItem("x", 1)\n')
    expect(run.code).toBe(0)
    expect(said(run)).not.toBe('')
  })

  it('ignores a write outside .holi/apps entirely', async () => {
    const abs = join(root, 'notes/mine.js')
    await mkdir(join(root, 'notes'), { recursive: true })
    await writeFile(abs, 'const a = (\n')
    const run = await runHook({ tool_name: 'Write', tool_input: { file_path: abs } })
    expect(run.code).toBe(0)
    expect(said(run)).toBe('')
  })

  it('survives junk on stdin without complaining', async () => {
    for (const payload of ['', 'not json', '{}', '{"tool_name":"Bash"}']) {
      const run = await new Promise<Run>((resolve, reject) => {
        const child = spawn(process.execPath, [HOOK], { env: { PATH: process.env.PATH ?? '' } })
        let stdout = ''
        child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
        child.on('error', reject)
        child.on('close', (code) => resolve({ stdout, code }))
        child.stdin.end(payload)
      })
      expect(run.code).toBe(0)
      expect(said(run)).toBe('')
    }
  })
})

describe('code that cannot run', () => {
  it('reports a syntax error with its line', async () => {
    await finished()
    const run = await wrote('retro/app.js', 'const a = 1\nconst b = (\nconsole.log(a)\n')
    const text = said(run)
    expect(text).toMatch(/SyntaxError/)
    expect(text).toMatch(/line \d+/)
  })

  it('reports a syntax error inside an inline script, at the file\'s own line', async () => {
    await finished()
    const html = ['<!doctype html>', '<h1>hi</h1>', '<script>', 'const a = )', '</script>'].join('\n')
    const run = await wrote('retro/index.html', html)
    expect(said(run)).toMatch(/line 4/)
  })

  it('accepts module syntax — a type="module" script is legal here', async () => {
    await finished()
    const run = await wrote('retro/app.js', 'export const a = 1\n')
    expect(said(run)).toBe('')
  })

  it('reports a .ts/.tsx/.jsx file as unbuildable — there is no bundler', async () => {
    await finished()
    for (const rel of ['retro/app.ts', 'retro/App.tsx', 'retro/App.jsx']) {
      const run = await wrote(rel, 'export const a: number = 1\n')
      expect(said(run)).toMatch(/no bundler/)
    }
  })
})

describe('the boundaries the skill states', () => {
  beforeEach(() => finished())

  it('reports localStorage and sessionStorage, with the reason', async () => {
    for (const source of ['localStorage.setItem("a", 1)\n', 'sessionStorage.getItem("a")\n']) {
      const text = said(await wrote('retro/app.js', source))
      expect(text).toMatch(/opaque origin/)
    }
  })

  it('reports holi.data, which does not exist', async () => {
    const text = said(await wrote('retro/app.js', 'await holi.data.get("x")\n'))
    expect(text).toMatch(/holi\.data/)
  })

  it('reports a write through the bridge — an app shows, the agent changes', async () => {
    const text = said(await wrote('retro/app.js', 'await holi.docs.write("a.md", "x")\n'))
    expect(text).toMatch(/cannot write/)
  })

  it('reports a hand-added bridge script tag', async () => {
    const html = '<!doctype html>\n<script src="holi-bridge.js"></script>\n<h1>hi</h1>\n'
    const text = said(await wrote('retro/index.html', html))
    expect(text).toMatch(/bridge/)
  })

  it('nudges about a hard-coded colour, below the rest', async () => {
    const text = said(await wrote('retro/style.css', 'body { color: #1e1e1e; }\n'))
    expect(text).toMatch(/#1e1e1e/)
    expect(text).toMatch(/var\(--/)
  })

  it('does not mistake a hex-looking id or a comment for a colour', async () => {
    const text = said(await wrote('retro/app.js', 'const id = "abc123"\nconst n = 0x1e1e1e\n'))
    expect(text).toBe('')
  })
})

describe('registration', () => {
  it('reports an app with an entry document and no manifest, naming the fix', async () => {
    const dir = join(root, '.holi/apps/retro')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'index.html'), '<!doctype html><h1>hi</h1>\n')
    const text = said(await wrote('retro/app.js', 'const a = 1\n'))
    expect(text).toMatch(/app\.yaml/)
    expect(text).toMatch(/holi app init retro/)
  })

  it('says nothing about registration once the manifest is there', async () => {
    await finished()
    expect(said(await wrote('retro/app.js', 'const a = 1\n'))).toBe('')
  })

  it('does not nag about a manifest before there is an entry document', async () => {
    // Mid-authoring: the app has one file so far. Registration is not yet a
    // problem, and saying so on the first write is the noise that gets a hook
    // ignored.
    await mkdir(join(root, '.holi/apps/retro'), { recursive: true })
    expect(said(await wrote('retro/app.js', 'const a = 1\n'))).toBe('')
  })
})
