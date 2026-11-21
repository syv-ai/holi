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
  assert.equal(adapter.issues.size, 0)
})

test('Pi producer outcomes propagate through workflow projection without issue writes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'holi-pi-projection-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const input = {
    sha: 'abc',
    runNumber: 7,
    runUrl: 'https://example.test/run',
    providers: [observation('pi')],
  }
  const reportPath = join(dir, 'report.json')
  const cliPath = join(dir, 'cli.json')
  const consumerPath = join(dir, 'consumer.json')
  const producerPath = join(dir, 'producer.json')
  await writeFile(reportPath, JSON.stringify(input))
  await writeFile(cliPath, JSON.stringify({ outcome: 'pass' }))
  await writeFile(consumerPath, JSON.stringify({ outcome: 'pass' }))
  for (const outcome of ['pass', 'unverified', 'mismatch']) {
    await writeFile(producerPath, JSON.stringify({ outcome, detail: `native ${outcome}` }))
    const merged = spawnSync(
      process.execPath,
      ['scripts/harness-monitor.mjs', 'merge-pi', reportPath, cliPath, consumerPath, producerPath],
      { encoding: 'utf8' },
    )
    assert.equal(merged.status, 0, merged.stderr)
    const pi = JSON.parse(merged.stdout).providers[0]
    const normalized = normalizeReport(pi)
    assert.equal(normalized.checks.find((check) => check.name === 'rpc-producer').outcome, outcome)
    assert.equal(
      normalized.checks.find((check) => check.name === 'rpc-producer').detail,
      `native ${outcome}`,
    )
  }
  const adapter = fakeAdapter()
  await reconcile(
    {
      ...input,
      providers: [
        normalizeReport({
          ...input.providers[0],
          checks: [
            { name: 'cli-contract', outcome: 'pass' },
            { name: 'rpc-consumer', outcome: 'pass' },
            { name: 'rpc-producer', outcome: 'unverified', detail: 'native unverified' },
          ],
        }),
      ],
    },
    adapter,
  )
  assert.equal(adapter.issues.size, 0)
})

test('missing Pi checker results remain unverified and cannot close an issue', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'holi-pi-missing-results-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const input = { ...report('pi', '1.0.0', 2), providers: [observation('pi', '1.0.0', 2, 'pass')] }
  const files = ['report.json', 'cli.json', 'consumer.json', 'producer.json'].map((file) =>
    join(dir, file),
  )
  await writeFile(files[0], JSON.stringify(input))
  for (const file of files.slice(1)) {
    await writeFile(
      file,
      JSON.stringify({
        outcome: 'unverified',
        detail: 'Checker failed or produced no result; required coverage is unavailable.',
      }),
    )
  }
  const merged = spawnSync(
    process.execPath,
    ['scripts/harness-monitor.mjs', 'merge-pi', ...files],
    { encoding: 'utf8' },
  )
  assert.equal(merged.status, 0, merged.stderr)
  const adapter = fakeAdapter()
  await reconcile(JSON.parse(merged.stdout), adapter)
  assert.equal(adapter.issues.size, 0)
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

function evidence(checks, runNumber = 1, version = '1.0.0') {
  const value = report('pi', version, runNumber)
  value.providers[0].checks = checks
  return value
}
const failure = [{ name: 'rpc-consumer', outcome: 'mismatch', detail: 'broken' }]
const passing = [{ name: 'rpc-consumer', outcome: 'pass' }]

test('healthy and unverified observations stay quiet', async () => {
  const adapter = fakeAdapter()
  await reconcile(report('pi'), adapter)
  await reconcile(evidence(passing, 2), adapter)
  assert.equal(adapter.issues.size, 0)
})

test('version and detail churn stay quiet, new failing checks alert', async () => {
  const adapter = fakeAdapter()
  await reconcile(evidence(failure), adapter)
  await reconcile(evidence([{ ...failure[0], detail: 'changed path' }], 2, '2.0.0'), adapter)
  assert.equal(adapter.comments.length, 0)
  await reconcile(evidence([...failure, { name: 'cli-contract', outcome: 'mismatch' }], 3), adapter)
  assert.equal(adapter.comments.length, 1)
  assert.match(adapter.comments[0].body, /cli-contract/)
})

test('unverified checks retain failure evidence; explicit pass resolves despite coverage gaps', async () => {
  const adapter = fakeAdapter()
  await reconcile(evidence(failure), adapter)
  await reconcile(evidence([], 2), adapter)
  await reconcile(evidence([{ name: 'rpc-consumer', outcome: 'unverified' }], 3), adapter)
  assert.equal(adapter.issues.get(1).state, 'open')
  assert.match(adapter.issues.get(1).body, /retained until explicitly passing.*rpc-consumer/)
  assert.equal(adapter.comments.length, 0)
  await reconcile(evidence(passing, 4), adapter)
  assert.equal(adapter.issues.get(1).state, 'closed')
  await reconcile(evidence([], 5, '3.0.0'), adapter)
  assert.equal(adapter.issues.get(1).state, 'closed')
  await reconcile(evidence(failure, 6), adapter)
  assert.equal(adapter.issues.get(1).state, 'open')
  assert.equal(adapter.comments.length, 1)
  await reconcile(evidence(passing, 7), adapter)
  await reconcile(evidence(failure, 8), adapter)
  assert.equal(adapter.comments.length, 2)
})

test('legacy informational trackers close silently, legacy mismatch evidence persists', async () => {
  for (const mismatch of [false, true]) {
    const adapter = fakeAdapter()
    await adapter.createIssue({
      title: 'legacy',
      label: 'harness-pi',
      body:
        '- **rpc-consumer: ' +
        (mismatch ? 'mismatch' : 'unverified') +
        '**\n<!-- holi-harness-monitor:pi -->\n<!-- holi-harness-run:1 -->',
    })
    await reconcile(evidence([], 2), adapter)
    assert.equal(adapter.issues.get(1).state, mismatch ? 'open' : 'closed')
    assert.equal(adapter.comments.length, 0)
  }
})

test('stale reports cannot overwrite or close newer evidence', async () => {
  const adapter = fakeAdapter()
  await reconcile(evidence(failure, 9), adapter)
  const body = adapter.issues.get(1).body
  await reconcile(evidence(passing, 8), adapter)
  assert.equal(adapter.issues.get(1).body, body)
  assert.equal(adapter.issues.get(1).state, 'open')
})

test('partial state mutations and alert writes retry without duplicate comments', async () => {
  for (const method of ['reopenIssue', 'commentIssue', 'closeIssue']) {
    const adapter = fakeAdapter()
    await reconcile(evidence(failure), adapter)
    await reconcile(evidence(passing, 2), adapter)
    const original = adapter[method]
    let once = true
    adapter[method] = async (...args) => {
      if (once) {
        once = false
        throw new Error('failed write')
      }
      return original(...args)
    }
    if (method === 'closeIssue') await reconcile(evidence(failure, 3), adapter)
    const current = evidence(method === 'closeIssue' ? passing : failure, 4)
    await assert.rejects(reconcile(current, adapter), /failed write/)
    await reconcile(current, adapter)
    await reconcile(current, adapter)
    assert.equal(adapter.issues.get(1).state, method === 'closeIssue' ? 'closed' : 'open')
    assert.equal(adapter.comments.length, 1)
  }
})
