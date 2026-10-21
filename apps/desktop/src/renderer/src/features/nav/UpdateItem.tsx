/**
 * The nav menu's update item (docs/features/updates.md): absent until there is
 * something to do about updating Holi or what it ships to the open vault.
 *
 * - **The app.** An update downloads on its own, so the item appears when one
 *   is ready to install, in the brand colour, or when its download failed, in
 *   amber. Checking and downloading stay quiet; Settings → Updates shows them.
 * - **The vault's skills.** Skills and hooks are the vault's once written, so a
 *   release's newer ones reach it only through Update skills. When this
 *   release would bring the open vault some, the item offers it, uncoloured,
 *   until it is run or put off. Nothing is written until it is run. A vault
 *   that asks for its skills to update on open is not offered them: the item
 *   instead says what the update changed, until it is seen.
 *
 * It persists until acted on, rather than toasting once: missing a transient
 * notice would mean missing the update.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { Check, CircleArrowUp, Clock, RotateCw, Sparkles } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button, Icon, type MorphingMenuItem } from '@/primitives'
import { agentSourceAtom } from '@/state/plugins'
import {
  dismissSkillsNoticeAtom,
  dismissSkillsOfferAtom,
  mergeSkillsConflictsAtom,
  openSkillsStatusAtom,
  skillsNoticeAtom,
  skillsOfferAtom,
  updateSkillsAtom,
} from '@/state/skills'
import type { SkillsUpdated } from '../../../../main/capabilities/vault-caps'
import {
  installUpdateAtom,
  retryUpdateDownloadAtom,
  updateHeadline,
  updateStatusAtom,
} from '@/state/updates'

const ROW = 'h-auto min-h-8 w-full justify-start gap-2 rounded-xl px-2.5 py-1.5 text-sm font-normal'
/** How many of the pending files the panel names before it counts the rest. */
const NAMED = 4

function AppUpdate({ close }: { close: () => void }): React.JSX.Element {
  const status = useAtomValue(updateStatusAtom)
  const install = useSetAtom(installUpdateAtom)
  const retry = useSetAtom(retryUpdateDownloadAtom)
  const [restarting, setRestarting] = useState(false)
  const ready = status?.state === 'ready'

  return (
    <>
      <p data-morph-row="" className="px-2.5 py-1.5 text-sm">
        {updateHeadline(status)}
      </p>
      {ready ? (
        <>
          <p data-morph-row="" className="px-2.5 pb-1 text-xs text-muted-foreground">
            Holi saves and syncs your notes first, and asks before stopping a busy agent session.
          </p>
          <Button
            variant="ghost"
            data-morph-row=""
            className={ROW}
            disabled={restarting}
            onClick={() => {
              setRestarting(true)
              void install().finally(() => setRestarting(false))
            }}
          >
            <Icon icon={CircleArrowUp} />
            {restarting ? 'Restarting…' : 'Restart to update'}
          </Button>
        </>
      ) : (
        <>
          {status?.lastError != null && (
            <p data-morph-row="" className="truncate px-2.5 pb-1 text-xs text-muted-foreground">
              {status.lastError}
            </p>
          )}
          <Button
            variant="ghost"
            data-morph-row=""
            className={ROW}
            onClick={() => {
              close()
              void retry()
            }}
          >
            <Icon icon={RotateCw} />
            Try again
          </Button>
        </>
      )}
    </>
  )
}

function SkillsOffer({
  pending,
  close,
}: {
  pending: readonly string[]
  close: () => void
}): React.JSX.Element {
  const update = useSetAtom(updateSkillsAtom)
  const dismiss = useSetAtom(dismissSkillsOfferAtom)
  const release = useAtomValue(openSkillsStatusAtom)?.release ?? null

  return (
    <>
      <p data-morph-row="" className="px-2.5 py-1.5 text-sm">
        This version of Holi has newer skills and hooks for this vault
      </p>
      {release !== null && (
        <p data-morph-row="" className="px-2.5 pb-1 text-xs text-muted-foreground">
          Its skills are from Holi {release}.
        </p>
      )}
      <Paths paths={pending} />
      <Button
        variant="ghost"
        data-morph-row=""
        className={ROW}
        onClick={() => {
          close()
          void update()
        }}
      >
        <Icon icon={Sparkles} />
        Update skills
      </Button>
      <Button
        variant="ghost"
        data-morph-row=""
        className={ROW}
        onClick={() => {
          close()
          dismiss()
        }}
      >
        <Icon icon={Clock} />
        Not now
      </Button>
    </>
  )
}

/** A few of `paths`, then how many more. */
function Paths({ paths }: { paths: readonly string[] }): React.JSX.Element {
  const rest = paths.length - NAMED
  return (
    <ul data-morph-row="" className="px-2.5 pb-1 text-xs text-muted-foreground">
      {paths.slice(0, NAMED).map((path) => (
        <li key={path} className="truncate font-mono">
          {path}
        </li>
      ))}
      {rest > 0 && <li>and {rest} more</li>}
    </ul>
  )
}

/** What the update run on opening this vault changed, until it is seen. */
function SkillsNotice({
  notice,
  close,
}: {
  notice: SkillsUpdated
  close: () => void
}): React.JSX.Element {
  const merge = useSetAtom(mergeSkillsConflictsAtom)
  const dismiss = useSetAtom(dismissSkillsNoticeAtom)
  const agent = useAtomValue(agentSourceAtom)

  return (
    <>
      <p data-morph-row="" className="px-2.5 py-1.5 text-sm">
        {notice.summary}
      </p>
      <Paths paths={notice.changed} />
      {notice.conflicts !== null && agent !== null && (
        <Button
          variant="ghost"
          data-morph-row=""
          className={ROW}
          onClick={() => {
            close()
            void merge()
          }}
        >
          <Icon icon={Sparkles} />
          Merge with the agent
        </Button>
      )}
      <Button
        variant="ghost"
        data-morph-row=""
        className={ROW}
        onClick={() => {
          close()
          dismiss()
        }}
      >
        <Icon icon={Check} />
        Done
      </Button>
    </>
  )
}

/** The item, or null while there is nothing to act on. */
export function useUpdateItem(): MorphingMenuItem | null {
  const status = useAtomValue(updateStatusAtom)
  const offer = useAtomValue(skillsOfferAtom)
  const notice = useAtomValue(skillsNoticeAtom)
  const ready = status?.state === 'ready'
  const stranded = status?.state === 'available' && status.lastError !== null
  const app = ready || stranded
  return useMemo(() => {
    if (!app && offer === null && notice === null) return null
    return {
      id: 'update',
      label: ready
        ? 'Update ready: restart to install'
        : stranded
          ? 'Update failed to download'
          : offer !== null
            ? 'Newer skills for this vault'
            : 'Skills updated',
      icon: CircleArrowUp,
      ...(ready ? { tone: 'busy' as const } : stranded ? { tone: 'warn' as const } : {}),
      panel: (close) => (
        <div className="flex w-72 flex-col gap-0.5 p-1">
          {app && <AppUpdate close={close} />}
          {offer !== null && <SkillsOffer pending={offer} close={close} />}
          {notice !== null && <SkillsNotice notice={notice} close={close} />}
        </div>
      ),
    }
  }, [app, ready, stranded, offer, notice])
}
