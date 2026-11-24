import {
  isInIgnoredDir,
  isLocalOnlyPath,
  isRemote,
  isSecretPath,
  shownPathOrNull,
  vaultRelPath,
} from '@holi/shared/mobile-path-safety'

export interface MetadataKeyValue {
  get(key: string): string | undefined
  set(key: string, value: string): void
}

export interface NoteMetadata {
  recent(path: string): void
  setFavourite(path: string, favourite: boolean): void
  move(from: string, to: string): void
  remove(path: string): void
  visible(paths: readonly string[]): { recents: string[]; favourites: string[] }
}

type Data = { recents: string[]; favourites: string[] }
const LIMIT = 50

function notePath(raw: string): string {
  const path = vaultRelPath(raw)
  if (
    !shownPathOrNull(path) ||
    isLocalOnlyPath(path) ||
    isSecretPath(path) ||
    isInIgnoredDir(path) ||
    path.split('/').some((part) => part.startsWith('.holi-storage-')) ||
    !path.toLowerCase().endsWith('.md')
  ) {
    throw new Error('Path is not a visible Markdown note')
  }
  return path
}

function parse(raw: string | undefined): Data {
  if (raw === undefined) return { recents: [], favourites: [] }
  const value: unknown = JSON.parse(raw)
  if (
    !value ||
    typeof value !== 'object' ||
    !Array.isArray((value as Data).recents) ||
    !Array.isArray((value as Data).favourites)
  ) {
    throw new Error('Malformed note metadata')
  }
  const valid = (items: unknown[]) =>
    items.map((item) => {
      if (typeof item !== 'string') throw new Error('Malformed note metadata')
      return notePath(item)
    })
  return {
    recents: [...new Set(valid((value as Data).recents))].slice(0, LIMIT),
    favourites: [...new Set(valid((value as Data).favourites))],
  }
}

export function createNoteMetadata(adapter: MetadataKeyValue, remote: string): NoteMetadata {
  if (!isRemote(remote)) throw new Error('Invalid vault identity')
  const key = `holi.note-metadata:${remote}`
  let data = parse(adapter.get(key))
  const update = (next: Data) => {
    adapter.set(key, JSON.stringify(next))
    data = next
  }
  return {
    recent(raw) {
      const path = notePath(raw)
      update({
        ...data,
        recents: [path, ...data.recents.filter((item) => item !== path)].slice(0, LIMIT),
      })
    },
    setFavourite(raw, favourite) {
      const path = notePath(raw)
      update({
        ...data,
        favourites: favourite
          ? [...new Set([...data.favourites, path])]
          : data.favourites.filter((item) => item !== path),
      })
    },
    move(fromRaw, toRaw) {
      const from = notePath(fromRaw),
        to = notePath(toRaw)
      update({
        recents: [...new Set(data.recents.map((item) => (item === from ? to : item)))],
        favourites: [...new Set(data.favourites.map((item) => (item === from ? to : item)))],
      })
    },
    remove(raw) {
      const path = notePath(raw)
      update({
        recents: data.recents.filter((item) => item !== path),
        favourites: data.favourites.filter((item) => item !== path),
      })
    },
    visible(paths) {
      const visible = new Set(
        paths.flatMap((path) => {
          try {
            return [notePath(path)]
          } catch {
            return []
          }
        }),
      )
      return {
        recents: data.recents.filter((path) => visible.has(path)),
        favourites: data.favourites.filter((path) => visible.has(path)),
      }
    },
  }
}
