import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commentThreads, emptyVaultSnapshot, parseCommentsFile } from '@holi/shared'
import type { CapabilityError } from '../src/main/capabilities/error'
import { createCapabilityRegistry, type CapabilityContext } from '../src/main/capabilities/registry'
import { noCoreServices } from '../src/main/capabilities/services'
import { commentCapabilities, COMMENT_NAMESPACES } from '../src/main/vault/comment-capabilities'

let root: string
let login: string | null = 'ada'
const registry = createCapabilityRegistry()
registry.register(COMMENT_NAMESPACES, commentCapabilities({ login: () => login }))

const NOTE = 'plan.md'

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'holi-comment-caps-'))
  login = 'ada'
  await writeFile(join(root, NOTE), '# Plan\n\nThe budget is 40k.\n\nAgain: the budget.\n')
})

afterEach(() => rm(root, { recursive: true, force: true }))

const ctx = (): CapabilityContext => ({
  remote: 'o/r',
  root,
  bundle: null,
  snapshot: async () => ({ ...emptyVaultSnapshot(), files: [{ path: NOTE, updatedAt: '' }] }),
  claims: async () => [],
  core: noCoreServices(),
})

const run = (name: string, params: Record<string, string>) =>
  registry.run(name, 'cli', ctx(), params)

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: CapabilityError) => e.code,
  )

const stored = async () =>
  commentThreads(
    parseCommentsFile(await readFile(join(root, '.holi/comments/plan.md.json'), 'utf8'))!,
  )

describe('holi comments', () => {
  it("opens, answers and resolves a thread as the person's agent", async () => {
    const added = await run('comments.add', { path: NOTE, quote: '40k', body: 'Is this final?' })
    const { thread } = added.value as { thread: string }
    expect(added.text).toBe(`Opened thread ${thread} on line 3.`)

    await run('comments.reply', { path: NOTE, thread, body: 'Yes, @bob agreed.' })
    await run('comments.resolve', { path: NOTE, thread })

    const [t] = await stored()
    expect(t!.anchor).toMatchObject({ quote: '40k', line: 3 })
    expect(t!.comments.map((c) => [c.author, c.agent, c.body])).toEqual([
      ['ada', true, 'Is this final?'],
      ['ada', true, 'Yes, @bob agreed.'],
    ])
    expect(t!.status).toMatchObject({ resolved: true, by: 'ada' })

    const listed = await run('comments.list', { path: NOTE })
    expect(listed.text).toContain(`Thread ${thread} on "40k" (line 3)`)
    expect((await run('comments.list', {})).text).toBe('No open comments in this vault.')
  })

  it('asks which one when the quote repeats, and refuses text that is not there', async () => {
    expect(await refusal(run('comments.add', { path: NOTE, quote: 'budget', body: 'x' }))).toBe(
      'BAD_REQUEST',
    )
    await run('comments.add', { path: NOTE, quote: 'budget', body: 'x', line: '5' })
    expect((await stored())[0]!.anchor.line).toBe(5)
    expect((await run('comments.list', {})).text).toBe(`${NOTE}\t1 open`)

    expect(await refusal(run('comments.add', { path: NOTE, quote: 'nope', body: 'x' }))).toBe(
      'BAD_REQUEST',
    )
    expect(await refusal(run('comments.reply', { path: NOTE, thread: 'missing', body: 'x' }))).toBe(
      'NOT_FOUND',
    )
  })

  it("refuses the agent's own instructions", async () => {
    for (const path of ['AGENTS.md', '.claude/skills/x/SKILL.md', '.holi/memory/fact.md']) {
      expect(await refusal(run('comments.add', { path, quote: 'x', body: 'x' }))).toBe(
        'BAD_REQUEST',
      )
    }
  })

  it('writes nothing while nobody is signed in', async () => {
    login = null
    expect(await refusal(run('comments.add', { path: NOTE, quote: '40k', body: 'x' }))).toBe(
      'UNAVAILABLE',
    )
    await mkdir(join(root, '.holi'), { recursive: true })
    expect(await refusal(readFile(join(root, '.holi/comments/plan.md.json')))).not.toBeNull()
  })
})
