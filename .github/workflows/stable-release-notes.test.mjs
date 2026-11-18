import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { getPreviousStableTag, previousStableRelease } from './stable-release-notes.mjs'

const workflow = await readFile(new URL('./release.yml', import.meta.url), 'utf8')
const releases = [
  { tag_name: 'v0.7.0', draft: false, prerelease: false, published_at: '2026-01-01T00:00:00Z' },
  {
    tag_name: 'v0.7.1-dev.253',
    draft: false,
    prerelease: true,
    published_at: '2026-02-01T00:00:00Z',
  },
  { tag_name: 'v0.8.0', draft: false, prerelease: false, published_at: '2026-03-01T00:00:00Z' },
  { tag_name: 'v0.9.0', draft: true, prerelease: false, published_at: '2026-04-01T00:00:00Z' },
]

function publishRunBlock() {
  const publishStep = workflow.slice(workflow.indexOf('      - name: Publish the release'))
  const runMarker = '        run: |\n'
  const start = publishStep.indexOf(runMarker)
  assert.notEqual(start, -1)
  const lines = publishStep.slice(start + runMarker.length).split('\n')
  const script = []
  for (const line of lines) {
    if (line && !line.startsWith('          ')) break
    script.push(line.startsWith('          ') ? line.slice(10) : '')
  }
  return script.join('\n')
}

async function executePublish({ pages, apiError, createStatus = 0 }) {
  const directory = await mkdtemp(join(tmpdir(), 'holi-stable-release-'))
  const bin = join(directory, 'bin')
  const log = join(directory, 'calls.jsonl')
  const apiResponse = join(directory, 'api.json')
  const fakeGh = join(bin, 'gh')
  await mkdir(bin)
  await writeFile(apiResponse, JSON.stringify(pages ?? []))
  await writeFile(
    fakeGh,
    `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.GH_CALL_LOG, JSON.stringify(args) + '\\n')
if (args[0] === 'release' && args[1] === 'view') process.exit(1)
if (args[0] === 'api') {
  if (process.env.GH_API_FAIL === '1') process.exit(42)
  process.stdout.write(fs.readFileSync(process.env.GH_API_RESPONSE))
  process.exit(0)
}
if (args[0] === 'release' && args[1] === 'create') process.exit(Number(process.env.GH_CREATE_STATUS))
process.exit(90)
`,
    { mode: 0o755 },
  )
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', publishRunBlock()], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GH_CALL_LOG: log,
      GH_API_RESPONSE: apiResponse,
      GH_API_FAIL: apiError ? '1' : '0',
      GH_CREATE_STATUS: String(createStatus),
      GITHUB_REPOSITORY: 'holi/app',
      GITHUB_SHA: 'abc123',
      TAG: 'v1.0.0',
    },
  })
  const calls = (await readFile(log, 'utf8').catch(() => ''))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  await rm(directory, { recursive: true, force: true })
  return { ...result, calls }
}

test('selects the latest published stable release, excluding dev, drafts, and current release', () => {
  assert.equal(previousStableRelease(releases, 'v0.8.0'), 'v0.7.0')
})

test('returns no baseline when there is no earlier published stable release', () => {
  assert.equal(previousStableRelease(releases.slice(1), 'v0.8.0'), undefined)
  assert.equal(previousStableRelease([], 'v1.0.0'), undefined)
})

test('paginates unordered releases and buffers only the projected release fields', () => {
  const calls = []
  const tag = getPreviousStableTag({
    repository: 'holi/app',
    currentTag: 'v1.0.0',
    runGhApi(...args) {
      calls.push(args)
      return JSON.stringify([
        [
          { ...releases[1], body: 'large body', assets: [{ name: 'installer' }] },
          { ...releases[0], body: 'another body', assets: [{ name: 'archive' }] },
        ],
        [{ ...releases[2], body: 'current stable body' }],
      ])
    },
  })

  assert.equal(tag, 'v0.8.0')
  assert.deepEqual(calls, [
    [
      'gh',
      [
        'api',
        '--paginate',
        '--slurp',
        '--jq',
        '[.[] | {tag_name, draft, prerelease, published_at}]',
        'repos/holi/app/releases?per_page=100',
      ],
      { encoding: 'utf8' },
    ],
  ])
})

test('rejects an invalid projected release response', () => {
  assert.throws(
    () =>
      getPreviousStableTag({
        repository: 'holi/app',
        currentTag: 'v1.0.0',
        runGhApi: () => JSON.stringify([[{ tag_name: 'v0.9.0' }]]),
      }),
    /projected paginated release list/,
  )
})

test('fails closed when the GitHub releases request fails', () => {
  assert.throws(
    () =>
      getPreviousStableTag({
        repository: 'holi/app',
        currentTag: 'v1.0.0',
        runGhApi() {
          throw new Error('GitHub API unavailable')
        },
      }),
    /GitHub API unavailable/,
  )
})

test('publishes with the prior stable tag through the actual workflow run block', async () => {
  const result = await executePublish({ pages: [releases] })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.calls, [
    ['release', 'view', 'v1.0.0'],
    [
      'api',
      '--paginate',
      '--slurp',
      '--jq',
      '[.[] | {tag_name, draft, prerelease, published_at}]',
      'repos/holi/app/releases?per_page=100',
    ],
    [
      'release',
      'create',
      'v1.0.0',
      '--target',
      'abc123',
      '--title',
      'Holi v1.0.0',
      '--generate-notes',
      '--notes-start-tag',
      'v0.8.0',
      'artifacts/*',
    ],
  ])
})

test('does not publish generated notes without a previous stable release', async () => {
  const result = await executePublish({ pages: [[{ ...releases[1], tag_name: 'v1.0.0-dev.1' }]] })
  assert.notEqual(result.status, 0)
  assert.match(result.stdout, /No previous stable release found/)
  assert.deepEqual(result.calls, [
    ['release', 'view', 'v1.0.0'],
    [
      'api',
      '--paginate',
      '--slurp',
      '--jq',
      '[.[] | {tag_name, draft, prerelease, published_at}]',
      'repos/holi/app/releases?per_page=100',
    ],
  ])
})

test('propagates GitHub API failure and never publishes', async () => {
  const result = await executePublish({ apiError: true })
  assert.notEqual(result.status, 0)
  assert.deepEqual(result.calls, [
    ['release', 'view', 'v1.0.0'],
    [
      'api',
      '--paginate',
      '--slurp',
      '--jq',
      '[.[] | {tag_name, draft, prerelease, published_at}]',
      'repos/holi/app/releases?per_page=100',
    ],
  ])
})

test('propagates release creation failure', async () => {
  const result = await executePublish({ pages: [releases], createStatus: 17 })
  assert.equal(result.status, 17, result.stderr)
  assert.deepEqual(result.calls.at(-1), [
    'release',
    'create',
    'v1.0.0',
    '--target',
    'abc123',
    '--title',
    'Holi v1.0.0',
    '--generate-notes',
    '--notes-start-tag',
    'v0.8.0',
    'artifacts/*',
  ])
})

test('leaves dev prerelease note generation unchanged', () => {
  assert.match(workflow, /gh release create "\$TAG"[\s\S]*?--prerelease[\s\S]*?--generate-notes/)
})
