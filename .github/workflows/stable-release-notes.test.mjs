import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
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

test('selects the latest published stable release, excluding dev, drafts, and current release', () => {
  assert.equal(previousStableRelease(releases, 'v0.8.0'), 'v0.7.0')
})

test('returns no baseline when there is no earlier published stable release', () => {
  assert.equal(previousStableRelease(releases.slice(1), 'v0.8.0'), undefined)
  assert.equal(previousStableRelease([], 'v1.0.0'), undefined)
})

test('uses the GitHub repository identity for release lookup', () => {
  const calls = []
  const tag = getPreviousStableTag({
    repository: 'holi/app',
    currentTag: 'v0.8.0',
    runGhApi(...args) {
      calls.push(args)
      return JSON.stringify([releases])
    },
  })

  assert.equal(tag, 'v0.7.0')
  assert.deepEqual(calls, [
    [
      'gh',
      ['api', '--paginate', '--slurp', 'repos/holi/app/releases?per_page=100'],
      { encoding: 'utf8' },
    ],
  ])
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

test('stable release generation passes the selected baseline to the correct release', () => {
  assert.match(workflow, /TAG: \$\{\{ needs\.version\.outputs\.tag \}\}/)
  assert.match(workflow, /node \.github\/workflows\/stable-release-notes\.mjs "\$TAG"/)
  assert.match(workflow, /gh release create "\$TAG"/)
  assert.match(workflow, /--notes-start-tag "\$NOTES_START_TAG"/)
  assert.match(workflow, /--generate-notes/)
  assert.match(workflow, /gh release create "\$TAG"[\s\S]*?--prerelease[\s\S]*?--generate-notes/)
})
