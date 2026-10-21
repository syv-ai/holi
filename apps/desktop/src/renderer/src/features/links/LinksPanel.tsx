/**
 * The focused note's links, as a right-hand drawer beside the editor
 * (`docs/features/wiki-links.md`): what it links to, and every line elsewhere
 * that links to it. Each opens its note the way a chip does.
 *
 * A link to a note that does not exist is listed, dimmed, and opens nothing,
 * like the chip it is in the editor. The lists are asked of main again a moment
 * after the vault changes on disk, so an edit shows once autosave has written
 * it.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { Waypoints } from 'lucide-react'
import { DrawerShell, DrawerTitle } from '@/composites'
import { pathLabel } from '@/composites/file-icons'
import { Button } from '@/primitives'
import { trpc } from '@/lib/trpc'
import { useVaultScan } from '@/lib/use-vault-scan'
import { historyOpenAtom, historyTargetPathAtom } from '@/state/history'
import { linkFingerprintAtom, linksOpenAtom, type NoteLinks } from '@/state/links'
import { openPathAtom, openSurfaceAtom } from '@/state/surfaces'
import { activeRemoteAtom } from '@/state/vaults'

/** The folder a path sits in, or nothing at the vault root. */
const folderOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')))

const ROW =
  'h-auto w-full min-w-0 flex-col items-start justify-start gap-0.5 rounded-md px-3 py-1.5 text-left font-normal'

export function LinksPanel() {
  const open = useAtomValue(linksOpenAtom)
  const historyOpen = useAtomValue(historyOpenAtom)
  const path = useAtomValue(historyTargetPathAtom)
  const remote = useAtomValue(activeRemoteAtom)
  const fingerprint = useAtomValue(linkFingerprintAtom)
  const openPath = useSetAtom(openPathAtom)
  const openSurface = useSetAtom(openSurfaceAtom)

  // Per note, and again once the vault has been still a moment after a change:
  // a link written anywhere lands here once it is on disk. Not while closed.
  const scan = useVaultScan(
    open && path !== null && remote !== null ? `${remote}\n${path}` : null,
    fingerprint,
    () => trpc.notes.links.query({ remote: remote!, path: path! }),
  )
  const shown = scan?.ok ? scan.data : null
  const sources = shown === null ? [] : groupBySource(shown.backlinks)

  const heading = (title: string, count: number) => (
    <h3 className="px-3 pt-3 pb-1 text-[11px] font-medium text-muted-foreground">
      {title}
      <span className="ml-1.5 tabular-nums">{count}</span>
    </h3>
  )

  return (
    <DrawerShell
      id="links"
      side="right"
      open={open && !historyOpen && path !== null}
      label="Links"
      header={<DrawerTitle title="Links" subtitle={path} />}
      actions={[{ icon: Waypoints, label: 'Open the graph', onSelect: () => openSurface('graph') }]}
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-2 pt-0" data-links-panel="">
        {scan === null ? (
          <p className="px-3 py-3 text-[13px] text-muted-foreground">Loading…</p>
        ) : shown === null ? (
          <p className="px-3 py-3 text-[13px] text-muted-foreground" data-links-error="">
            Couldn&rsquo;t read this note&rsquo;s links.
          </p>
        ) : (
          <>
            <section data-links-section="outgoing">
              {heading('Links to', shown.outgoing.length)}
              {shown.outgoing.length === 0 && (
                <p className="px-3 py-1.5 text-[13px] text-muted-foreground">
                  This note links to no other note.
                </p>
              )}
              {shown.outgoing.map((link) =>
                link.exists ? (
                  <Button
                    key={link.target}
                    variant="ghost"
                    data-link-target={link.target}
                    onClick={() => openPath(link.target, 'preview')}
                    className={ROW}
                  >
                    <span className="block w-full truncate text-[13px] text-foreground">
                      {link.label ?? pathLabel(link.target)}
                    </span>
                    {folderOf(link.target) !== '' && (
                      <span className="block w-full truncate text-[11px] text-muted-foreground">
                        {folderOf(link.target)}
                      </span>
                    )}
                  </Button>
                ) : (
                  <div
                    key={link.target}
                    data-link-target={link.target}
                    data-link-missing=""
                    className="flex min-w-0 flex-col gap-0.5 px-3 py-1.5"
                  >
                    <span className="block w-full truncate text-[13px] text-muted-foreground">
                      {link.label ?? pathLabel(link.target)}
                    </span>
                    <span className="block w-full truncate text-[11px] text-muted-foreground">
                      {link.target} doesn&rsquo;t exist yet
                    </span>
                  </div>
                ),
              )}
            </section>

            <section data-links-section="backlinks">
              {heading('Linked from', sources.length)}
              {sources.length === 0 && (
                <p className="px-3 py-1.5 text-[13px] text-muted-foreground">
                  No other note links here.
                </p>
              )}
              {sources.map(({ source, lines }) => (
                <Button
                  key={source}
                  variant="ghost"
                  data-backlink-source={source}
                  onClick={() => openPath(source, 'preview')}
                  className={ROW}
                >
                  <span className="block w-full truncate text-[13px] text-foreground">
                    {pathLabel(source)}
                  </span>
                  {lines.map((l) => (
                    <span
                      key={l.line}
                      className="line-clamp-2 block w-full text-[11px] whitespace-normal text-muted-foreground"
                    >
                      {l.snippet}
                    </span>
                  ))}
                </Button>
              ))}
            </section>
          </>
        )}
      </div>
    </DrawerShell>
  )
}

/** Backlinks arrive sorted by path then line; one entry per linking file. */
function groupBySource(
  backlinks: NoteLinks['backlinks'],
): { source: string; lines: NoteLinks['backlinks'] }[] {
  const out: { source: string; lines: NoteLinks['backlinks'] }[] = []
  for (const b of backlinks) {
    const last = out.at(-1)
    if (last?.source === b.path) last.lines.push(b)
    else out.push({ source: b.path, lines: [b] })
  }
  return out
}
