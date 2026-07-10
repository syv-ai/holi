export type VaultKind = 'personal' | 'shared'
export type Role = 'owner' | 'member'
export type TaskStatus = 'todo' | 'doing' | 'done'
export type Priority = 'low' | 'medium' | 'high'
export type DocKind = 'note' | 'daily'
export type SyncStatus = 'synced' | 'offline' | 'syncing'

export interface Vault {
  id: string
  name: string
  kind: VaultKind
  ownerId: string
  theme?: unknown
  createdAt: string
  updatedAt: string
}

export interface Membership {
  vaultId: string
  userId: string
  role: Role
}

export interface DocMeta {
  id: string
  vaultId: string
  path: string
  kind: DocKind
  createdAt: string
  updatedAt: string
}

export interface Folder {
  id: string
  vaultId: string
  path: string
}

export type RelatedRefKind = 'note' | 'task' | 'email' | 'event'

/** Machine references use stable IDs, never paths (D27). */
export interface RelatedRef {
  kind: RelatedRefKind
  id: string
}

export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly'
export type RecurrenceWeekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'

export interface Recurrence {
  frequency: RecurrenceFrequency
  interval: number
  weekdays?: RecurrenceWeekday[]
  /** YYYY-MM-DD — occurrences after this date stop the roll-forward. */
  endDate?: string
}

export interface Task {
  id: string
  vaultId: string
  title: string
  status: TaskStatus
  /** Stable folder ID driving swim lanes (D4a, D27). */
  area?: string
  /** YYYY-MM-DD */
  due?: string
  priority?: Priority
  tags: string[]
  /** Nd | Nw | YYYY-MM-DDTHH:MM (D19) */
  reminder?: string
  recurrence?: Recurrence
  related: RelatedRef[]
  createdAt: string
  updatedAt: string
}

export interface HealthStatus {
  ok: boolean
  service: string
  time: string
}
