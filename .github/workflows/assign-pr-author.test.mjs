import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const workflow = await readFile(new URL('./assign-pr-author.yml', import.meta.url), 'utf8')
const scriptMatch = workflow.match(/^          script: \|\n((?:            .*\n|\n)+)/m)
assert.ok(scriptMatch, 'workflow must contain the tested github-script module')
const script = scriptMatch[1]
  .split('\n')
  .map((line) => (line.startsWith('            ') ? line.slice(12) : line))
  .join('\n')

async function run({ assignees = [], addResult, addError, getResult } = {}) {
  const calls = []
  let reads = 0
  const github = {
    rest: {
      issues: {
        async get(params) {
          calls.push(['get', params])
          reads += 1
          return { data: { assignees: reads === 1 ? assignees : (getResult ?? assignees) } }
        },
        async addAssignees(params) {
          calls.push(['addAssignees', params])
          if (addError) throw addError
          return addResult
        },
      },
    },
  }
  const warnings = []
  const core = { warning: (message) => warnings.push(message) }
  const context = {
    payload: { pull_request: { number: 17, user: { login: 'contributor' } } },
    repo: { owner: 'holi', repo: 'app' },
  }
  await new Function('github', 'context', 'core', `return (async () => { ${script}\n })()`)(
    github,
    context,
    core,
  )
  return { calls, warnings }
}

test('adds the event author and verifies assignment', async () => {
  const result = await run({ getResult: [{ login: 'contributor' }] })
  assert.deepEqual(
    result.calls.map(([name]) => name),
    ['get', 'addAssignees', 'get'],
  )
  assert.deepEqual(result.calls[1][1], {
    owner: 'holi',
    repo: 'app',
    issue_number: 17,
    assignees: ['contributor'],
  })
  assert.deepEqual(result.warnings, [])
})

test('leaves existing assignees untouched and remains idempotent', async () => {
  const result = await run({ assignees: [{ login: 'contributor' }, { login: 'other' }] })
  assert.deepEqual(
    result.calls.map(([name]) => name),
    ['get', 'get'],
  )
  assert.deepEqual(result.warnings, [])
})

test('warns if GitHub silently omits the requested assignee', async () => {
  const result = await run({ getResult: [{ login: 'other' }] })
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /not assignable/)
})

test('handles expected validation errors and confirms the final assignee list', async () => {
  const result = await run({ addError: { status: 422, message: 'Validation Failed' } })
  assert.equal(result.warnings.length, 2)
  assert.match(result.warnings[0], /could not assign/)
  assert.match(result.warnings[1], /not assignable/)
})

test('propagates unexpected failures', async () => {
  await assert.rejects(
    run({ addError: Object.assign(new Error('server failure'), { status: 500 }) }),
    /server failure/,
  )
})

test('keeps the privileged event least-privileged and never checks out PR code', () => {
  assert.match(workflow, /pull_request_target:\n    types: \[opened, reopened\]/)
  assert.match(workflow, /permissions:\n  issues: write/)
  assert.doesNotMatch(workflow, /contents:\s*write|pull-requests:\s*write/)
  assert.doesNotMatch(workflow, /actions\/checkout|run:\s|head\.sha/)
})
