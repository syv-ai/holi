/**
 * The vault's project: the one ongoing piece of work a vault is
 * (docs/features/planning.md).
 *
 * `.holi/project.md`, committed: YAML frontmatter for the facts and a markdown
 * body that is the project's About. The planning view's Overview edits it, and
 * anyone, or the agent, can edit it as a file.
 *
 * ```markdown
 * ---
 * name: Website relaunch
 * status: active
 * lead: ada
 * start: 2026-09-01
 * due: 2026-12-15
 * milestones:
 *   - name: Design signed off
 *     date: 2026-10-01
 * ---
 *
 * What the project is for, in prose.
 * ```
 *
 * Every key is optional and the file itself is too: without one, a vault is a
 * project with no name of its own (the view shows the repo's), status
 * `planning`, and nothing else. Like a task file, unknown keys are carried in
 * `extra` and written back. Unlike one, **nothing here throws**: a value that
 * is wrong is dropped with a warning, because there is only one project file
 * and a typo in it must not take the Overview with it.
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { parseStamp } from './dates'
import { FrontmatterError, splitFrontmatter } from './frontmatter'
import { cleanLogins } from './task-file'

export const PROJECT_FILE = '.holi/project.md'

export type ProjectStatus = 'planning' | 'active' | 'at-risk' | 'on-hold' | 'complete'

/** In the order a project usually moves through them, with their names. */
export const PROJECT_STATUSES: readonly { id: ProjectStatus; name: string }[] = [
  { id: 'planning', name: 'Planning' },
  { id: 'active', name: 'Active' },
  { id: 'at-risk', name: 'At risk' },
  { id: 'on-hold', name: 'On hold' },
  { id: 'complete', name: 'Complete' },
]

export interface Milestone {
  name: string
  /** `YYYY-MM-DD`. */
  date: string
}

export interface Project {
  /** Absent: the view names the project after the vault. */
  name?: string
  status: ProjectStatus
  /** A GitHub login, like a task's assignees. */
  lead?: string
  /** Stamps, like a task's `start` and `due`. */
  start?: string
  due?: string
  /** In date order. */
  milestones: Milestone[]
  /** The markdown body. */
  about: string
  /** Keys this version does not know, written back as they were. */
  extra?: Record<string, unknown>
}

export const EMPTY_PROJECT: Project = { status: 'planning', milestones: [], about: '' }

const KNOWN = new Set(['name', 'status', 'lead', 'start', 'due', 'milestones'])
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const isStatus = (v: unknown): v is ProjectStatus => PROJECT_STATUSES.some((s) => s.id === v)

export interface ParsedProject {
  project: Project
  warnings: string[]
}

/** The project `text` (the file, or null when there is none) describes. */
export function parseProjectFile(text: string | null): ParsedProject {
  if (text === null) return { project: { ...EMPTY_PROJECT, milestones: [] }, warnings: [] }
  const warnings: string[] = []

  let split: { yaml: string | null; body: string }
  try {
    split = splitFrontmatter(text)
  } catch (err) {
    if (!(err instanceof FrontmatterError)) throw err
    return {
      project: { ...EMPTY_PROJECT, milestones: [], about: text.trim() },
      warnings: [`${PROJECT_FILE}: ${err.message}`],
    }
  }

  let front: Record<string, unknown> = {}
  if (split.yaml !== null) {
    try {
      const raw: unknown = parseYaml(split.yaml)
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        front = raw as Record<string, unknown>
      } else if (raw !== null && raw !== undefined) {
        warnings.push(`${PROJECT_FILE}: frontmatter must be a YAML map`)
      }
    } catch (err) {
      warnings.push(`${PROJECT_FILE}: frontmatter is not valid YAML: ${(err as Error).message}`)
    }
  }

  const project: Project = { status: 'planning', milestones: [], about: split.body }
  const drop = (key: string) => warnings.push(`${PROJECT_FILE}: ${key} was not understood`)

  if (typeof front.name === 'string' && front.name.trim() !== '') project.name = front.name.trim()
  else if (front.name != null) drop('name')

  if (isStatus(front.status)) project.status = front.status
  else if (front.status != null) drop('status')

  if (typeof front.lead === 'string') {
    const [lead] = cleanLogins([front.lead])
    if (lead !== undefined) project.lead = lead
  } else if (front.lead != null) drop('lead')

  for (const key of ['start', 'due'] as const) {
    const value = front[key]
    if (typeof value === 'string' && parseStamp(value) !== null) project[key] = value
    else if (value != null) drop(key)
  }

  if (Array.isArray(front.milestones)) {
    for (const entry of front.milestones as unknown[]) {
      const m = entry as Record<string, unknown> | null
      // YAML reads an unquoted date as a string here (the `yaml` package's
      // core schema), so a date is a string or it is not a date.
      if (
        m !== null &&
        typeof m === 'object' &&
        typeof m.name === 'string' &&
        m.name.trim() !== '' &&
        typeof m.date === 'string' &&
        DATE_RE.test(m.date)
      ) {
        project.milestones.push({ name: m.name.trim(), date: m.date })
      } else drop('a milestone')
    }
    project.milestones.sort((a, b) => a.date.localeCompare(b.date))
  } else if (front.milestones != null) drop('milestones')

  const extra = Object.fromEntries(Object.entries(front).filter(([k]) => !KNOWN.has(k)))
  if (Object.keys(extra).length > 0) project.extra = extra

  return { project, warnings }
}

/** The file for `project`, keys in a fixed order so an unchanged project
 *  writes the same bytes. */
export function serializeProjectFile(project: Project): string {
  const front: Record<string, unknown> = {}
  if (project.name !== undefined) front.name = project.name
  front.status = project.status
  if (project.lead !== undefined) front.lead = project.lead
  if (project.start !== undefined) front.start = project.start
  if (project.due !== undefined) front.due = project.due
  if (project.milestones.length > 0) {
    front.milestones = project.milestones.map((m) => ({ name: m.name, date: m.date }))
  }
  for (const [key, value] of Object.entries(project.extra ?? {})) front[key] = value
  const body = project.about.trim()
  const yaml = stringifyYaml(front)
  return body === '' ? `---\n${yaml}---\n` : `---\n${yaml}---\n\n${body}\n`
}
