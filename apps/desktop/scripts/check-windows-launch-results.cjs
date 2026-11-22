const { isDeepStrictEqual, stripVTControlCharacters } = require('node:util')
const { createHash } = require('node:crypto')
const { lstatSync, readdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs')
const os = require('node:os')
const { basename, join, resolve } = require('node:path')

const {
  required,
  smokeSuites,
  lifecycle,
  lifecycleExpectation,
  control,
  producer,
} = require('./windows-launch-results-manifest.cjs')

const candidateSchema = 'holi.windows-owned-process.candidate.v2'

function readRegularFile(path, encoding) {
  check(lstatSync(path).isFile(), 'Expected a regular evidence file')
  return readFileSync(path, encoding)
}

function assertDirectory(path) {
  check(lstatSync(path).isDirectory(), 'Expected a real evidence directory')
}

function absent(path) {
  // Unlike existsSync, permission errors and dangling links do not look absent.
  return lstatSync(path, { throwIfNoEntry: false }) === undefined
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex')
}

function runPaths(runDirectory, env) {
  const { GITHUB_SHA: gitSha, GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: runAttempt } = env
  check(typeof gitSha === 'string' && /^[0-9a-f]{40}$/.test(gitSha), 'Invalid GITHUB_SHA')
  for (const id of [runId, runAttempt]) {
    check(typeof id === 'string' && /^[1-9][0-9]*$/.test(id), 'Invalid run ID or attempt')
  }
  check(
    basename(resolve(runDirectory)) === `windows-agent-${gitSha}-${runId}-${runAttempt}`,
    'Run directory is not bound to the tested run',
  )
  assertDirectory(runDirectory)
  return {
    workspace: join(runDirectory, 'proof-workspace'),
    candidatePath: join(runDirectory, 'owned-process-candidate.json'),
    finalPath: join(runDirectory, 'owned-process-proof.json'),
    binding: {
      gitSha,
      runId,
      runAttempt,
      platform: process.platform,
      platformVersion: os.release(),
      architecture: os.arch(),
      node: process.version,
    },
  }
}

// Evidence errors may name a manifest case or field, never values from a log,
// reporter, or sidecar. In particular, do not print assertion diffs or JSON parse errors.
class EvidenceError extends Error {}

function check(condition, label) {
  if (!condition) throw new EvidenceError(label)
}

function parseEvidence(contents, label) {
  try {
    return JSON.parse(contents)
  } catch {
    throw new EvidenceError(`Malformed JSON: ${label}`)
  }
}

function assertShape(value, expected, label) {
  if (typeof expected === 'function') {
    check(expected(value), label)
  } else if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    const keys = Object.keys(expected)
    check(
      value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).length === keys.length &&
        keys.every((key) => Object.hasOwn(value, key)),
      `${label}: wrong fields`,
    )
    for (const key of keys) assertShape(value[key], expected[key], `${label}.${key}`)
  } else {
    check(isDeepStrictEqual(value, expected), label)
  }
}

function verifyLifecycle(directory, platformVersion) {
  assertDirectory(directory)
  check(
    isDeepStrictEqual(readdirSync(directory).sort(), lifecycle.map(([id]) => `${id}.json`).sort()),
    'Unexpected, missing or duplicate native proof files',
  )
  return lifecycle.map((lifecycleCase) => {
    const [id, caseName] = lifecycleCase
    const record = parseEvidence(readRegularFile(join(directory, `${id}.json`), 'utf8'), caseName)
    const { roles, recordShape, processShape } = lifecycleExpectation(
      lifecycleCase,
      platformVersion,
    )
    assertShape(record, recordShape, caseName)
    for (const role of roles) {
      const matches = record.processes.filter((entry) => entry?.role === role)
      check(matches.length === 1, `${caseName}: expected one ${role} identity`)
      assertShape(matches[0], processShape(role), `${caseName}: ${role}`)
    }
    check(
      new Set(record.processes.map(({ pid }) => pid)).size === roles.length,
      `${caseName}: duplicate PID`,
    )
    return { id, ...record }
  })
}

function verifyLogCases(lines, prefix, cases) {
  const records = lines.filter((line) => line.startsWith(prefix))
  check(records.length === Object.keys(cases).length, `Wrong number of ${prefix.trim()} records`)
  const byCase = new Map()
  for (const line of records) {
    const record = parseEvidence(line.slice(prefix.length), prefix.trim())
    const caseName = record?.caseName
    check(
      typeof caseName === 'string' && Object.hasOwn(cases, caseName),
      `Unexpected case: ${prefix.trim()}`,
    )
    check(!byCase.has(caseName), `Duplicate native proof: ${caseName}`)
    assertShape(record, { caseName, ...cases[caseName] }, caseName)
    byCase.set(caseName, record)
  }
  return Object.keys(cases).map((caseName) => byCase.get(caseName))
}

function verifyEvidence(workspace, platformVersion) {
  const report = parseEvidence(
    readRegularFile(join(workspace, 'vitest.json'), 'utf8'),
    'Vitest report',
  )
  check(report?.success === true && report.numFailedTests === 0, 'Vitest did not pass')
  check(Array.isArray(report.testResults), 'Missing Vitest suites')

  function suite(file) {
    const matches = report.testResults.filter(
      (result) =>
        typeof result?.name === 'string' && result.name.replaceAll('\\', '/').endsWith('/' + file),
    )
    check(matches.length === 1, `Expected exactly one Windows suite: ${file}`)
    const tests = matches[0].assertionResults
    check(Array.isArray(tests) && tests.length > 0, `Empty Windows suite: ${file}`)
    return tests
  }

  for (const file of smokeSuites) {
    check(
      suite(file).some((test) => test?.status === 'passed'),
      `No executed cases: ${file}`,
    )
  }

  const requiredCases = Object.entries(required).flatMap(([file, names]) => {
    const tests = suite(file)
    if (file.startsWith('test/windows-owned-process-')) {
      check(tests.length === names.length, `Unexpected number of native cases: ${file}`)
    }
    return names.map((title) => {
      const matches = tests.filter((test) => test?.title === title)
      check(matches.length === 1, `${file}: expected required case ${title}`)
      check(matches[0].status === 'passed', `${file}: did not pass: ${title}`)
      return { file, title, status: 'passed' }
    })
  })

  const nativeCases = verifyLifecycle(join(workspace, 'native'), platformVersion)
  const lines = stripVTControlCharacters(readRegularFile(join(workspace, 'vitest.log'), 'utf8'))
    .split(/\r?\n/)
    .map((line) => line.trimStart())
  const controlCases = verifyLogCases(lines, 'HOLI_WINDOWS_OWNED_CONTROL_PROOF ', control).map(
    (record) => {
      const { caseName, proof } = record
      if (proof.jobMember === true) {
        check(
          proof.inspected === proof.handles &&
            proof.namedPipes <= proof.inspected &&
            proof.positivePipeMatches <= proof.namedPipes,
          `${caseName}: inconsistent handle scan counts`,
        )
      }
      return { ...record, platformVersion, receiptKind: proof.completion ?? proof.receipt }
    },
  )
  const producerCases = verifyLogCases(lines, 'HOLI_WINDOWS_OWNED_PRODUCER_PROOF ', producer)
  return { requiredCases, nativeCases, controlCases, producerCases, skippedRequiredCases: 0 }
}

function prepare(runDirectory, env = process.env) {
  const { workspace, candidatePath, finalPath, binding } = runPaths(runDirectory, env)
  assertDirectory(workspace)
  check(absent(finalPath), 'Final evidence already exists')
  const evidence = verifyEvidence(workspace, binding.platformVersion)
  const contents = JSON.stringify({ schema: candidateSchema, binding, evidence }) + '\n'
  writeFileSync(candidatePath, contents, { flag: 'wx' })
  return sha256(contents)
}

function finalize(runDirectory, preparedHash, env = process.env) {
  const { workspace, candidatePath, finalPath, binding } = runPaths(runDirectory, env)
  check(absent(workspace), 'Proof workspace was not removed')
  check(absent(finalPath), 'Final evidence already exists')
  check(
    typeof preparedHash === 'string' && /^[0-9a-f]{64}$/.test(preparedHash),
    'Missing prepared hash',
  )
  const contents = readRegularFile(candidatePath)
  check(sha256(contents) === preparedHash, 'Prepared candidate changed')
  const candidate = parseEvidence(contents, 'prepared candidate')
  check(candidate?.schema === candidateSchema, 'Invalid candidate schema')
  check(
    isDeepStrictEqual(candidate.binding, binding),
    'Candidate belongs to another run or platform',
  )
  // The hash binds the payload to the checker invocation before teardown. Stage the
  // final bytes beside their destination so the only publication is a same-volume rename.
  const pending = `${finalPath}.tmp`
  writeFileSync(
    pending,
    JSON.stringify(
      {
        schema: 'holi.windows-owned-process.v4',
        ...binding,
        ...candidate.evidence,
        candidateSha256: preparedHash,
        verdict: 'pass',
        nativeExecution: require.main === module && binding.platform === 'win32',
        cleanup: { proofWorkspaceRemoved: true },
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  )
  renameSync(pending, finalPath)
}

if (require.main === module) {
  try {
    check(process.platform === 'win32', 'This gate requires native Windows')
    const [command, runDirectory, preparedHash, ...extra] = process.argv.slice(2)
    check(
      runDirectory &&
        !extra.length &&
        ((command === 'prepare' && preparedHash === undefined) || command === 'finalize'),
      'Usage: check-windows-launch-results.cjs prepare <run-directory> | finalize <run-directory> <prepared-sha256>',
    )
    check(
      process.env.RUNNER_TEMP &&
        resolve(runDirectory) === resolve(process.env.RUNNER_TEMP, basename(runDirectory)),
      'Run directory must be directly under RUNNER_TEMP',
    )
    if (command === 'prepare') console.log(prepare(runDirectory))
    else finalize(runDirectory, preparedHash)
  } catch (error) {
    console.error(
      error instanceof EvidenceError
        ? error.message
        : 'Windows proof gate failed to read or publish evidence',
    )
    process.exitCode = 1
  }
}

// The portable checker tests supply synthetic records to the same transaction, not to the Windows CLI.
module.exports = { prepare, finalize, required, smokeSuites, lifecycle }
