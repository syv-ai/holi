const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
assert.equal(process.platform, 'win32', 'This gate requires native Windows')
const report = JSON.parse(readFileSync(process.argv[2], 'utf8'))
assert.equal(report.success, true)
assert.equal(report.numFailedTests, 0)
for (const file of [
  'launch.test.ts',
  'tool-lookup.test.ts',
  'owned-process.test.ts',
  'windows-agents.test.ts',
  'agent-runtime.test.ts',
]) {
  assert(
    report.testResults.some((result) => result.name.replaceAll('\\', '/').endsWith('/' + file)),
    'Missing suite: ' + file,
  )
}
const tests = report.testResults.flatMap((result) => result.assertionResults)
for (const name of [
  'receives every argument exactly as given',
  'creates a console root without a visible console',
  'resolves filename-only Windows commands, including node.exe',
  'resolves relative executables from the requested cwd',
  'resolves node.exe from PATH on Windows',
  'resolves a relative executable against the requested cwd',
  'really stops a program and what it started',
  'stops a .cmd and the program behind it at the timeout',
  'reports cold-start timeout using the actual root state',
  'times out a running root and grandchild within the original execution budget',
  'completes after natural root exit and drains its output-holding descendant',
  'keeps a successful explicitly detached Claude background child alive',
  'times out and drains a root-exited descendant holding root stdout',
  'drains failed detached background launches before callback',
  'drains timed-out detached background launches before callback',
  'stops descendants after maxBuffer cleanup',
  'stops descendants after stdin error cleanup',
  'terminates descendants before reporting root exit',
  'stops the entire owned job and leaves no stop artifact (stdin failure: false)',
  'stops the entire owned job and leaves no stop artifact (stdin failure: true)',
  'fails closed when its parent is gone',
  'does not resolve the helper from a poisoned vault cwd',
  'handles a missing helper without leaking stdin errors',
]) {
  const matches = tests.filter((test) => test.fullName.includes(name))
  assert(matches.length > 0, 'Undiscovered native case: ' + name)
  for (const test of matches) assert.equal(test.status, 'passed', test.fullName)
}
console.log('Native Windows launch, argv and ownership cases all executed and passed')
