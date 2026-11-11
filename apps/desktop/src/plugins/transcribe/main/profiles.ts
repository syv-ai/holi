/**
 * Meeting profiles: what a kind of meeting is about (platform, focus, what to
 * ignore, a glossary, the scribe's extra brief) and how it runs (language,
 * speech model, the models and MCP config its sessions get).
 *
 * They live on this machine, in `userData`, never in the vault: a profile says
 * which MCP config and models the scribe and build sessions start with, and a
 * file the agent can write is no approval of that (docs/features/holis.md's
 * approval convention). One store for every vault, like the Holis' approvals.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { createHash, randomBytes } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { CapabilityError, type JsonFileStore } from '../../../main/plugin-api'
import type { GlossaryEntry, MeetingProfile } from '../shared/meeting'

/** The speech model when a profile names none. */
export const DEFAULT_ASR_MODEL = 'syv-transcribe'

/**
 * What a machine starts with, and what an empty store reads as.
 *
 * @public exported for its test
 */
export const DEFAULT_PROFILE: MeetingProfile = {
  id: 'default',
  name: 'Default',
  platform: '',
  focus: '',
  ignore: '',
  glossary: [],
  instructions: '',
  language: 'da',
  shareMinutes: false,
  keepAudio: false,
}

export interface ProfilesFile {
  profiles: MeetingProfile[]
}

const MAX_TEXT = 4000
const MAX_NAME = 80
const MAX_GLOSSARY = 200

function bad(message: string): never {
  throw new CapabilityError('BAD_REQUEST', message)
}

function text(raw: Record<string, unknown>, key: string, max = MAX_TEXT): string {
  const value = raw[key] ?? ''
  if (typeof value !== 'string') bad(`${key} must be text`)
  if (value.length > max) bad(`${key} is over ${max} characters`)
  return value
}

function optionalText(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') bad(`${key} must be text`)
  if (value.length > MAX_NAME * 4) bad(`${key} is too long`)
  return value
}

function flag(raw: Record<string, unknown>, key: string): boolean {
  const value = raw[key] ?? false
  if (typeof value !== 'boolean') bad(`${key} must be true or false`)
  return value
}

function glossary(raw: unknown): GlossaryEntry[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) bad('glossary must be a list')
  if (raw.length > MAX_GLOSSARY) bad(`glossary has over ${MAX_GLOSSARY} terms`)
  return raw.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) bad('a glossary entry is {term, heardAs}')
    const e = entry as Record<string, unknown>
    const term = typeof e.term === 'string' ? e.term.trim() : ''
    if (term === '' || term.length > MAX_NAME) bad('a glossary term is 1 to 80 characters')
    const heardAs = e.heardAs ?? []
    if (!Array.isArray(heardAs) || heardAs.some((h) => typeof h !== 'string')) {
      bad(`heardAs of ${term} must be a list of text`)
    }
    return { term, heardAs: (heardAs as string[]).map((h) => h.trim()).filter((h) => h !== '') }
  })
}

/**
 * A profile as the UI sent it, checked: every field typed, the paths
 * absolute, the MCP config a `.json`. A missing id is a new profile.
 */
export function profileParam(raw: unknown): MeetingProfile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) bad('profile is required')
  const p = raw as Record<string, unknown>
  const name = text(p, 'name', MAX_NAME).trim()
  if (name === '') bad('name is required')
  const language = p.language ?? 'da'
  if (language !== 'da' && language !== 'en' && language !== 'auto') {
    bad('language is da, en or auto')
  }
  const repoPath = optionalText(p, 'repoPath')
  if (repoPath !== undefined && !isAbsolute(repoPath)) bad('repoPath must be an absolute path')
  const mcpConfig = optionalText(p, 'mcpConfig')
  if (mcpConfig !== undefined && (!isAbsolute(mcpConfig) || !mcpConfig.endsWith('.json'))) {
    bad('mcpConfig must be an absolute path to a .json file')
  }
  const id = optionalText(p, 'id')
  if (id !== undefined && !/^[a-z0-9-]{1,40}$/.test(id)) bad('id is lowercase letters and digits')
  const scribeModel = optionalText(p, 'scribeModel')
  const buildModel = optionalText(p, 'buildModel')
  const asrModel = optionalText(p, 'asrModel')
  return {
    id: id ?? randomBytes(4).toString('hex'),
    name,
    platform: text(p, 'platform'),
    ...(repoPath === undefined ? {} : { repoPath }),
    focus: text(p, 'focus'),
    ignore: text(p, 'ignore'),
    glossary: glossary(p.glossary),
    instructions: text(p, 'instructions'),
    language,
    ...(scribeModel === undefined ? {} : { scribeModel }),
    ...(buildModel === undefined ? {} : { buildModel }),
    ...(mcpConfig === undefined ? {} : { mcpConfig }),
    shareMinutes: flag(p, 'shareMinutes'),
    keepAudio: flag(p, 'keepAudio'),
    ...(asrModel === undefined ? {} : { asrModel }),
    ...(p.roomDiarize === undefined ? {} : { roomDiarize: flag(p, 'roomDiarize') }),
  }
}

/** The file on disk, read leniently: a profile a hand edit broke is dropped,
 *  not the whole file, and an empty file is the default profile. */
export function parseProfilesFile(raw: unknown): ProfilesFile {
  const list =
    typeof raw === 'object' && raw !== null && Array.isArray((raw as ProfilesFile).profiles)
      ? (raw as ProfilesFile).profiles
      : []
  // One written by hand without an id gets one from its name, the same on
  // every read, so it can be found and saved by it.
  const named = (p: unknown): unknown =>
    typeof p === 'object' && p !== null && !('id' in p) && 'name' in p && typeof p.name === 'string'
      ? { ...p, id: createHash('sha256').update(p.name).digest('hex').slice(0, 8) }
      : p
  const profiles = list.flatMap((p) => {
    try {
      return [profileParam(named(p))]
    } catch {
      return []
    }
  })
  return { profiles: profiles.length === 0 ? [DEFAULT_PROFILE] : profiles }
}

export interface Profiles {
  list(): Promise<MeetingProfile[]>
  get(id: string): Promise<MeetingProfile>
  save(profile: MeetingProfile): Promise<MeetingProfile>
  delete(id: string): Promise<void>
}

export function createProfiles(store: JsonFileStore<ProfilesFile>): Profiles {
  return {
    list: async () => (await store.read()).profiles,
    async get(id) {
      const found = (await store.read()).profiles.find((p) => p.id === id)
      if (found === undefined) throw new CapabilityError('NOT_FOUND', `no meeting profile ${id}`)
      return found
    },
    async save(profile) {
      await store.update(({ profiles }) => {
        const at = profiles.findIndex((p) => p.id === profile.id)
        return {
          profiles:
            at < 0 ? [...profiles, profile] : profiles.map((p, i) => (i === at ? profile : p)),
        }
      })
      return profile
    },
    async delete(id) {
      await store.update(({ profiles }) => {
        if (!profiles.some((p) => p.id === id)) {
          throw new CapabilityError('NOT_FOUND', `no meeting profile ${id}`)
        }
        return { profiles: profiles.filter((p) => p.id !== id) }
      })
    },
  }
}
