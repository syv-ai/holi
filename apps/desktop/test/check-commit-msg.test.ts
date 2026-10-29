import { describe, expect, test } from 'vitest'
// @ts-expect-error -- plain .mjs script, no types
import { problemsIn } from '../../../scripts/check-commit-msg.mjs'

const problems = problemsIn as (message: string) => string[]

describe('commit message check', () => {
  test.each([
    'feat: add the thing',
    "fix(agent): a schedule is one person's (#112)",
    'chore(release): 0.5.1',
    'doc: renderer conventions',
    'refac: move blocks into features\n',
    'Merge branch main into feat/x',
    'feat: add x\n# Please enter the commit message\n# Changes to be committed:',
  ])('accepts %j', (message) => {
    expect(problems(message)).toEqual([])
  })

  test.each([
    ['Add the thing', /not `type: subject`/],
    ['feature: add the thing', /not `type: subject`/],
    ['feat:add the thing', /not `type: subject`/],
    ['feat(Agent): add', /not `type: subject`/],
    ['', /empty/],
    ['feat: add x\n\nWith a body.', /body or trailers/],
    ['feat: add x\n\nCo-Authored-By: Claude <noreply@anthropic.com>', /Co-Authored-By/],
    ['feat: add x\n\nClaude-Session: https://claude.ai/code/session_1', /Claude-Session/],
    ['feat: add x\n\nGenerated with Claude Code', /Generated with Claude Code/],
  ])('rejects %j', (message, why) => {
    expect(problems(message).join('\n')).toMatch(why)
  })
})
