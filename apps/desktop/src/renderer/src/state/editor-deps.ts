/**
 * What every notes editor reads from the vault (`EditorDeps`): the notes and
 * claimed files a link can reach, how a claim draws a link to its files, what
 * the `@` menu offers, the slash commands, the file's claim's own layer, and
 * the Ask seam. One hook, for the note in a pane and for text not yet in a
 * file (a task's description), so the two cannot wire it differently.
 *
 * Every seam is a closure over a ref, read when the editor needs it: a
 * snapshot arriving mid-edit must not rebuild the view and drop the caret.
 */
import { useAtomValue, useStore } from 'jotai'
import { useMemo, useRef } from 'react'
import type { EditorDeps } from '@/editor/extensions'
import type { LinkNav } from '@/editor/links'
import type { LinkChip } from '@/editor/livePreview'
import type { MentionData } from '@/editor/mentions'
import { trpc } from '@/lib/trpc'
import { NO_AGENT, useAskAgentSeam } from './agent-service'
import { claimsAtom, runningPluginsAtom, slashCommandsAtom } from './plugins'
import { activeRemoteAtom, snapshotAtom } from './vaults'

/** The seams for the editor of `notePath` ('' for text with no file yet).
 *  `nav.openNote` is called only for a path the vault has, a note or a
 *  claimed file: a link to a missing one does nothing rather than invent a
 *  file. Rebuild the view when `askAgent` comes or goes; nothing else here
 *  asks for it. */
export function useEditorDeps(
  notePath: string,
  nav: Omit<LinkNav, 'openExternal'>,
): Omit<EditorDeps, 'readOnly' | 'frontmatter'> {
  const snapshot = useAtomValue(snapshotAtom)
  const remote = useAtomValue(activeRemoteAtom)
  const claims = useAtomValue(claimsAtom)
  const running = useAtomValue(runningPluginsAtom)
  const store = useStore()

  const vault = useMemo(() => {
    const docs = new Set(snapshot.docs.map((d) => d.path))
    const linkable = new Set(docs)
    for (const set of Object.values(snapshot.claimed)) {
      for (const item of set.items) linkable.add(item.path)
    }
    const chips = claims.flatMap((c) => (c.editor?.chips ? [c.editor.chips(snapshot)] : []))
    const mentions: MentionData = {
      notes: snapshot.docs.map((d) => ({
        path: d.path,
        ...(snapshot.icons[d.path] === undefined ? {} : { icon: snapshot.icons[d.path] }),
      })),
      groups: claims.flatMap((c) => (c.editor?.mentions ? [c.editor.mentions(snapshot)] : [])),
    }
    const chip = (path: string): LinkChip | null => {
      for (const byPath of chips) {
        const found = byPath.get(path)
        if (found !== undefined) return found
      }
      return null
    }
    return { docs, linkable, chip, mentions }
  }, [snapshot, claims])
  const live = useRef(vault)
  live.current = vault
  const navRef = useRef(nav)
  navRef.current = nav

  const askAgent = useAskAgentSeam()
  const askAgentRef = useRef(askAgent)
  askAgentRef.current = askAgent
  const hasAgent = askAgent !== null

  // The file's own claim: what it adds to the editor, and whether its
  // properties bar is always open. New only when the claim comes or goes, so
  // an open view swaps its claim layer (`reconfigureClaimLayer`) then and
  // never on a mere re-render.
  const ownEditor = claims.find((c) => c.editor?.extensions !== undefined && c.match(notePath))
  const ownFrontmatter = claims.find((c) => c.frontmatter !== undefined && c.match(notePath))
  const claimExtensions = useMemo(
    () => (notePath === '' ? undefined : ownEditor?.editor?.extensions?.(notePath)),
    [notePath, ownEditor],
  )
  const alwaysOpen = notePath !== '' && ownFrontmatter?.frontmatter?.alwaysOpen === true
  // What running plugins add to every note: new only when one starts or stops.
  const pluginExtensions = useMemo(
    () => running.flatMap((p) => (p.editorExtensions === undefined ? [] : [p.editorExtensions])),
    [running],
  )

  return useMemo(
    (): Omit<EditorDeps, 'readOnly' | 'frontmatter'> => ({
      docExists: (p) => live.current.docs.has(p),
      linkChip: (p) => live.current.chip(p),
      readNote: (p) =>
        remote === null
          ? Promise.resolve(null)
          : trpc.notes.read.query({ remote, path: p }).then(
              (text) => text,
              () => null,
            ),
      mentionData: () => live.current.mentions,
      nav: () => ({
        ...navRef.current,
        openNote: (target) => live.current.linkable.has(target) && navRef.current.openNote(target),
        openExternal: (url) => void window.holi.openExternal(url),
      }),
      slashCommands: () => store.get(slashCommandsAtom),
      ...(hasAgent
        ? {
            askAgent: {
              targets: () => askAgentRef.current?.targets() ?? { sessions: [], initial: 'new' },
              onAsk: (prompt, target) =>
                askAgentRef.current?.onAsk(prompt, target) ?? Promise.resolve(NO_AGENT),
            },
          }
        : {}),
      notePath,
      ...(alwaysOpen ? { frontmatterAlwaysOpen: true } : {}),
      ...(claimExtensions === undefined ? {} : { claimExtensions }),
      pluginExtensions,
    }),
    [notePath, remote, hasAgent, alwaysOpen, claimExtensions, pluginExtensions, store],
  )
}
