/**
 * `holi plugin <id> <verb>` as main reads it: what it lists, what it refuses
 * before anything runs, and what it hands the script to run.
 */
import { describe, expect, test } from 'vitest'
import { CapabilityError } from '../../../main/plugin-api'
import { resolveVerb, type RunningPlugin } from '../main/verbs'

const modelokale: RunningPlugin = {
  id: 'modelokale',
  name: 'Mødelokale',
  cli: {
    run: ['node', 'bin/modelokale.mjs', '--vault', '{vault}'],
    verbs: { login: 'Sign in to the booking site', book: 'Book a room' },
  },
  codeDir: '/plugins/modelokale/abc',
}
const dash: RunningPlugin = { id: 'dash', name: 'Dash', codeDir: '/plugins/dash/def' }
const running = [modelokale, dash]

const refusal = (argv: string[]) => {
  try {
    resolveVerb(argv, running, '/vault')
  } catch (error) {
    if (error instanceof CapabilityError) return { code: error.code, message: error.message }
    throw error
  }
  throw new Error(`${argv.join(' ')} was not refused`)
}

describe('resolveVerb', () => {
  test('runs the verb in the plugin folder, with every word after it as typed', () => {
    const argv = ['modelokale', 'book', '--room', 'Garage 2', '--help', '--', "it's"]
    expect(resolveVerb(argv, running, '/vault')).toEqual({
      kind: 'run',
      run: {
        cwd: '/plugins/modelokale/abc',
        argv: [
          'node',
          'bin/modelokale.mjs',
          '--vault',
          '/vault',
          'book',
          '--room',
          'Garage 2',
          '--help',
          '--',
          "it's",
        ],
        env: { HOLI_VAULT_ROOT: '/vault' },
      },
    })
  })

  test('bare, lists only the running plugins that have verbs', () => {
    for (const argv of [[], ['--help'], ['-h']]) {
      const answer = resolveVerb(argv, running, '/vault')
      expect(answer.kind).toBe('text')
      const text = answer.kind === 'text' ? answer.text : ''
      expect(text).toContain('modelokale (Mødelokale)')
      expect(text).toMatch(/holi plugin modelokale login +Sign in to the booking site/)
      expect(text).not.toContain('dash')
    }
    expect(resolveVerb([], [dash], '/vault')).toEqual({
      kind: 'text',
      text: 'No community plugin with verbs runs in this vault here.',
    })
  })

  test('with only the plugin, lists its verbs', () => {
    for (const argv of [['modelokale'], ['modelokale', '--help']]) {
      const answer = resolveVerb(argv, running, '/vault')
      expect(answer.kind === 'text' && answer.text).toMatch(
        /holi plugin modelokale book +Book a room/,
      )
    }
  })

  test('refuses before anything runs when the plugin or the verb is not there', () => {
    expect(refusal(['prezzi', 'book'])).toEqual({
      code: 'NOT_FOUND',
      message: 'prezzi does not run in this vault here',
    })
    expect(refusal(['dash', 'version'])).toMatchObject({ code: 'NOT_FOUND' })
    expect(refusal(['modelokale', 'cancel'])).toEqual({
      code: 'NOT_FOUND',
      message: 'modelokale has no verb cancel',
    })
    // An inherited name is not a verb.
    expect(refusal(['modelokale', 'constructor'])).toMatchObject({ code: 'NOT_FOUND' })
  })

  test('refuses an option before the verb, so a rule naming the verb stays sound', () => {
    expect(refusal(['--room', 'modelokale', 'book'])).toMatchObject({ code: 'BAD_REQUEST' })
    expect(refusal(['modelokale', '--room', 'x', 'book'])).toMatchObject({ code: 'BAD_REQUEST' })
  })
})
