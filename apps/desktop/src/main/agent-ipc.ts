/**
 * The agent's IPC seam, distinct from the tRPC seam in `ipc.ts` (D110).
 *
 * Two kinds of thing cross it. **Sessions** are Claude Code's background
 * sessions, named by their job id: listed, started, stopped, respawned,
 * duplicated, sent an ask. **Terminals** are Holi's windows onto them, named by
 * a terminal id: PTY bytes and exits and the terminal list are pushed out
 * (`agent-pty:data`, `agent-pty:exit`, `agent:terminals`, with `agent:sessions`
 * for the session list); keystrokes, resize and focus are pushed in.
 *
 * Focus names neither: the focus file is the vault's, read by whichever session
 * takes the next turn.
 */
import { ipcMain } from 'electron'
import type { AgentSessions, Geometry } from './agent/agent-sessions'
import type { AgentTerminals, TerminalSummary } from './agent/agent-terminals'
import type { SessionSummary } from './agent/claude-sessions'
import type { FocusInput } from './agent/context-snapshot'
import type { SkillsUpdate } from './agent/seed-content'

export function registerAgentIpc(deps: {
  agent: AgentSessions
  terminals: AgentTerminals
  /** The palette's Update skills (D111), for the active vault. */
  updateSkills(): Promise<SkillsUpdate>
}): void {
  const { agent, terminals } = deps

  // Asked at mount, and a vault may just have opened: attach to it first.
  ipcMain.handle('agent:sessions', async (): Promise<SessionSummary[]> => {
    await agent.ensure()
    return agent.sessions()
  })
  ipcMain.handle('agent:terminals', (): TerminalSummary[] => terminals.list())

  ipcMain.handle('agent:open', (_e, args: Geometry & { attach?: string }) => agent.open(args))
  ipcMain.handle('agent:start', (_e, args: Geometry & { name?: string; prompt?: string }) =>
    agent.start(args),
  )
  // Request/response: an ask to a session that has just ended is refused back
  // to the sender, with the text still in the box they typed it into.
  ipcMain.handle('agent:send', (_e, args: Geometry & { text: string; target: string }) =>
    agent.send(args),
  )
  ipcMain.handle('agent:stop', (_e, id: string) => agent.stop(id))
  ipcMain.handle('agent:respawn', (_e, id: string) => agent.respawn(id))
  ipcMain.handle('agent:duplicate', (_e, args: Geometry & { id: string }) =>
    agent.duplicate(args.id, args),
  )

  ipcMain.handle('agent:update-skills', () => deps.updateSkills())

  ipcMain.handle('agent:attach', (_e, terminalId: string) => terminals.attach(terminalId))
  // Detach: ends the window, never the session.
  ipcMain.handle('agent-pty:close', (_e, terminalId: string) => terminals.close(terminalId))
  ipcMain.on('agent-pty:write', (_e, msg: { id: string; data: string }) =>
    terminals.write(msg.id, msg.data),
  )
  ipcMain.on('agent-pty:resize', (_e, size: { id: string; cols: number; rows: number }) =>
    terminals.resize(size.id, size.cols, size.rows),
  )
  ipcMain.on('agent:focus', (_e, focus: FocusInput) => agent.setFocus(focus))
}
