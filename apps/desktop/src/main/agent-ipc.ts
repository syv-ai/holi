/**
 * The agent's IPC seam — distinct from the tRPC seam in `ipc.ts`. A session is a
 * live byte stream: PTY data/exit and the session list are pushed out to the
 * renderer by the manager (`agent-pty:data`, `agent-pty:exit`, `agent:sessions`);
 * keystrokes, resize and focus are pushed in; start/kill/attach/sessions are
 * request/response. Channel names mirror prd/agent.md's wire shape.
 *
 * **Every route but focus names a session (D100).** A vault runs several, so
 * "write to the agent" is not an address. Focus is the exception because the
 * focus file is the vault's, one path in the clone, read by whichever session
 * takes the next turn.
 */
import { ipcMain } from 'electron'
import type { AgentManager, SessionSummary } from './agent/agent-manager'
import type { FocusInput } from './agent/context-snapshot'

export function registerAgentIpc(deps: { agent: AgentManager }): void {
  const { agent } = deps

  // The manager throws on a bad start (no CLI, vault not active). The drawer
  // wants a message it can print in red, not an IPC rejection — so tag it.
  ipcMain.handle(
    'agent-pty:start',
    async (
      _e,
      args: {
        vaultId: string
        name?: string
        resume?: boolean
        cols?: number
        rows?: number
        prompt?: string
        paste?: string
      },
    ): Promise<{ ok: boolean; id?: string; message?: string }> => {
      try {
        return await agent.start(args)
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  // Request/response, unlike `write`: an ask sent to a session that has just
  // ended has to be refused back to the sender, which a fire-and-forget send
  // could not do.
  ipcMain.handle('agent:paste', (_e, msg: { id: string; text: string }) =>
    agent.paste(msg.id, msg.text),
  )

  // A spawn, so it can fail the same ways `start` can — and one more: the
  // listing may not yet know which conversation this session is.
  ipcMain.handle('agent:duplicate', (_e, id: string) => agent.duplicate(id))

  ipcMain.handle('agent-pty:kill', (_e, id: string) => agent.kill(id))
  ipcMain.handle('agent:attach', (_e, id: string) => agent.attach(id))
  ipcMain.handle('agent:sessions', (): SessionSummary[] => agent.sessions())

  ipcMain.on('agent-pty:write', (_e, msg: { id: string; data: string }) =>
    agent.write(msg.id, msg.data),
  )
  ipcMain.on('agent-pty:resize', (_e, size: { id: string; cols: number; rows: number }) =>
    agent.resize(size.id, size.cols, size.rows),
  )
  ipcMain.on('agent:focus', (_e, focus: FocusInput) => agent.setFocus(focus))
}
