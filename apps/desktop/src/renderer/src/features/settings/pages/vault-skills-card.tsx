/** The open vault's skills card on the Updates page. */
import { useAtomValue, useSetAtom } from 'jotai'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import {
  dismissSkillsNoticeAtom,
  mergeSkillsConflictsAtom,
  openSkillsStatusAtom,
  skillsNoticeAtom,
  updateSkillsAtom,
} from '@/state/skills'
import { SettingsGroup, SettingsFieldRow } from '../settings-kit'
import { useVaultSettings } from '../use-vault-settings'

/**
 * Where the open vault's skills and hooks stand against this release, what
 * the update on open did, and whether the vault takes them on open
 * (`autoUpdateSkills`, committed, so a team answers it once).
 */
export function VaultSkillsCard() {
  const status = useAtomValue(openSkillsStatusAtom)
  const notice = useAtomValue(skillsNoticeAtom)
  const update = useSetAtom(updateSkillsAtom)
  const merge = useSetAtom(mergeSkillsConflictsAtom)
  const dismiss = useSetAtom(dismissSkillsNoticeAtom)
  const { resolved, write } = useVaultSettings()
  const [busy, setBusy] = useState(false)
  const pending = status?.pending.length ?? 0

  const run = async (what: () => Promise<void>) => {
    setBusy(true)
    try {
      await what()
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsGroup
      title="This vault’s skills"
      description="The skills and hooks Holi gave the vault's agent, against this release."
    >
      {status === null ? (
        <SettingsFieldRow title={<Skeleton className="h-4 w-48" />} />
      ) : (
        <SettingsFieldRow
          title={
            pending === 0
              ? 'Skills and hooks are up to date'
              : `This version of Holi has ${pending} newer ${pending === 1 ? 'file' : 'files'} for this vault`
          }
          description={
            status.release === null
              ? 'Holi has not written this vault’s skills on this machine.'
              : `Last brought in by Holi ${status.release}.`
          }
        >
          {pending > 0 ? (
            <Button size="sm" disabled={busy} onClick={() => void run(update)}>
              Update skills
            </Button>
          ) : null}
        </SettingsFieldRow>
      )}
      {notice !== null ? (
        <SettingsFieldRow
          title="Updated when the vault opened"
          description={
            notice.changed.length > 0
              ? `${notice.summary} ${notice.changed.join(', ')}`
              : notice.summary
          }
        >
          <div className="flex gap-2">
            {notice.conflicts !== null ? (
              <Button size="sm" disabled={busy} onClick={() => void run(merge)}>
                Merge with the agent
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={() => dismiss()}>
              Done
            </Button>
          </div>
        </SettingsFieldRow>
      ) : null}
      <SettingsFieldRow
        title="Update skills automatically"
        description="Bring a new release's skills in when the vault opens, after it has synced. Saved in the vault, so it is the whole team's answer."
        htmlFor="settings-auto-skills"
      >
        <Switch
          id="settings-auto-skills"
          disabled={resolved === null}
          checked={resolved?.autoUpdateSkills === true}
          onCheckedChange={(on) => void write('autoUpdateSkills', on, 'committed')}
        />
      </SettingsFieldRow>
    </SettingsGroup>
  )
}
