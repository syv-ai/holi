import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const workflow = readFileSync(
  new URL('../.github/workflows/harness-monitor.yml', import.meta.url),
  'utf8',
)

test('reporting reconciles after checker failures when discovery succeeded', () => {
  assert.match(
    workflow,
    /report:\n\s+needs: \[discover, codex-check, claude-check, pi-compatibility\]\n\s+if: always\(\) && needs\.discover\.result == 'success'/,
  )
  assert.match(workflow, /Prepare explicit missing-check coverage/)
  assert.match(workflow, /Checker failed or produced no result; required coverage is unavailable/)
  for (const name of ['codex-checks', 'claude-checks']) {
    assert.match(
      workflow,
      new RegExp(
        `- uses: actions/upload-artifact@v4\\n\\s+if: always\\(\\)\\n\\s+with:\\n\\s+name: ${name}`,
      ),
    )
  }
  assert.match(workflow, /name: pi-probe-results\n\s+path: \$\{\{ runner\.temp \}\}\/pi-results\//)
  assert.match(workflow, /Only this reporting job receives the issue-write token/)
})

test('every workflow run block has valid bash syntax', () => {
  const blocks = [...workflow.matchAll(/^        run: \|\n((?:          .*\n|\n)+)/gm)]
  assert.ok(blocks.length > 0, 'expected multiline run blocks')
  for (const [index, match] of blocks.entries()) {
    const script = match[1]
      .split('\n')
      .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
      .join('\n')
    const result = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' })
    assert.equal(result.status, 0, `workflow run block ${index + 1}: ${result.stderr}`)
  }
})

test('Pi and Codex consumer jobs build the native helper, never the Electron PTY', () => {
  for (const job of ['pi-compatibility', 'codex-check']) {
    const block = workflow.split(`  ${job}:`)[1].split(/\n  [a-z-]+:/)[0]
    assert.match(block, /node scripts\/build-posix-lease\.mjs/)
    assert.doesNotMatch(block, /rebuild:natives/)
    assert.match(block, /native\.outcome/)
  }
  assert.match(workflow, /GITHUB_STEP_SUMMARY/)
  assert.match(workflow, /name: harness-monitor-report/)
})
