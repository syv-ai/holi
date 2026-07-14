/**
 * Postgres schema — 1:1 with docs/prd/server-data.md. Server-internal:
 * @holi/shared types remain the client↔server seam (D14 relaxation,
 * Nicolai 2026-07-11). No conversation tables (D9).
 */
import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import type { RelatedRef, Recurrence } from '@holi/shared'

const bytea = customType<{ data: Uint8Array }>({ dataType: () => 'bytea' })

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  googleSub: text('google_sub').notNull().unique(),
  email: text('email').notNull().unique(),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  ...timestamps,
})

/** Opaque session tokens, SHA-256-hashed at rest; 30-day sliding TTL (stub #2). */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
)

export const vaults = pgTable(
  'vaults',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['personal', 'shared'] }).notNull(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    theme: jsonb('theme'),
    ...timestamps,
  },
  (t) => [
    /** FR-7: at most one personal vault per user — provisioning race guard. */
    uniqueIndex('vaults_personal_owner_idx')
      .on(t.ownerId)
      .where(sql`${t.kind} = 'personal'`),
  ],
)

export const memberships = pgTable(
  'memberships',
  {
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => vaults.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'member'] }).notNull(),
    invitedBy: uuid('invited_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.vaultId, t.userId] }), index('memberships_user_idx').on(t.userId)],
)

export const docs = pgTable(
  'docs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => vaults.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    kind: text('kind', { enum: ['note', 'daily'] }).notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex('docs_vault_path_idx').on(t.vaultId, t.path)],
)

export const folders = pgTable(
  'folders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => vaults.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex('folders_vault_path_idx').on(t.vaultId, t.path)],
)

export const yjsDocs = pgTable('yjs_docs', {
  docId: uuid('doc_id')
    .primaryKey()
    .references(() => docs.id, { onDelete: 'cascade' }),
  state: bytea('state').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const yjsSnapshots = pgTable(
  'yjs_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    docId: uuid('doc_id')
      .notNull()
      .references(() => docs.id, { onDelete: 'cascade' }),
    state: bytea('state').notNull(),
    takenAt: timestamp('taken_at', { withTimezone: true }).notNull().defaultNow(),
    reason: text('reason'),
    label: text('label'),
    authorId: uuid('author_id').references(() => users.id),
  },
  (t) => [index('yjs_snapshots_timeline_idx').on(t.docId, t.takenAt.desc())],
)

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => vaults.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    status: text('status', { enum: ['todo', 'doing', 'done'] }).notNull().default('todo'),
    area: uuid('area').references(() => folders.id),
    due: date('due', { mode: 'string' }),
    priority: text('priority', { enum: ['low', 'medium', 'high'] }),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    reminder: text('reminder'),
    remindedAt: timestamp('reminded_at', { withTimezone: true }),
    recurrence: jsonb('recurrence').$type<Recurrence>(),
    related: jsonb('related').$type<RelatedRef[]>().notNull().default(sql`'[]'::jsonb`),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /** The task file's markdown body (prd/tasks.md §Task file projection). A
     * plain column, deliberately not a CRDT doc — a merged YAML frontmatter can
     * converge on invalid syntax with no writer to reject it. */
    description: text('description'),
    /** Optimistic-concurrency token, bumped on every mutation and round-tripped
     * through the file's frontmatter. An inbound file write carrying a stale
     * version is discarded and the file rewritten from the record. */
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t) => [index('tasks_board_idx').on(t.vaultId, t.status), index('tasks_area_idx').on(t.vaultId, t.area)],
)

export const reminders = pgTable(
  'reminders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .unique()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => vaults.id, { onDelete: 'cascade' }),
    fireAt: timestamp('fire_at', { withTimezone: true }).notNull(),
    fired: boolean('fired').notNull().default(false),
    computedFrom: text('computed_from'),
  },
  (t) => [index('reminders_pending_idx').on(t.fireAt).where(sql`not ${t.fired}`)],
)

export const perUserState = pgTable(
  'per_user_state',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => vaults.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: jsonb('value'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.vaultId, t.key] })],
)

export const linkIndex = pgTable(
  'link_index',
  {
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => vaults.id, { onDelete: 'cascade' }),
    srcDocId: uuid('src_doc_id')
      .notNull()
      .references(() => docs.id, { onDelete: 'cascade' }),
    targetPath: text('target_path').notNull(),
    occurrences: integer('occurrences').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.srcDocId, t.targetPath] }),
    index('link_index_target_idx').on(t.vaultId, t.targetPath),
  ],
)

/** A non-fatal git-sync incident surfaced in vault settings. */
export interface GitWarning {
  at: string // ISO timestamp
  kind:
    | 'binary-skipped'
    | 'unsafe-path'
    | 'local-file-skipped'
    | 'rename-target-occupied'
    | 'diverged-ingest'
    /** A committed task file whose frontmatter does not parse. It changes nothing
     * and is overwritten by the next export — but nobody is watching the remote
     * session's shell, so the warning is the only way the user learns of it. */
    | 'task-file-unparseable'
    /** A committed task file naming a folder or note that does not exist. Unlike the
     * desktop, we drop the ref and keep the rest: the commit already happened and
     * there is no writer left to correct a rejected file. */
    | 'task-ref-unresolved'
  path: string
  detail?: string
}

/** Per-user GitHub account link (auth-identity PRD §Linked accounts). */
export const githubConnections = pgTable('github_connections', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  githubUserId: bigint('github_user_id', { mode: 'number' }).notNull(),
  githubLogin: text('github_login').notNull(),
  /** OAuth token, AES-256-GCM sealed (src/crypto.ts). Used only at repo wiring/un-wiring time. */
  tokenCiphertext: bytea('token_ciphertext').notNull(),
  ...timestamps,
})

/** Git mirror wiring, one row per git-enabled vault (design spec 2026-07-13). */
export const vaultGit = pgTable('vault_git', {
  vaultId: uuid('vault_id')
    .primaryKey()
    .references(() => vaults.id, { onDelete: 'cascade' }),
  /** As the owner entered it (github.com HTTPS or SSH form). */
  repoUrl: text('repo_url').notNull(),
  /** What the mirror clone actually fetches/pushes (SSH in prod; a filesystem path in tests). */
  remote: text('remote').notNull(),
  defaultBranch: text('default_branch').notNull().default('main'),
  deployKeyCiphertext: bytea('deploy_key_ciphertext').notNull(),
  deployKeyPublic: text('deploy_key_public').notNull(),
  /** GitHub resource ids so disconnect can delete them (null when not API-managed, e.g. tests). */
  deployKeyId: bigint('deploy_key_id', { mode: 'number' }),
  webhookId: bigint('webhook_id', { mode: 'number' }),
  webhookSecretCiphertext: bytea('webhook_secret_ciphertext').notNull(),
  /** The sync base: last commit exported OR ingested — the diff base for both directions. */
  baseCommit: text('base_commit'),
  status: text('status', { enum: ['ok', 'paused', 'attention'] }).notNull().default('ok'),
  statusDetail: text('status_detail'),
  warnings: jsonb('warnings').$type<GitWarning[]>().notNull().default(sql`'[]'::jsonb`),
  enabledBy: uuid('enabled_by')
    .notNull()
    .references(() => users.id),
  lastExportAt: timestamp('last_export_at', { withTimezone: true }),
  lastIngestAt: timestamp('last_ingest_at', { withTimezone: true }),
  lastFetchAt: timestamp('last_fetch_at', { withTimezone: true }),
  ...timestamps,
})
