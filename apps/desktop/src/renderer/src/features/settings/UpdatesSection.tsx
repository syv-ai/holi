/**
 * Settings → Updates (docs/features/updates.md): updating Holi on this
 * machine, then where the open vault's skills
 * stand against this release.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useState } from 'react'
import { trpc } from '@/lib/trpc'
import { Button, Checkbox } from '@/primitives'
import { SettingsList, SettingsNote, SettingsRow } from '@/composites'
import { openSkillsStatusAtom, updateSkillsAtom } from '@/state/skills'
import { DescriptorSection } from './DescriptorSection'
import {
  checkForUpdateAtom,
  installUpdateAtom,
  retryUpdateDownloadAtom,
  setAutoUpdateAtom,
  setUpdateChannelAtom,
  updateHeadline,
  updateStatusAtom,
} from '@/state/updates'

/** "just now", "12m ago", "3h ago", "yesterday", "4d ago". */
export function checkedAgo(at: number, now: number = Date.now()): string {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? 'yesterday' : `${days}d ago`
}

export function UpdatesSection(): React.JSX.Element {
  const status = useAtomValue(updateStatusAtom)
  const check = useSetAtom(checkForUpdateAtom)
  const retry = useSetAtom(retryUpdateDownloadAtom)
  const install = useSetAtom(installUpdateAtom)
  const setEnabled = useSetAtom(setAutoUpdateAtom)
  const setChannel = useSetAtom(setUpdateChannelAtom)
  const supported = status?.supported === true

  const action = !supported ? null : status.state === 'ready' ? (
    <Button size="xs" onClick={() => void install()}>
      Restart to update
    </Button>
  ) : status.state === 'available' && status.lastError !== null ? (
    <Button variant="secondary" size="xs" onClick={() => void retry()}>
      Try again
    </Button>
  ) : (
    <Button
      variant="secondary"
      size="xs"
      disabled={status.state !== 'idle'}
      onClick={() => void check()}
    >
      Check now
    </Button>
  )

  return (
    <SettingsList>
      <SettingsRow
        label={updateHeadline(status)}
        description={
          status === null
            ? undefined
            : [
                status.version === '' ? null : `You have Holi ${status.version}.`,
                status.lastCheckAt === null
                  ? null
                  : `Last checked ${checkedAgo(status.lastCheckAt)}.`,
              ]
                .filter((s) => s !== null)
                .join(' ') || undefined
        }
        control={action ?? undefined}
      >
        {status?.lastError != null && (
          <SettingsNote className="break-words">{status.lastError}</SettingsNote>
        )}
      </SettingsRow>
      <SettingsRow
        label="Dev prereleases"
        description="Opt in to development releases. Turning this off checks for and downloads the latest stable release, even if it is older than the version you have; restart to install it."
        control={
          <Checkbox
            aria-label="Dev prereleases"
            disabled={!supported}
            checked={status?.channel === 'dev'}
            onCheckedChange={(v) => void setChannel(v === true ? 'dev' : 'stable')}
          />
        }
      />
      <SettingsRow
        label="Update automatically"
        description="Check every few hours and download new versions in the background. An update installs when you quit Holi or choose Restart to update."
        control={
          <Checkbox
            aria-label="Update automatically"
            disabled={!supported}
            checked={status?.enabled === true}
            onCheckedChange={(v) => void setEnabled(v === true)}
          />
        }
      />
      <OpenAtLoginRow />
    </SettingsList>
  )
}

function OpenAtLoginRow(): React.JSX.Element {
  const [open, setOpen] = useState<boolean | null>(null)
  useEffect(() => {
    void trpc.app.loginItem.query().then((r) => setOpen(r.openAtLogin))
  }, [])
  return (
    <SettingsRow
      label="Open at login"
      description="Start Holi in the menu bar when you log in, its window out of sight, so reminders and sync work from the start."
      control={
        <Checkbox
          aria-label="Open at login"
          disabled={open === null}
          checked={open === true}
          onCheckedChange={(v) =>
            void trpc.app.setLoginItem
              .mutate({ openAtLogin: v === true })
              .then((r) => setOpen(r.openAtLogin))
          }
        />
      }
    />
  )
}

/**
 * Where the open vault's skills and hooks stand against this release, and
 * whether the vault takes them on open (`autoUpdateSkills`).
 */
export function VaultSkillsSection(): React.JSX.Element {
  const status = useAtomValue(openSkillsStatusAtom)
  const update = useSetAtom(updateSkillsAtom)
  const pending = status?.pending.length ?? 0
  return (
    <>
      <SettingsList>
        <SettingsRow
          label={
            status === null
              ? 'Loading…'
              : pending === 0
                ? 'Skills and hooks are up to date'
                : `This version of Holi has ${pending} newer ${pending === 1 ? 'file' : 'files'} for this vault`
          }
          description={
            status === null
              ? undefined
              : status.release === null
                ? 'Holi has not written this vault’s skills on this machine.'
                : `Last brought in by Holi ${status.release}.`
          }
          control={
            pending > 0 ? (
              <Button size="xs" onClick={() => void update()}>
                Update skills
              </Button>
            ) : undefined
          }
        />
      </SettingsList>
      <DescriptorSection section="updates" />
    </>
  )
}
