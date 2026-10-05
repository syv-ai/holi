import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { readBlockedQuestion } from '../main/claude/blocked'

async function configWith(state: string | null): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'blocked-'))
  if (state !== null) {
    await mkdir(join(dir, 'jobs', 'abc12345'), { recursive: true })
    await writeFile(join(dir, 'jobs', 'abc12345', 'state.json'), state)
  }
  return dir
}

test('reads the questions a job is blocked on', async () => {
  const questions = [{ question: 'Which?', options: [{ label: 'A', description: '' }] }]
  const dir = await configWith(JSON.stringify({ state: 'working', block: { questions } }))
  expect(JSON.parse((await readBlockedQuestion(dir, 'abc12345'))!)).toEqual({ questions })
})

test('is null for a job that is not blocked, is unreadable, or has an unsafe id', async () => {
  expect(await readBlockedQuestion(await configWith('{"state":"idle"}'), 'abc12345')).toBeNull()
  expect(await readBlockedQuestion(await configWith('{nope'), 'abc12345')).toBeNull()
  expect(await readBlockedQuestion(await configWith(null), 'abc12345')).toBeNull()
  expect(await readBlockedQuestion(await configWith('{}'), '../abc12345')).toBeNull()
})
