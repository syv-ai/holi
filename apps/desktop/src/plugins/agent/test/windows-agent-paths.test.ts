/**
 * Where Claude Code's sessions are, and where it listens, on Windows
 * (docs/features/agent-sessions.md): a session's folder compared with the OS
 * separator, and a named pipe accepted as its inbox. The platform is injected,
 * so each case runs the same on any OS.
 */
import { describe, expect, it } from 'vitest'
import { parseListing } from '../main/claude/listing'
import { registerAgentRoutes } from '../main/claude/routes'
import type { SessionChannel } from '../main/claude/messaging'
import type { RouteServer } from '../main/provider'

const WIN_ROOT = String.raw`C:\Users\ada\Holi\o\r`

const rows = (cwds: string[]) =>
  JSON.stringify(cwds.map((cwd, i) => ({ kind: 'background', id: `abcdef0${i}`, cwd })))

describe('parseListing on Windows', () => {
  const kept = (cwds: string[], root = WIN_ROOT, platform: NodeJS.Platform = 'win32') =>
    parseListing(rows(cwds), root, platform).map((r) => cwds[Number(r.id.slice(-1))])

  it('keeps a session in the vault root or a subfolder of it', () => {
    const sub = `${WIN_ROOT}\\notes\\sub`
    expect(kept([WIN_ROOT, sub])).toEqual([WIN_ROOT, sub])
  })

  it('drops a folder that only starts with the same name', () => {
    const near = [`${WIN_ROOT}-other`, String.raw`C:\Users\ada\Holi\o`, `${WIN_ROOT}2\\a`]
    expect(kept(near)).toEqual([])
  })

  it('reads the drive letter and the separators as Windows does', () => {
    const slashed = `${WIN_ROOT}\\`
    const cwds = [String.raw`c:\users\ada\holi\o\r\sub`, 'C:/Users/ada/Holi/o/r/sub', slashed]
    expect(kept(cwds)).toEqual(cwds)
    expect(kept([slashed], slashed)).toEqual([slashed])
  })

  it('keeps POSIX comparing exactly', () => {
    const root = '/Users/ada/Holi/o/r'
    const cwds = [root, `${root}/sub`, `${root}-x`, '/users/ada/holi/o/r', `${root}\\sub`]
    expect(kept(cwds, root, 'darwin')).toEqual([root, `${root}/sub`])
  })
})

describe('a session inbox on Windows', () => {
  function accepted(socket: string, platform: NodeJS.Platform): SessionChannel[] {
    const routes: Record<string, { handle: (...a: unknown[]) => unknown }> = {}
    const got: SessionChannel[] = []
    const server = {
      route: (path: string, route: { handle: (...a: unknown[]) => unknown }) => {
        routes[path] = route
        return () => {}
      },
    } as unknown as RouteServer
    registerAgentRoutes(
      server,
      {
        onTurn: () => null,
        onChannel: (_r: string, _j: string, c: SessionChannel) => got.push(c),
        log: () => {},
      } as never,
      platform,
    )
    void routes['/session']!.handle(
      'o/r',
      new URLSearchParams({ job: 'abcdef01' }),
      JSON.stringify({ socket, token: 'abc123' }),
    )
    return got
  }

  const PIPE = '\\\\.\\pipe\\LOCAL\\cc-msg-1234-abcd'

  it('takes a named pipe', () => {
    expect(accepted(PIPE, 'win32')).toEqual([{ socket: PIPE, token: 'abc123' }])
  })

  it('still takes a socket path', () => {
    expect(accepted('/tmp/cc-msg.sock', 'win32')).toHaveLength(1)
    expect(accepted('/tmp/cc-msg.sock', 'linux')).toHaveLength(1)
  })

  it('refuses what is neither a pipe nor a socket, and a pipe off Windows', () => {
    expect(accepted(PIPE, 'darwin')).toEqual([])
    expect(accepted('\\\\server\\share\\x', 'win32')).toEqual([])
    expect(accepted('\\\\.\\pipe\\', 'win32')).toEqual([])
    expect(accepted(String.raw`C:\temp\sock`, 'win32')).toEqual([])
    expect(accepted(`${PIPE}\n`, 'win32')).toEqual([])
  })
})
