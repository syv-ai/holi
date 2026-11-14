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

    const body = renderBody(normalized)
    const allPass =
      normalized.checks.length > 0 && normalized.checks.every((check) => check.outcome === 'pass')
    if (!tracked) {
      await adapter.createIssue({
        title: `${provider.name} compatibility: ${provider.version}`,
        label,
        body,
      })
      continue
    }
    const changed =
      !previous ||
      previous.version !== provider.version ||
      previous.reportKey !== reportKey(normalized)
    const sameRelease = previous?.version === provider.version
    const currentRun = normalized.runNumber >= (previous?.runNumber ?? 0)
    if (changed || currentRun) {
      // Persist newest run metadata even when checks are unchanged, preventing a
      // delayed older observation from replacing the evidence.
      await adapter.updateIssue(tracked.number, {
        title: `${provider.name} compatibility: ${provider.version}`,
        body,
      })
    }

    // Reconcile state independently of content changes so a failed state mutation
    // can be retried after the body edit has already succeeded.
    if (!allPass) {
      if (tracked.state === 'closed') await adapter.reopenIssue(tracked.number)
    } else if (sameRelease && currentRun) {
      if (tracked.state !== 'closed') await adapter.closeIssue(tracked.number)
    } else if (tracked.state === 'closed') {
      // A passing report for a newly observed release cannot inherit old checks.
      await adapter.reopenIssue(tracked.number)
    }

    if (changed) {
      await adapter.commentIssue(
        tracked.number,
        `<!-- holi-harness-report:${reportKey(normalized)} -->\nUpdated ${provider.name} to ${provider.version}; monitoring report: ${report.runUrl}`,
      )
    }
  }
}

function parseIssue(issue) {
  const version = issue.body.match(/^Observed npm latest: `([^`]+)`$/m)?.[1]
  const runNumber = Number(issue.body.match(/<!-- holi-harness-run:(\d+) -->/)?.[1] || 0)
  const reportKey = issue.body.match(/<!-- holi-harness-report:([^>]+) -->/)?.[1] || ''
  return { version, runNumber, reportKey }
}

function reportKey(report) {
  return `${report.version}:${report.checks
    .map(({ name, outcome, detail = '' }) => `${name}=${outcome}:${detail}`)
    .sort()
    .join(',')}`
}

function renderBody(report) {
  const checkLines = report.checks.map(
    (check) => `- **${check.name}: ${check.outcome}**${check.detail ? ` — ${check.detail}` : ''}`,
  )
  const mismatches = report.checks.filter((check) => check.outcome === 'mismatch')
  return [
    `Monitoring-only observation for **${report.name}** (\`${report.package}\`). ${report.id === 'pi' ? 'The isolated CLI contract executes the exact npm version without provider credentials or live prompts; RPC consumer fixtures are constructed from attributed upstream sources, and producer emission remains unverified.' : report.id === 'codex' ? 'The exact npm CLI surface and production consumer fixtures are checked in an isolated, read-only job; live provider execution and output not captured by fixtures remain unverified.' : 'No provider harness was installed or executed.'}`,

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
    `Mismatches: ${mismatches.length ? mismatches.map((check) => `${check.name}: ${check.detail || 'mismatch'}`).join('; ') : 'None reported.'}`,
    '',
    issueMarker(report.id),
    runMarker(report.runNumber),
    `<!-- holi-harness-report:${reportKey(report)} -->`,
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
  const pi = report.providers.find((provider) => provider.id === 'pi')
  if (!pi) throw new Error('Pi observation is missing')
  pi.checks = [
    { name: 'cli-contract', ...cli },
    { name: 'rpc-consumer', ...consumer },
    {
      name: 'rpc-producer',
      outcome: 'unverified',
      detail:
        'No JSONL transcript was captured from the exact npm release; fixtures attributed to upstream revision b4899f59ef0fba6507c2e619fd804dcde51920ba do not prove producer emission.',
    },
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
