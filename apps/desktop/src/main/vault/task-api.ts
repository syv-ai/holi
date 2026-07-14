/** TaskProjectorApi over the main-process tRPC client — the file projection is
 * not a second write path: an inbound file write is *translated into* the same
 * mutations the board calls, so membership gating stays server-side and there is
 * exactly one place a task changes. */
import type { ServerClient } from '../server-client'
import type { TaskProjectorApi } from './task-projector'

export function makeTaskApi(client: ServerClient, vaultId: string): TaskProjectorApi {
  return {
    listTasks: () => client.tasks.list.query({ vaultId }),
    listFolders: async () => (await client.vaults.listDocs.query({ vaultId })).folders,
    getTask: async (taskId) =>
      await client.tasks.get.query({ vaultId, taskId }).catch(() => null), // 404 = deleted
    createTask: (input) => client.tasks.create.mutate({ vaultId, ...input }),
    updateTask: (taskId, patch, version) =>
      client.tasks.update.mutate({ vaultId, taskId, patch, version }),
    completeTask: (taskId, version) => client.tasks.complete.mutate({ vaultId, taskId, version }),
    deleteTask: async (taskId, version) => {
      await client.tasks.delete.mutate({ vaultId, taskId, version })
    },
    heartbeat: async (taskId) => {
      await client.tasks.heartbeat.mutate({ vaultId, taskId })
    },
  }
}
