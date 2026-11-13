const MARKER_PREFIX = '<!-- holi-harness-release:'
const CONTRACT = 'contract checks not run; compatibility unverified'
const MAX_NOTES = 4000
const TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024

export const HARNESS = [
  { id: 'claude-code', package: '@anthropic-ai/claude-code', repo: 'anthropics/claude-code' },
  { id: 'codex', package: '@openai/codex', repo: 'openai/codex' },
  { id: 'pi', package: '@earendil-works/pi-coding-agent', repo: 'badlogic/pi-mono' },
]

function marker(id) {
  return `${MARKER_PREFIX} ${id} -->`
}

function validVersion(value) {
  return (
    typeof value === 'string' &&
    value.length <= 128 &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
  )
}

async function request(fetch, url, { token, github = false, method = 'GET', body } = {}) {
  const headers = { Accept: 'application/vnd.github+json' }
  if (github && token) headers.Authorization = `Bearer ${token}`
  const options = { method, headers, signal: AbortSignal.timeout(TIMEOUT_MS) }
  if (body) {
    headers['Content-Type'] = 'application/json'
    options.body = JSON.stringify(body)
  }
  const response = await fetch(url, options)
  if (!response.ok)
    throw Object.assign(new Error(`HTTP ${response.status} for ${url}`), {
      status: response.status,
    })
  if (response.status === 204) return { data: null, headers: response.headers }
  const declaredLength = Number(response.headers.get('content-length'))
  if (declaredLength > MAX_RESPONSE_BYTES)
    throw new Error(`Response exceeded ${MAX_RESPONSE_BYTES} bytes for ${url}`)
  let text
  if (response.body?.getReader) {
    const reader = response.body.getReader()
    const chunks = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error(`Response exceeded ${MAX_RESPONSE_BYTES} bytes for ${url}`)
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    text = new TextDecoder().decode(bytes)
  } else text = await response.text()
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES)
    throw new Error(`Response exceeded ${MAX_RESPONSE_BYTES} bytes for ${url}`)
  return { data: JSON.parse(text), headers: response.headers }
}

async function releaseNotes(fetch, token, repo, version) {
  const tag = `v${version}`
  try {
    const { data } = await request(
      fetch,
      `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`,
      { token, github: true },
    )
    if (
      data.tag_name !== tag ||
      typeof data.html_url !== 'string' ||
      !data.html_url.startsWith(`https://github.com/${repo}/releases/tag/`)
    )
      return null
    const body = typeof data.body === 'string' ? data.body.trim().slice(0, MAX_NOTES) : ''
    return { url: data.html_url, excerpt: body }
  } catch (error) {
    if (error.status === 404) return null
    throw error
  }
}

async function allIssues(fetch, token) {
  const issues = []
  let url = 'https://api.github.com/repos/syv-ai/holi/issues?state=all&per_page=100'
  while (url) {
    const response = await request(fetch, url, { token, github: true })
    if (!Array.isArray(response.data)) throw new Error('Malformed GitHub issue page')
    issues.push(...response.data.filter((issue) => !issue.pull_request))
    const link = response.headers.get('link') ?? ''
    url = link.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? ''
    if (issues.length > 20_000) throw new Error('GitHub issue listing exceeded safety limit')
  }
  return issues
}

function reportBody(harness, version, published, notes, runUrl) {
  const noteLine = notes
    ? `Release notes: ${notes.url}${notes.excerpt ? `\n\n> ${notes.excerpt.replaceAll('\n', '\n> ')}` : '\n\nThe upstream release has no notes.'}`
    : 'Release notes: unavailable for this version.'
  return [
    `${harness.package} **${version}** is the stable npm latest release.`,
    `Published: ${published}`,
    noteLine,
    `Workflow run: ${runUrl}`,
    '',
    `**${CONTRACT}**`,
    '',
    'Discovery is not a compatibility verification and does not establish a tested-with version.',
    '',
    marker(harness.id),
  ].join('\n')
}

/** Discover and reconcile stable harness releases. Each harness fails independently. */
export async function watch({ fetch = globalThis.fetch, token, runUrl }) {
  if (!token || !runUrl || !runUrl.startsWith('https://github.com/syv-ai/holi/actions/runs/'))
    throw new Error('Missing GitHub token or valid workflow run URL')
  const issues = await allIssues(fetch, token)
  const failures = []
  const outcomes = []
  for (const harness of HARNESS) {
    try {
      const { data } = await request(
        fetch,
        `https://registry.npmjs.org/${encodeURIComponent(harness.package)}`,
      )
      const version = data?.['dist-tags']?.latest
      const metadata = data?.versions?.[version]
      if (
        !validVersion(version) ||
        !metadata ||
        typeof metadata.time !== 'string' ||
        Number.isNaN(Date.parse(metadata.time))
      )
        throw new Error(`Malformed npm metadata for ${harness.package}`)
      const notes = await releaseNotes(fetch, token, harness.repo, version)
      const body = reportBody(harness, version, metadata.time, notes, runUrl)
      const matching = issues.filter(
        (issue) =>
          issue.user?.login === 'github-actions[bot]' && issue.body?.includes(marker(harness.id)),
      )
      const issue = matching.find(
        (candidate) => candidate.title === `Harness release: ${harness.id}`,
      )
      if (matching.length > 1) throw new Error(`Multiple bot-owned reports found for ${harness.id}`)
      if (!issue) {
        await request(fetch, 'https://api.github.com/repos/syv-ai/holi/issues', {
          token,
          github: true,
          method: 'POST',
          body: { title: `Harness release: ${harness.id}`, body, labels: ['vault-assistant'] },
        })
        outcomes.push(`${harness.id}: created ${version}`)
        continue
      }
      const sameDiscovery =
        issue.body?.split('\nWorkflow run:')[0] === body.split('\nWorkflow run:')[0]
      if (sameDiscovery && issue.state === 'open') {
        outcomes.push(`${harness.id}: unchanged ${version}`)
        continue
      }
      if (issue.state === 'closed' && !sameDiscovery) {
        await request(fetch, `https://api.github.com/repos/syv-ai/holi/issues/${issue.number}`, {
          token,
          github: true,
          method: 'PATCH',
          body: { state: 'open', title: `Harness release: ${harness.id}`, body },
        })
        outcomes.push(`${harness.id}: reopened ${version}`)
      } else if (!sameDiscovery) {
        await request(fetch, `https://api.github.com/repos/syv-ai/holi/issues/${issue.number}`, {
          token,
          github: true,
          method: 'PATCH',
          body: { title: `Harness release: ${harness.id}`, body },
        })
        outcomes.push(`${harness.id}: updated ${version}`)
      } else outcomes.push(`${harness.id}: unchanged ${version}`)
    } catch (error) {
      failures.push(`${harness.id}: ${error.message}`)
      console.error(`${harness.id}: ${error.message}`)
    }
  }
  console.log(outcomes.join('\n'))
  if (failures.length) throw new Error(`Harness discovery failed: ${failures.join('; ')}`)
}

async function cli() {
  await watch({ token: process.env.GITHUB_TOKEN, runUrl: process.env.RUN_URL })
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  cli().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
