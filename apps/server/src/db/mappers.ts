import type { DocMeta, Folder, Task, Vault } from '@holi/shared'
import type { docs, folders, tasks, vaults } from './schema'

export function toVault(row: typeof vaults.$inferSelect): Vault {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    ownerId: row.ownerId,
    theme: row.theme ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export function toDocMeta(row: typeof docs.$inferSelect): DocMeta {
  return {
    id: row.id,
    vaultId: row.vaultId,
    path: row.path,
    kind: row.kind,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export function toFolder(row: typeof folders.$inferSelect): Folder {
  return { id: row.id, vaultId: row.vaultId, path: row.path }
}

export function toTask(row: typeof tasks.$inferSelect): Task {
  return {
    id: row.id,
    vaultId: row.vaultId,
    title: row.title,
    status: row.status,
    area: row.area ?? undefined,
    due: row.due ?? undefined,
    priority: row.priority ?? undefined,
    tags: row.tags,
    reminder: row.reminder ?? undefined,
    recurrence: row.recurrence ?? undefined,
    related: row.related,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}
