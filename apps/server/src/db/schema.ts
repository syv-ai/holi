/**
 * Postgres schema — 1:1 with docs/prd/server-data.md. Server-internal:
 * @holi/shared types remain the client↔server seam (D14 relaxation,
 * Nicolai 2026-07-11). No conversation tables (D9).
 */
import { sql } from 'drizzle-orm'
import {
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

export const vaults = pgTable('vaults', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['personal', 'shared'] }).notNull(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id),
  theme: jsonb('theme'),
  ...timestamps,
})

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
