/**
 * Link files as a path claim (docs/features/links.md): New Link in the
 * explorer and a web address dropped on it, the card on their rows in the
 * tree, how a wiki-link to one is drawn (⌘-click goes to the page), what `@`
 * offers of them, their frontmatter rows, the card at the top of their tab,
 * Open in Browser in their row menu, and how the tree and the tabs mark them.
 */
import { atom, useAtomValue } from 'jotai'
import { Link as LinkGlyph } from 'lucide'
import { Link } from 'lucide-react'
import { type LinkChip, type PathClaim, type PathMark, snapshotAtom, trpc } from '@/plugin-api'
import { Icon } from '@/primitives'
import {
  isLinkFilePath,
  LINK_FIELDS,
  linkTitle,
  parseLinkFile,
  snapshotLinks,
} from '../shared/link-file'
import { hostOf, isWebUrl } from '../shared/preview'
import { linkHeader } from './header'
import { PreviewCard } from './PreviewCard'
import { UrlField } from './UrlField'
import { linksCap } from './use-preview'

/** The vault's link files, by path. */
const linksAtom = atom(
  (get) => new Map(snapshotLinks(get(snapshotAtom)).items.map((l) => [l.path, l])),
)

/** A saved link's row in the tree: its page's card, under its own name. */
function LinkRowCard({ path }: { path: string }): React.JSX.Element | null {
  const link = useAtomValue(linksAtom).get(path)
  return link === undefined ? null : <PreviewCard url={link.url} title={linkTitle(path)} floating />
}

export const LINK_PATH_CLAIM: PathClaim = {
  match: isLinkFilePath,
  create: {
    id: 'link',
    label: 'New Link',
    icon: Link,
    placeholder: 'paste a web address',
    // A link dragged in from a browser is saved where it lands.
    fromUrl: true,
    run: async ({ remote, parent, name }) => {
      const url = name.trim()
      if (!isWebUrl(url)) throw new Error("That isn't a web address")
      return (await linksCap.create(remote, { url, folder: parent })).path
    },
  },
  hover: LinkRowCard,
  rowMenu: [
    {
      label: 'Open in Browser',
      when: (path, snapshot) => snapshotLinks(snapshot).items.some((l) => l.path === path),
      // Read when chosen, so it opens what the file says now.
      run: ({ remote, path }) =>
        void trpc.notes.read.query({ remote, path }).then((text) => {
          const { url } = parseLinkFile(text, path)
          void window.holi.openExternal(url)
        }),
    },
  ],
  graph: { label: 'Link', fill: 'fill-brand' },
  editor: {
    chips: (snapshot) =>
      new Map(
        snapshotLinks(snapshot).items.map((l): [string, LinkChip] => [
          l.path,
          { title: linkTitle(l.path), meta: hostOf(l.url), url: l.url },
        ]),
      ),
    mentions: (snapshot) => ({
      name: 'Links',
      items: snapshotLinks(snapshot).items.map((l) => ({
        path: l.path,
        label: linkTitle(l.path),
        glyph: LinkGlyph,
        meta: hostOf(l.url),
      })),
    }),
    extensions: (path) => linkHeader(path),
  },
  // The address in full, wrapping, where a one-line field would cut it off.
  frontmatter: { fields: LINK_FIELDS, controls: { url: UrlField }, alwaysOpen: true },
}

/** A file type's colour, as the tree gives every other file its own. Drawn a
 *  little under the icon size: the chain runs corner to corner, so at full
 *  size it reads larger than the file shapes around it. */
const LINK_MARK: PathMark = {
  glyph: <Icon icon={Link} size="sm" className="scale-[0.86] text-file-sky" />,
}

/** Every link file's glyph, in the tree and the tabs. */
export const linkMarksAtom = atom(
  (get): ReadonlyMap<string, PathMark> =>
    new Map([...get(linksAtom).keys()].map((path) => [path, LINK_MARK])),
)
