/**
 * Link files as a path claim (docs/features/links.md): New Link in the files
 * list and a web address dropped on it from a browser, the card on their
 * rows in the tree and at the top of their tab, and Open in Browser in their
 * row menu.
 */
import { atom, useAtomValue } from 'jotai'
import { LinkIcon } from 'lucide-react'
import { snapshotAtom, trpc, openExternal } from '@/plugin-api'
import type { PathClaim } from '@/plugin-api/types'
import { isLinkFilePath, linkTitle, parseLinkFile, snapshotLinks } from '../shared/link-file'
import { isWebUrl } from '../shared/preview'
import { PreviewCard } from './preview-card'
import { linksCap } from './links-cap'

/** The vault's link files, by path. */
const linksAtom = atom(
  (get) => new Map(snapshotLinks(get(snapshotAtom)).items.map((l) => [l.path, l])),
)

/** A saved link's page, or nothing for a file that names none. */
function LinkCard({ path, floating }: { path: string; floating: boolean }) {
  const link = useAtomValue(linksAtom).get(path)
  if (link === undefined) return null
  return <PreviewCard url={link.url} title={linkTitle(path)} floating={floating} />
}

export const LINK_PATH_CLAIM: PathClaim = {
  match: isLinkFilePath,
  create: {
    id: 'link',
    label: 'New Link',
    icon: LinkIcon,
    placeholder: 'Paste a web address',
    asksName: true,
    // A link dragged in from a browser is saved where it lands.
    fromUrl: true,
    run: async ({ remote, parent, name }) => {
      const url = name.trim()
      if (!isWebUrl(url)) throw new Error('That isn’t a web address: it starts with https://.')
      return (await linksCap.create(remote, { url, folder: parent })).path
    },
  },
  hover: ({ path }) => <LinkCard path={path} floating />,
  banner: ({ path }) => <LinkCard path={path} floating={false} />,
  rowMenu: [
    {
      label: 'Open in Browser',
      when: (path, snapshot) => snapshotLinks(snapshot).items.some((l) => l.path === path),
      // Read when chosen, so it opens what the file says now.
      run: ({ remote, path }) =>
        void trpc.notes.read.query({ remote, path }).then((text) => {
          const { url } = parseLinkFile(text, path)
          openExternal(url)
        }),
    },
  ],
}
