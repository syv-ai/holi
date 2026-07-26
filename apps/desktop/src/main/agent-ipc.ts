/**
 * The agent's IPC seam — distinct from the tRPC seam in `ipc.ts`. The session is
 * a live byte stream: PTY data/exit and status are pushed out to the renderer by
 * the manager (`agent-pty:data`, `agent-pty:exit`, `agent:status`); keystrokes,
 * resize and focus are pushed in; start/kill/attach/status are request/response.
 * Channel names mirror prd/agent.md's wire shape.
 */
import { ipcMain } from 'electron'
import type { AgentManager, AgentStatus } from './agent/agent-manager'
import type { FocusInput } from './agent/context-snapshot'

export function registerAgentIpc(deps: { agent: AgentManager }): void {
  const { agent } = deps

  // The manager throws on a bad start (no CLI, vault not active). The drawer
  // wants a message it can print in red, not an IPC rejection — so tag it.
  ipcMain.handle(
    'agent-pty:start',
    async (
      _e,
      args: { vaultId: string; resume?: boolean },
    ): Promise<{ ok: boolean; message?: string }> => {
      try {
        return await agent.start(args)
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  ipcMain.handle('agent-pty:kill', () => agent.kill())
  ipcMain.handle('agent:attach', () => agent.attach())
  ipcMain.handle('agent:status', (): AgentStatus => agent.status())

  ipcMain.on('agent-pty:write', (_e, data: string) => agent.write(data))
  ipcMain.on('agent-pty:resize', (_e, size: { cols: number; rows: number }) =>
    agent.resize(size.cols, size.rows),
  )
  ipcMain.on('agent:focus', (_e, focus: FocusInput) => agent.setFocus(focus))
}
