import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { discover, normalizeReport, providers, reconcile } from './harness-monitor.mjs'

function observation(id, version = '1.0.0', runNumber = 1, outcome = 'unverified') {
  const provider = providers.find((item) => item.id === id)
  return {
    ...provider,
    version,
    npmUrl: `https://www.npmjs.com/package/${provider.package}`,
    releaseNotesUrl: 'https://github.com/example/repo/releases',
    checks:
      id === 'codex' && outcome === 'pass'
        ? [
            { name: 'CLI surface', outcome },
            { name: 'fixture consumers', outcome },
            { name: 'actual notify emission', outcome },
            { name: 'approval notifications', outcome },
            { name: 'inference events', outcome },
            { name: 'sandbox enforcement', outcome },
          ]
        : [{ name: 'compatibility', outcome }],
  }
}

function report(id, version = '1.0.0', runNumber = 1, outcome = 'unverified') {
  return {
    sha: `sha-${runNumber}`,
    runNumber,
    runUrl: `https://example.test/runs/${runNumber}`,
    providers: [observation(id, version, runNumber, outcome)],
  }
}

function fakeAdapter() {
  const issues = new Map()
  const comments = []
  let nextNumber = 1
  return {
    issues,
    comments,
    async findTrackingIssue(label, marker) {
      return (
        [...issues.values()].find(
          (issue) => issue.label === label && issue.body.includes(marker),
        ) || null
      )
    },
    async createIssue({ title, label, body }) {
      const issue = { number: nextNumber++, title, label, body, state: 'open' }
      issues.set(issue.number, issue)
      return issue
    },
    async updateIssue(number, { title, body }) {
      Object.assign(issues.get(number), { title, body })
    },
    async commentIssue(number, body) {
      const issueComments = comments.filter((comment) => comment.number === number)
      const marker = body.match(/<!-- holi-harness-report:([^>]+) -->/)?.[1]
      if (
        !issueComments.some((comment) =>
          comment.body.includes(`<!-- holi-harness-report:${marker} -->`),
        )
      )
        comments.push({ number, body })
    },
    async closeIssue(number) {
      issues.get(number).state = 'closed'
    },
    async reopenIssue(number) {
      issues.get(number).state = 'open'
    },
  }
}

test('discovers all provider package mappings from npm latest', async () => {
  const requested = []
  const result = await discover({
    sha: 'abc',
    runNumber: 12,
    runUrl: 'https://example.test/run',
    fetchImpl: async (url) => {
      requested.push(url)
      const provider = providers.find(
        (item) => decodeURIComponent(url.split('/').at(-1)) === item.package,
      )
      return {
        ok: true,
        json: async () => ({
          name: provider.package,
          'dist-tags': { latest: '2.3.4' },
        }),
      }
    },
  })
  assert.deepEqual(
    result.providers.map(({ package: name, version }) => [name, version]),
    providers.map(({ package: name }) => [name, '2.3.4']),
  )
  assert.equal(requested.length, 3)
  assert.deepEqual(
    result.providers.map(({ releaseNotesUrl, npmUrl }) => [releaseNotesUrl, npmUrl]),
    [
      [
        'https://github.com/anthropics/claude-code/releases',
        'https://www.npmjs.com/package/@anthropic-ai/claude-code',
      ],
      ['https://github.com/openai/codex/releases', 'https://www.npmjs.com/package/@openai/codex'],
      [
        'https://github.com/earendil-works/pi/releases',
        'https://www.npmjs.com/package/@earendil-works/pi-coding-agent',
      ],
    ],
  )
})

test('registry failures and missing latest fail discovery visibly', async () => {
  await assert.rejects(
    discover({
      sha: 'abc',
      runNumber: 1,
      runUrl: 'url',
      fetchImpl: async () => ({ ok: false, status: 503 }),
    }),
    /503/,
  )
  await assert.rejects(
    discover({
      sha: 'abc',
      runNumber: 1,
      runUrl: 'url',
      fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
    }),
    /latest is missing/,
  )
})

test('Codex report coverage keeps CLI surface and fixture consumers distinct', () => {
  const codex = observation('codex')
  codex.checks = []
  const normalized = normalizeReport(codex)
  assert.deepEqual(
    normalized.checks.map((check) => [check.name, check.outcome]),
    [
      ['CLI surface', 'unverified'],
      ['fixture consumers', 'unverified'],
      ['actual notify emission', 'unverified'],
      ['approval notifications', 'unverified'],
      ['inference events', 'unverified'],
      ['sandbox enforcement', 'unverified'],
    ],
  )
})

test('creates one explicitly unverified issue per provider on first observation', async () => {
  const adapter = fakeAdapter()
  await reconcile(
    {
      sha: 'abc',
      runNumber: 1,
      runUrl: 'url',
      providers: providers.map((item) => observation(item.id)),
    },
    adapter,
  )
  assert.equal(adapter.issues.size, 3)
  for (const issue of adapter.issues.values()) {
    assert.match(issue.body, /Monitoring-only/)
    if (issue.label === 'harness-pi') {
      assert.match(issue.body, /cli-contract: unverified/)
      assert.match(issue.body, /rpc-consumer: unverified/)
      assert.match(issue.body, /rpc-producer: unverified/)
    } else {
      assert.match(issue.body, /compatibility: unverified/)
    }
    assert.match(issue.body, /<!-- holi-harness-monitor:/)
    assert.equal(issue.state, 'open')
  }
})

test('version changes update the existing provider issue without duplicate issues', async () => {
  const adapter = fakeAdapter()
  await reconcile(report('pi'), adapter)
  await reconcile(report('pi', '1.1.0', 2), adapter)
  assert.equal(adapter.issues.size, 1)
  assert.match([...adapter.issues.values()][0].body, /Observed npm latest: `1.1.0`/)
  assert.equal(adapter.comments.length, 1)
})

test('unchanged observations persist newest metadata without comments and reject delayed runs', async () => {
  const adapter = fakeAdapter()
  await reconcile(report('codex', '1.0.0', 1), adapter)
  const latest = report('codex', '1.0.0', 3)
  latest.sha = 'newest-sha'
  await reconcile(latest, adapter)
  await reconcile(report('codex', '1.0.0', 2, 'pass'), adapter)
  const issue = [...adapter.issues.values()][0]
  assert.equal(adapter.issues.size, 1)
  assert.equal(adapter.comments.length, 0)
  assert.match(issue.body, /<!-- holi-harness-run:3 -->/)
  assert.match(issue.body, /Holi commit: newest-sha/)
  assert.equal(issue.state, 'open')
})

test('mismatches stay open and update the tracking issue', async () => {
  const adapter = fakeAdapter()
  await reconcile(report('claude-code'), adapter)
  await reconcile(report('claude-code', '1.0.0', 2, 'mismatch'), adapter)
  const issue = [...adapter.issues.values()][0]
  assert.equal(issue.state, 'open')
  assert.match(issue.body, /compatibility: mismatch/)
})

test('only a current all-pass report closes; later release reopens the same issue', async () => {
  const adapter = fakeAdapter()
  await reconcile(report('pi'), adapter)
  const passingPi = report('pi', '1.0.0', 2, 'pass')
  passingPi.providers[0].checks.push(
    { name: 'cli-contract', outcome: 'pass' },
    { name: 'rpc-consumer', outcome: 'pass' },
    { name: 'rpc-producer', outcome: 'pass' },
  )
  await reconcile(passingPi, adapter)
  const issue = [...adapter.issues.values()][0]
  assert.equal(issue.state, 'closed')
  await reconcile(report('pi', '2.0.0', 3), adapter)
  assert.equal(adapter.issues.size, 1)
  assert.equal(issue.state, 'open')
})

test('a mixed report cannot close an issue even when one check passes', async () => {
  const adapter = fakeAdapter()
  await reconcile(report('pi'), adapter)
  const pass = observation('pi', '1.0.0', 2, 'pass')
  pass.checks.push({ name: 'platform coverage', outcome: 'unverified' })
  await reconcile({ ...report('pi', '1.0.0', 2), providers: [pass] }, adapter)
  assert.equal([...adapter.issues.values()][0].state, 'open')
})

test('Claude merge preserves Codex and missing Claude coverage remains unverified', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'holi-monitor-merge-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const input = {
    sha: 'abc',
    runNumber: 9,
    runUrl: 'https://example.test/run',
    providers: [observation('claude-code', '2.1.319', 9), observation('codex', '9.8.7', 9, 'pass')],
  }
  const reportPath = join(dir, 'report.json')
  const checksPath = join(dir, 'checks.json')
  await writeFile(reportPath, JSON.stringify(input))
  await writeFile(
    checksPath,
    JSON.stringify([{ name: 'CLI surface', outcome: 'pass', detail: '2.1.319' }]),
  )
  const merged = spawnSync(
    process.execPath,
    ['scripts/harness-monitor.mjs', 'merge-claude', reportPath, checksPath],
    { encoding: 'utf8' },
  )
  assert.equal(merged.status, 0, merged.stderr)
  const result = JSON.parse(merged.stdout)
  assert.deepEqual(result.providers.find((p) => p.id === 'codex').checks, input.providers[1].checks)
  const claude = normalizeReport(result.providers.find((p) => p.id === 'claude-code'))
  assert.equal(claude.checks.find((check) => check.name === 'CLI surface').outcome, 'pass')
  assert.ok(
    claude.checks
      .filter((check) => check.name !== 'CLI surface')
      .every((check) => check.outcome === 'unverified'),
  )
  const adapter = fakeAdapter()
  await reconcile(
    { ...result, providers: [result.providers.find((p) => p.id === 'claude-code')] },
    adapter,
  )
  assert.equal([...adapter.issues.values()][0].state, 'open')
})

test('fixture and CLI passes cannot close while Claude signals remain unverified', async () => {
  const adapter = fakeAdapter()
  const checks = [
    { name: 'CLI surface', outcome: 'pass' },
    {
      name: 'fixture consumers',
      outcome: 'pass',
      detail: 'Constructed attributed fixtures replayed.',
    },
    { name: 'historical-session inclusion', outcome: 'unverified' },
    { name: 'actual hook emission', outcome: 'unverified' },
    { name: 'permissions', outcome: 'unverified' },
    { name: 'messaging', outcome: 'unverified' },
  ]
  await reconcile(
    {
      ...report('claude-code', '2.1.319', 1),
      providers: [{ ...observation('claude-code', '2.1.319', 1), checks }],
    },
    adapter,
  )
  const issue = [...adapter.issues.values()][0]
  assert.equal(issue.state, 'open')
  assert.match(issue.body, /CLI surface: pass/)
  assert.match(issue.body, /fixture consumers: pass/)
  assert.match(issue.body, /actual hook emission: unverified/)
  assert.match(issue.body, /exact npm CLI surface/)
  assert.doesNotMatch(issue.body, /No provider harness was installed or executed/)
})

test('malformed runner checks cannot become a pass', () => {
  for (const invalid of [
    null,
    {},
    { name: 7, outcome: 'pass' },
    { name: 'CLI surface', outcome: 'pass', detail: {} },
  ]) {
    assert.throws(
      () => normalizeReport(observation('claude-code'), [invalid]),
      /Invalid normalized/,
    )
  }
})

test('missing required checks are unverified and cannot close an issue', async () => {
  const adapter = fakeAdapter()
  await reconcile(report('pi'), adapter)
  const omitted = report('pi', '1.0.0', 2, 'pass')
  omitted.providers[0].checks = []
  await reconcile(omitted, adapter)
  const issue = [...adapter.issues.values()][0]
  assert.equal(issue.state, 'open')
  assert.match(issue.body, /cli-contract: unverified/)
  assert.match(issue.body, /rpc-consumer: unverified/)
  assert.match(issue.body, /rpc-producer: unverified/)
})

test('failed reopening is retried even after report body succeeds', async () => {
  const adapter = fakeAdapter()
  await reconcile(report('codex', '1.0.0', 1), adapter)
  await reconcile(report('codex', '1.0.0', 2, 'pass'), adapter)
  const issue = [...adapter.issues.values()][0]
  assert.equal(issue.state, 'closed')
  const reopenIssue = adapter.reopenIssue
  let failOnce = true
  adapter.reopenIssue = async (number) => {
    if (failOnce) {
      failOnce = false
      throw new Error('reopen failed')
    }
    return reopenIssue(number)
  }
  await assert.rejects(reconcile(report('codex', '1.0.0', 3, 'mismatch'), adapter), /reopen failed/)
  assert.match(issue.body, /<!-- holi-harness-run:3 -->/)
  await reconcile(report('codex', '1.0.0', 3, 'mismatch'), adapter)
  assert.equal(issue.state, 'open')
})

test('closed unverified issues reopen even when report content is unchanged', async () => {
  const adapter = fakeAdapter()
  await reconcile(report('codex'), adapter)
  const issue = [...adapter.issues.values()][0]
  issue.state = 'closed'
  await reconcile(report('codex'), adapter)
  assert.equal(issue.state, 'open')
})

test('close failures surface instead of claiming a completed pass', async () => {
  const adapter = fakeAdapter()
  await reconcile(report('codex'), adapter)
  const closeIssue = adapter.closeIssue
  let failOnce = true
  adapter.closeIssue = async (number) => {
    if (failOnce) {
      failOnce = false
      throw new Error('GitHub issue update failed')
    }
    return closeIssue(number)
  }
  await assert.rejects(
    reconcile(report('codex', '1.0.0', 2, 'pass'), adapter),
    /GitHub issue update failed/,
  )
  await reconcile(report('codex', '1.0.0', 2, 'pass'), adapter)
  assert.equal([...adapter.issues.values()][0].state, 'closed')
})

test('stale reports cannot overwrite or close a newer observation', async () => {
  const adapter = fakeAdapter()
  await reconcile(report('codex', '2.0.0', 9), adapter)
  await reconcile(report('codex', '1.0.0', 8, 'pass'), adapter)
  const issue = [...adapter.issues.values()][0]
  assert.match(issue.body, /Observed npm latest: `2.0.0`/)
  assert.equal(issue.state, 'open')
  assert.equal(adapter.comments.length, 0)
})

test('issue adapter failures propagate without being mistaken for success', async () => {
  const adapter = fakeAdapter()
  adapter.findTrackingIssue = async () => {
    throw new Error('GitHub API unavailable')
  }
  await assert.rejects(reconcile(report('pi'), adapter), /GitHub API unavailable/)
})
