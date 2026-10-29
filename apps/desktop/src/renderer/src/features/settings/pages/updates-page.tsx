/**
 * Updates: the app's own updates, each release's notes and start, with where
 * the open vault's skills stand against this release.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  checkForUpdateAtom,
  installUpdateAtom,
  retryUpdateDownloadAtom,
  setAutoUpdateAtom,
  setUpdateChannelAtom,
  updateHeadline,
  updateStatusAtom,
} from '@/state/updates'
import { SettingsGroup, SettingsFieldRow } from '../settings-kit'
import { OpenAtLoginRow } from './open-at-login-row'
import { ReleaseNotesRow } from './release-notes-row'
import { VaultSkillsCard } from './vault-skills-card'

/** "just now", "12m ago", "3h ago", "yesterday", "4d ago". */
function checkedAgo(at: number, now: number = Date.now()): string {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? 'yesterday' : `${days}d ago`
}

export function UpdatesPage() {
  const status = useAtomValue(updateStatusAtom)
  const check = useSetAtom(checkForUpdateAtom)
  const retry = useSetAtom(retryUpdateDownloadAtom)
  const install = useSetAtom(installUpdateAtom)
  const setEnabled = useSetAtom(setAutoUpdateAtom)
  const setChannel = useSetAtom(setUpdateChannelAtom)
  const supported = status?.supported === true

  const action = !supported ? null : status.state === 'ready' ? (
    <Button size="sm" onClick={() => void install()}>
      Restart to update
    </Button>
  ) : status.state === 'available' && status.lastError !== null ? (
    <Button variant="outline" size="sm" onClick={() => void retry()}>
      Retry
    </Button>
  ) : (
    <Button
      variant="outline"
      size="sm"
      disabled={status.state !== 'idle'}
      onClick={() => void check()}
    >
      Check now
    </Button>
  )

  const described =
    status === null
      ? undefined
      : [
          status.version === '' ? null : `You have Holi ${status.version}.`,
          status.lastCheckAt === null ? null : `Last checked ${checkedAgo(status.lastCheckAt)}.`,
          status.lastError,
        ]
          .filter((part) => part !== null && part !== '')
          .join(' ') || undefined

  return (
    <div className="flex flex-col gap-8">
      <SettingsGroup title="Updates" description="Holi itself, on this machine.">
        <SettingsFieldRow title={updateHeadline(status)} description={described}>
          {action}
        </SettingsFieldRow>
        {status?.availableVersion != null && status.availableVersion !== status.version ? (
          <ReleaseNotesRow
            key={status.availableVersion}
            version={status.availableVersion}
            title={`What’s new in Holi ${status.availableVersion}`}
          />
        ) : null}
        {status !== null && status.version !== '' ? (
          <ReleaseNotesRow
            key={status.version}
            version={status.version}
            title={`Holi ${status.version}, the version you have`}
          />
        ) : null}
        <SettingsFieldRow
          title="Dev prereleases"
          description="Development releases instead of stable ones. Turning this off downloads the latest stable release, even when it is older than yours; restart to install it."
          htmlFor="settings-dev-channel"
        >
          <Switch
            id="settings-dev-channel"
            disabled={!supported}
            checked={status?.channel === 'dev'}
            onCheckedChange={(on) => void setChannel(on ? 'dev' : 'stable')}
          />
        </SettingsFieldRow>
        <SettingsFieldRow
          title="Update automatically"
          description="Download new versions in the background. One installs when you quit Holi."
          htmlFor="settings-auto-update"
        >
          <Switch
            id="settings-auto-update"
            disabled={!supported}
            checked={status?.enabled === true}
            onCheckedChange={(on) => void setEnabled(on)}
          />
        </SettingsFieldRow>
        <OpenAtLoginRow />
      </SettingsGroup>
      <VaultSkillsCard />
    </div>
  )
}
