import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { needsMobileIos } from './mobile-ios-changes.mjs'

test('mobile and shared changes run native compatibility', () => {
  assert.equal(needsMobileIos(['apps/mobile/app/runtime.ios.ts']), true)
  assert.equal(needsMobileIos(['packages/shared/src/path.ts']), true)
  assert.equal(needsMobileIos(['pnpm-lock.yaml']), true)
  assert.equal(needsMobileIos(['tsconfig.base.json']), true)
  assert.equal(needsMobileIos(['patches/dependency.patch']), true)
})

test('desktop-only changes do not run native compatibility', () => {
  assert.equal(needsMobileIos(['apps/desktop/src/main/index.ts']), false)
  assert.equal(needsMobileIos(['docs/features/tasks.md']), false)
})

for (const [name, before, after, expected] of [
  ['mobile deletion', 'apps/mobile/old.ts', null, true],
  ['rename out of mobile', 'apps/mobile/old.ts', 'docs/new.md', true],
  ['rename into mobile', 'docs/old.md', 'apps/mobile/new.ts', true],
  ['newline in mobile path', 'docs/old.md', 'apps/mobile/new\nline.ts', true],
  ['unrelated rename', 'docs/old.md', 'docs/new.md', false],
]) {
  test(`CLI classifies ${name}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mobile-ios-changes-'))
    try {
      const git = (...args) =>
        execFileSync('git', ['-C', directory, '-c', 'core.hooksPath=/dev/null', ...args], {
          encoding: 'utf8',
        }).trim()
      git('init', '-q')
      git('config', 'user.email', 'test@example.com')
      git('config', 'user.name', 'Test')
      git('config', 'commit.gpgsign', 'false')
      await mkdir(join(directory, 'apps/mobile'), { recursive: true })
      await mkdir(join(directory, 'docs'), { recursive: true })
      await writeFile(join(directory, before), 'content')
      git('add', '.')
      git('commit', '-qm', 'base')
      const base = git('rev-parse', 'HEAD')
      if (after) git('mv', before, after)
      else await rm(join(directory, before))
      git('commit', '-qam', 'changes')
      const head = git('rev-parse', 'HEAD')
      const eventPath = join(directory, 'event.json')
      const outputPath = join(directory, 'output')
      await writeFile(
        eventPath,
        JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: head } } }),
      )
      execFileSync(
        process.execPath,
        [new URL('./mobile-ios-changes.mjs', import.meta.url).pathname],
        {
          cwd: directory,
          env: {
            ...process.env,
            GITHUB_EVENT_NAME: 'pull_request',
            GITHUB_EVENT_PATH: eventPath,
            GITHUB_OUTPUT: outputPath,
          },
        },
      )
      assert.equal(await readFile(outputPath, 'utf8'), `run=${expected}\n`)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test('workflow dispatch always requests native compatibility', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mobile-ios-changes-'))
  try {
    const outputPath = join(directory, 'output')
    execFileSync(
      process.execPath,
      [new URL('./mobile-ios-changes.mjs', import.meta.url).pathname],
      {
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: 'workflow_dispatch',
          GITHUB_EVENT_PATH: join(directory, 'event.json'),
          GITHUB_OUTPUT: outputPath,
        },
      },
    )
    assert.equal(await readFile(outputPath, 'utf8'), 'run=true\n')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('main pushes always request native compatibility', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mobile-ios-changes-'))
  try {
    const outputPath = join(directory, 'output')
    execFileSync(
      process.execPath,
      [new URL('./mobile-ios-changes.mjs', import.meta.url).pathname],
      {
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: 'push',
          GITHUB_EVENT_PATH: join(directory, 'event.json'),
          GITHUB_OUTPUT: outputPath,
        },
      },
    )
    assert.equal(await readFile(outputPath, 'utf8'), 'run=true\n')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('CLI rejects pull requests with missing commit SHAs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mobile-ios-changes-'))
  try {
    const eventPath = join(directory, 'event.json')
    await writeFile(eventPath, JSON.stringify({ pull_request: { base: {}, head: {} } }))
    assert.throws(() =>
      execFileSync(
        process.execPath,
        [new URL('./mobile-ios-changes.mjs', import.meta.url).pathname],
        {
          env: {
            ...process.env,
            GITHUB_EVENT_NAME: 'pull_request',
            GITHUB_EVENT_PATH: eventPath,
            GITHUB_OUTPUT: join(directory, 'output'),
          },
          stdio: 'pipe',
        },
      ),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
