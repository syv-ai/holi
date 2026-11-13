import assert from 'node:assert/strict'
import test from 'node:test'
import { HARNESS, watch } from './harness-release-watch.mjs'

const runUrl = 'https://github.com/syv-ai/holi/actions/runs/1'
const token = 'secret'

function fixture({
  versions = {},
  issues = [],
  notesMissing = [],
  registryFailures = {},
  pages = [],
} = {}) {
  const calls = []
  const fetch = async (url, options = {}) => {
    calls.push({ url: String(url), ...options })
    const parsed = new URL(url)
    if (parsed.hostname === 'registry.npmjs.org') {
      const name = decodeURIComponent(parsed.pathname.slice(1))
      if (registryFailures[name]) return response(503, {})
      const version = versions[name] ?? '1.2.3'
      return response(200, {
        'dist-tags': { latest: version },
        versions: { [version]: { time: '2026-11-13T09:00:00Z' } },
      })
    }
    if (parsed.hostname === 'api.github.com' && parsed.pathname.includes('/releases/tags/')) {
      if (notesMissing.some((path) => parsed.pathname.includes(path))) return response(404, {})
      const repo = parsed.pathname.split('/repos/')[1].split('/releases')[0]
      const tag = decodeURIComponent(parsed.pathname.split('/tags/')[1])
      return response(200, {
        tag_name: tag,
        html_url: `https://github.com/${repo}/releases/tag/${tag}`,
        body: `Notes for ${tag}`,
      })
    }
    if (parsed.pathname === '/repos/syv-ai/holi/issues' && options.method === 'POST')
      return response(201, {})
    if (parsed.pathname.startsWith('/repos/syv-ai/holi/issues/') && options.method === 'PATCH')
      return response(200, {})
    if (parsed.pathname === '/repos/syv-ai/holi/issues') {
      const page = parsed.searchParams.get('page')
      if (page) return response(200, pages[Number(page) - 2] ?? [], { link: '' })
      return response(
        200,
        pages.length ? pages[0] : issues,
        pages.length
          ? { link: '<https://api.github.com/repos/syv-ai/holi/issues?page=2>; rel="next"' }
          : {},
      )
    }
    throw new Error(`Unexpected request ${options.method ?? 'GET'} ${url}`)
  }
  return { fetch, calls }
}

function response(status, data, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => data,
    text: async () => JSON.stringify(data),
  }
}

test('creates a stable report for all three fixed package identities', async () => {
  const f = fixture()
  await watch({ ...f, token, runUrl })
  const created = f.calls
    .filter((call) => call.method === 'POST')
    .map((call) => JSON.parse(call.body))
  assert.equal(created.length, 3)
  assert.deepEqual(
    created.map((issue) => issue.title),
    HARNESS.map(({ id }) => `Harness release: ${id}`),
  )
  for (const issue of created) {
    assert.match(issue.body, /contract checks not run; compatibility unverified/)
    assert.match(issue.body, /Release notes: https:\/\/github.com\//)
    assert.doesNotMatch(issue.body, /tested with/i)
  }
  assert.ok(
    f.calls
      .filter((call) => call.url.includes('registry.npmjs.org'))
      .every((call) => !call.headers.Authorization),
  )
})

test('does not write for an unchanged stable discovery despite a different run URL', async () => {
  const initial = fixture()
  await watch({ ...initial, token, runUrl })
  const issues = initial.calls
    .filter((call) => call.method === 'POST')
    .map((call, index) => ({
      number: index + 1,
      title: JSON.parse(call.body).title,
      body: JSON.parse(call.body).body,
      state: 'open',
      user: { login: 'github-actions[bot]' },
    }))
  const next = fixture({ issues })
  await watch({ ...next, token, runUrl: `${runUrl}2` })
  assert.equal(
    next.calls.filter((call) => call.method === 'POST' || call.method === 'PATCH').length,
    0,
  )
})

test('updates changed discovery, reopens a closed report for a later release, and never adopts human marker issues', async () => {
  const issues = [
    {
      number: 1,
      title: 'Harness release: claude-code',
      body: '<!-- holi-harness-release: claude-code -->\nold',
      state: 'open',
      user: { login: 'github-actions[bot]' },
    },
    {
      number: 2,
      title: 'Harness release: codex',
      body: '<!-- holi-harness-release: codex -->\nold',
      state: 'closed',
      user: { login: 'github-actions[bot]' },
    },
    {
      number: 3,
      title: 'Human',
      body: '<!-- holi-harness-release: pi -->',
      state: 'open',
      user: { login: 'alice' },
    },
  ]
  const f = fixture({
    issues,
    versions: {
      '@anthropic-ai/claude-code': '2.0.0',
      '@openai/codex': '2.0.0',
      '@earendil-works/pi-coding-agent': '2.0.0',
    },
  })
  await watch({ ...f, token, runUrl })
  const patches = f.calls.filter((call) => call.method === 'PATCH')
  assert.equal(patches.length, 2)
  assert.deepEqual(
    patches.map((call) => JSON.parse(call.body).state ?? 'updated'),
    ['updated', 'open'],
  )
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1)
})

test('paginates every issue page before reconciling', async () => {
  const pageOne = Array.from({ length: 100 }, (_, i) => ({
    number: i + 1,
    user: { login: 'someone' },
    body: '',
  }))
  const f = fixture({ pages: [pageOne, []] })
  await watch({ ...f, token, runUrl })
  assert.ok(f.calls.some((call) => call.url.includes('page=2')))
})

test('isolates registry failures while reporting successful discoveries, then fails the run', async () => {
  const f = fixture({ registryFailures: { '@openai/codex': true } })
  await assert.rejects(watch({ ...f, token, runUrl }), /codex: HTTP 503/)
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 2)
})

test('rejects malformed npm metadata and distinguishes missing notes from failed discovery', async () => {
  const f = fixture({
    versions: { '@anthropic-ai/claude-code': 'latest' },
    notesMissing: ['openai/codex'],
  })
  await assert.rejects(watch({ ...f, token, runUrl }), /Malformed npm metadata/)
  const reports = f.calls
    .filter((call) => call.method === 'POST')
    .map((call) => JSON.parse(call.body).body)
  assert.ok(reports.some((body) => body.includes('Release notes: unavailable for this version.')))
  assert.equal(reports.length, 2)
})

test('only sends the credential to fixed GitHub API origins', async () => {
  const f = fixture()
  await watch({ ...f, token, runUrl })
  const authenticated = f.calls.filter((call) => call.headers.Authorization)
  assert.ok(authenticated.length)
  assert.ok(authenticated.every((call) => new URL(call.url).hostname === 'api.github.com'))
})
