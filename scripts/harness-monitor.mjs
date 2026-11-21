import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'

export const providers = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    package: '@anthropic-ai/claude-code',
    releaseNotesUrl: 'https://github.com/anthropics/claude-code/releases',
  },
  {
    id: 'codex',
    name: 'Codex',
    package: '@openai/codex',
    releaseNotesUrl: 'https://github.com/openai/codex/releases',
  },
  {
    id: 'pi',
    name: 'Pi',
    package: '@earendil-works/pi-coding-agent',
    releaseNotesUrl: 'https://github.com/earendil-works/pi/releases',
  },
]

const requiredChecks = {
  'claude-code': [
    'CLI surface',
    'fixture consumers',
    'historical-session inclusion',
    'actual hook emission',
    'permissions',
    'messaging',
  ],
  codex: [
    'CLI surface',
    'fixture consumers',
    'actual notify emission',
    'approval notifications',
    'inference events',
    'sandbox enforcement',
  ],
  pi: ['cli-contract', 'rpc-consumer', 'rpc-producer'],
}

const issueMarker = (id) => `<!-- holi-harness-monitor:${id} -->`
const runMarker = (run) => `<!-- holi-harness-run:${run} -->`

export async function discover({ fetchImpl = fetch, sha, runNumber, runUrl }) {
  if (!sha || !runNumber || !runUrl) throw new Error('Missing workflow observation metadata')
  const observations = await Promise.all(
    providers.map(async (provider) => {
      const url = `https://registry.npmjs.org/${encodeURIComponent(provider.package)}`
      const response = await fetchImpl(url, {
        headers: { accept: 'application/vnd.npm.install-v1+json' },
      })
      if (!response.ok)
        throw new Error(`npm registry returned ${response.status} for ${provider.package}`)
      const metadata = await response.json()
      const version = metadata['dist-tags']?.latest
      if (typeof version !== 'string' || !version)
        throw new Error(`npm latest is missing for ${provider.package}`)
      return {
        ...provider,
        version,
        npmUrl: `https://www.npmjs.com/package/${provider.package}`,
        releaseNotesUrl: provider.releaseNotesUrl,
      }
    }),
  )
  return { sha, runNumber: Number(runNumber), runUrl, providers: observations }
}

export function normalizeReport(observation, checks = observation.checks ?? []) {
  const allowed = new Set(['pass', 'mismatch', 'unverified'])
  if (!Array.isArray(checks)) throw new Error('Invalid normalized checks')
  for (const check of checks) {
    if (
      !check ||
      typeof check !== 'object' ||
      !allowed.has(check.outcome) ||
      typeof check.name !== 'string' ||
      !check.name.trim() ||
      (check.detail !== undefined && typeof check.detail !== 'string')
    )
      throw new Error('Invalid normalized check')
  }
  const normalizedChecks = [...checks]
  for (const name of requiredChecks[observation.id] ?? []) {
    if (!normalizedChecks.some((check) => check.name === name)) {
      normalizedChecks.push({
        name,
        outcome: 'unverified',
        detail: 'Required check coverage is missing from this report.',
      })
    }
  }
  return { ...observation, checks: normalizedChecks }
}

export async function reconcile(report, adapter) {
  for (const provider of report.providers) {
    const normalized = normalizeReport({
      ...provider,
      sha: report.sha,
      runNumber: report.runNumber,
      runUrl: report.runUrl,
    })
    const label = `harness-${provider.id}`
    const tracked = await adapter.findTrackingIssue(label, issueMarker(provider.id))
    const previous = tracked ? parseIssue(tracked) : null
    if (previous && previous.runNumber > normalized.runNumber) continue

    const failures = new Set(previous?.failures ?? [])
    for (const check of normalized.checks) {
      if (check.outcome === 'mismatch') failures.add(check.name)
      if (check.outcome === 'pass') failures.delete(check.name)
    }
    const unresolved = [...failures].sort()
    if (!tracked) {
      if (unresolved.length) {
        await adapter.createIssue({
          title: `${provider.name} compatibility: ${provider.version}`,
          label,
          body: renderBody(normalized, unresolved),
        })
      }
      continue
    }

    const added = unresolved.filter((name) => !previous.failures.includes(name))
    const pending =
      previous.pending ??
      (added.length
        ? {
            key: `alert-${provider.id}-${normalized.runNumber}`,
            message: `New failing checks for ${provider.name}: ${added.join(', ')}. Report: ${report.runUrl}`,
          }
        : null)
    // Save evidence before state mutations. A pending alert survives partial writes.
    await adapter.updateIssue(tracked.number, {
      title: `${provider.name} compatibility: ${provider.version}`,
      body: renderBody(normalized, unresolved, pending),
    })
    if (unresolved.length) {
      if (tracked.state === 'closed') await adapter.reopenIssue(tracked.number)
    } else if (tracked.state !== 'closed') {
      await adapter.closeIssue(tracked.number)
    }
    if (pending) {
      await adapter.commentIssue(
        tracked.number,
        `<!-- holi-harness-report:${pending.key} -->\n${pending.message}`,
      )
      await adapter.updateIssue(tracked.number, {
        title: `${provider.name} compatibility: ${provider.version}`,
        body: renderBody(normalized, unresolved),
      })
    }
  }
}

function parseIssue(issue) {
  const runNumber = Number(issue.body.match(/<!-- holi-harness-run:(\d+) -->/)?.[1] || 0)
  const state = issue.body.match(/<!-- holi-harness-state:([^ ]+) -->/)?.[1]
  if (state) return { runNumber, ...JSON.parse(Buffer.from(state, 'base64').toString('utf8')) }
  // Old tracking issues have no persisted state; retain their actual mismatch evidence.
  const failures = [...issue.body.matchAll(/^- \*\*(.+?): mismatch\*\*/gm)].map((match) => match[1])
  return { runNumber, failures, pending: null }
}

function renderBody(report, failures, pending = null) {
  const checkLines = report.checks.map(
    (check) => `- **${check.name}: ${check.outcome}**${check.detail ? ` — ${check.detail}` : ''}`,
  )
  const mismatches = report.checks.filter((check) => check.outcome === 'mismatch')
  return [
    `Compatibility evidence for **${report.name}** (\`${report.package}\`). ${report.id === 'pi' ? 'The isolated CLI contract and local synthetic-provider RPC producer execute the exact npm package without external provider credentials; RPC consumer fixtures are constructed from attributed upstream sources.' : report.id === 'codex' || report.id === 'claude-code' ? 'The exact npm CLI surface and production consumer fixtures are checked in an isolated, read-only job; live provider execution and output not captured by fixtures remain unverified.' : 'No provider harness was installed or executed.'}`,

    '',
    `Observed npm latest: \`${report.version}\``,
    `npm: ${report.npmUrl}`,
    `Release notes: ${report.releaseNotesUrl}`,
    `Holi commit: ${report.sha}`,
    `Workflow run: ${report.runUrl}`,
    '',
    'Checks (missing coverage is unverified, never a pass):',
    ...checkLines,
    '',
    `Unresolved failing checks (retained until explicitly passing): ${failures.join(', ') || 'None'}`,
    `Mismatches: ${mismatches.length ? mismatches.map((check) => `${check.name}: ${check.detail || 'mismatch'}`).join('; ') : 'None reported.'}`,
    '',
    issueMarker(report.id),
    runMarker(report.runNumber),
    `<!-- holi-harness-state:${Buffer.from(JSON.stringify({ failures, pending })).toString('base64')} -->`,
  ].join('\n')
}

function gh(args, input) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'inherit'],
  }).trim()
}

export function githubAdapter() {
  return {
    findTrackingIssue(label, marker) {
      const issues = JSON.parse(
        gh([
          'issue',
          'list',
          '--state',
          'all',
          '--label',
          label,
          '--limit',
          '100',
          '--json',
          'number,state,title,body',
        ]),
      )
      const issue = issues.find((item) => item.body.includes(marker)) || null
      return issue ? { ...issue, state: issue.state.toLowerCase() } : null
    },
    createIssue({ title, label, body }) {
      gh([
        'label',
        'create',
        label,
        '--color',
        '1d76db',
        '--description',
        'Harness compatibility monitoring',
        '--force',
      ])
      gh(['issue', 'create', '--title', title, '--label', label, '--body', body])
    },
    updateIssue(number, { title, body }) {
      gh(['issue', 'edit', String(number), '--title', title, '--body', body])
    },
    commentIssue(number, body) {
      const comments = JSON.parse(
        gh(['api', `repos/${process.env.GH_REPO}/issues/${number}/comments?per_page=100`]),
      )
      const marker = body.match(/<!-- holi-harness-report:([^>]+) -->/)?.[1]
      if (
        !comments.some((comment) => comment.body.includes(`<!-- holi-harness-report:${marker} -->`))
      ) {
        gh(['issue', 'comment', String(number), '--body', body])
      }
    },
    closeIssue(number) {
      gh(['issue', 'close', String(number)])
    },
    reopenIssue(number) {
      gh(['issue', 'reopen', String(number)])
    },
  }
}

if (process.argv[2] === 'merge-codex' || process.argv[2] === 'merge-claude') {
  const report = JSON.parse(await readFile(process.argv[3], 'utf8'))
  const checks = JSON.parse(await readFile(process.argv[4], 'utf8'))
  const id = process.argv[2] === 'merge-codex' ? 'codex' : 'claude-code'
  const provider = report.providers.find((item) => item.id === id)
  if (!provider) throw new Error(`${id} observation is missing`)
  provider.checks = checks
  process.stdout.write(JSON.stringify(report))
} else if (process.argv[2] === 'merge-pi') {
  const report = JSON.parse(await readFile(process.argv[3], 'utf8'))
  const cli = JSON.parse(await readFile(process.argv[4], 'utf8'))
  const consumer = JSON.parse(await readFile(process.argv[5], 'utf8'))
  const producer = JSON.parse(await readFile(process.argv[6], 'utf8'))
  const pi = report.providers.find((provider) => provider.id === 'pi')
  if (!pi) throw new Error('Pi observation is missing')
  pi.checks = [
    { name: 'cli-contract', ...cli },
    { name: 'rpc-consumer', ...consumer },
    { name: 'rpc-producer', ...producer },
  ]
  process.stdout.write(JSON.stringify(report))
} else if (process.argv[2] === 'discover') {
  const report = await discover({
    sha: process.env.HOLI_SHA,
    runNumber: process.env.RUN_NUMBER,
    runUrl: process.env.RUN_URL,
  })
  process.stdout.write(JSON.stringify(report))
} else if (process.argv[2] === 'report') {
  const report = JSON.parse(await readFile(process.argv[3], 'utf8'))
  await reconcile(report, githubAdapter())
}
