import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  codexProvider,
  NOTIFY_SCRIPT,
  notifyOverride,
  NOTIFICATIONS_OVERRIDE,
  readTurn,
  registerCodexRoutes,
  SESSION_ENV,
} from '../main/codex'
import type { BridgeRoute } from '../../../main/plugin-api'

const TARGET = { root: '/Users/ada/Holi/syv/vault', configDir: '/home/.codex', binDir: '/holi/bin' }
const SIGNAL = new AbortController().signal

describe('the Codex provider', () => {
  const codex = codexProvider({ resolveBin: () => '/usr/local/bin/codex' })

  it('runs Codex with its hook, its notifications on, and the session named to it', () => {
    const cmd = codex.terminal(TARGET, { session: 'p0123456789ab' })
    expect(cmd?.bin).toBe('/usr/local/bin/codex')
    // An approval prompt prints OSC 9, which the terminal reads as needs-you.
    expect(cmd?.args).toEqual(['-c', notifyOverride(), '-c', NOTIFICATIONS_OVERRIDE])
    expect(NOTIFICATIONS_OVERRIDE).toContain('"approval-requested"')
    expect(cmd?.env[SESSION_ENV]).toBe('p0123456789ab')
    expect(cmd?.env.PATH?.startsWith('/holi/bin:')).toBe(true)
  })

  it('puts a first ask after --, and picks up a conversation', () => {
    expect(codex.terminal(TARGET, { prompt: 'resume' })?.args.slice(4)).toEqual(['--', 'resume'])
    expect(codex.terminal(TARGET, { resume: 'pick' })?.args.slice(4)).toEqual(['resume'])
    expect(codex.terminal(TARGET, { resume: 'th-1', prompt: 'go on' })?.args.slice(4)).toEqual([
      'resume',
      'th-1',
      '--',
      'go on',
    ])
  })

  it('has no terminal without the CLI', () => {
    const missing = codexProvider({ resolveBin: () => null })
    expect(missing.terminal(TARGET)).toBeNull()
    expect(missing.installed()).toBe(false)
  })

  it('writes the hook as a TOML array of strings', () => {
    const value = notifyOverride().slice('notify='.length)
    expect(JSON.parse(value)).toEqual(['sh', '-c', NOTIFY_SCRIPT, 'holi-notify'])
  })

  it('has a hook that parses as shell and does nothing outside a session', () => {
    execFileSync('sh', ['-n', '-c', NOTIFY_SCRIPT])
    const env = { PATH: process.env.PATH ?? '' }
    expect(() =>
      execFileSync('sh', ['-c', NOTIFY_SCRIPT, 'holi-notify', '{}'], { env }),
    ).not.toThrow()
  })
})

describe('the Codex turn report', () => {
  it('names the session by its first ask, and its thread', () => {
    expect(
      readTurn(
        JSON.stringify({
          type: 'agent-turn-complete',
          'thread-id': '0199-abc',
          'input-messages': ['Tidy the inbox', 'and more'],
          'last-assistant-message': 'Done.',
        }),
      ),
    ).toEqual({ name: 'Tidy the inbox', conversationId: '0199-abc' })
    expect(readTurn('not json')).toEqual({})
    expect(readTurn(JSON.stringify({ 'thread-id': 'bad id with spaces' }))).toEqual({})
  })

  it('ends the turn of the session it names, and only a Holi id', async () => {
    const routes = new Map<string, BridgeRoute>()
    const turns: string[] = []
    const named: unknown[] = []
    registerCodexRoutes(
      { route: (path, route) => (routes.set(path, route), () => {}) },
      {
        onTurn: (remote, id, active) => turns.push(`${remote}:${id}:${active}`),
        onConversation: (_remote, _id, about) => named.push(about),
      },
    )
    const route = routes.get('/codex/turn-end')!
    const body = JSON.stringify({ 'input-messages': ['Plan'] })
    await route.handle('syv/vault', new URLSearchParams({ session: 'p0123456789ab' }), body, SIGNAL)
    await route.handle('syv/vault', new URLSearchParams({ session: 'deadbeef' }), body, SIGNAL)
    expect(turns).toEqual(['syv/vault:p0123456789ab:false'])
    expect(named).toEqual([{ name: 'Plan' }])
  })
})
