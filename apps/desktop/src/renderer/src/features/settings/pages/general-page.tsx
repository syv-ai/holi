/** General: what the vault is and where it lives, its agents and its repo's size. */
import { useCallback, useEffect, useState } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import {
  formatRepoSize,
  REPO_SIZE_LIMIT_KB,
  repoUsagePercent,
  VAULT_SETTING_DEFAULTS,
  type AgentProviderId,
  syncLabel,
  type SyncLabel,
} from '@holi/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/composites/confirm-dialog'
import { useAgentService } from '@/state/agent-service'
import { AgentMark } from '@/composites/marks'
import { claudeFirstRunAtom } from '@/state/claude-first-run'
import { agentCapability } from '@/state/document-runs'
import { useRepoSize } from '@/state/repo-usage'
import { activeRemoteAtom, retrySyncAtom, syncStateAtom, vaultsAtom } from '@/state/vaults'
import { ExternalLinkIcon, FolderOpenIcon, ShieldCheckIcon } from 'lucide-react'
import { SettingsGroup, SettingsFieldRow, SettingsRowsLoading } from '../settings-kit'
import { useVaultSettings } from '../use-vault-settings'
import { openExternal } from '@/lib/open-external'

const githubUrl = (path: string) => `https://github.com/${path}`

const SYNC_BADGE: Record<SyncLabel['tone'], 'success-light' | 'info-light' | 'warning-light'> = {
  quiet: 'success-light',
  busy: 'info-light',
  warn: 'warning-light',
}

/** The coding agents a session can run, as the Agents card lists them. */
const AGENTS: readonly {
  id: AgentProviderId
  label: string
  description: string
}[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    description: "Anthropic's agent. Its sessions keep running in the background.",
  },
  {
    id: 'codex',
    label: 'Codex',
    description:
      "OpenAI's agent, signed in as on the command line. Its sessions run while Holi is open.",
  },
  {
    id: 'pi',
    label: 'Pi',
    description:
      'The open-source agent, on your own Pi models and sign-in. Its sessions run while Holi is open; its unattended runs need macOS.',
  },
]

/** What a Codex job can do, said before anyone lets one run unwatched. */
const CODEX_RISK =
  'A Codex job can read any file on this computer and write what it read into this vault’s synced folders. A note from someone you do not trust could make it publish private data to everyone this vault syncs with.'

/**
 * Whether Codex may run unattended here (Holis, automations): this
 * machine's answer for this vault, which main enforces (`agent.job`). Off
 * until someone turns it on, after a dialog that says what it risks; off
 * again at a click.
 */
function CodexUnattendedRow({ remote }: { remote: string }) {
  const [allowed, setAllowed] = useState<boolean | null>(null)
  const [failed, setFailed] = useState(false)
  const [asking, setAsking] = useState(false)

  const read = useCallback(() => {
    setFailed(false)
    agentCapability<boolean>(remote, 'agent.unattended', { provider: 'codex' }).then(
      (on) => setAllowed(on === true),
      () => setFailed(true),
    )
  }, [remote])
  useEffect(read, [read])

  const set = async (on: boolean): Promise<void> => {
    await agentCapability(remote, 'agent.allowUnattended', { provider: 'codex', on })
    setAllowed(on)
  }

  return (
    <SettingsFieldRow
      title="Let Codex run unattended in this vault"
      htmlFor="codex-unattended"
      description={
        failed ? (
          <span className="text-destructive">Holi could not read this machine’s answer.</span>
        ) : (
          'Holis and automations on Codex run only once this is on, on this machine. A Codex job can read any file on this computer.'
        )
      }
    >
      {failed ? (
        <Button variant="outline" size="sm" onClick={read}>
          Retry
        </Button>
      ) : (
        <Switch
          id="codex-unattended"
          checked={allowed === true}
          disabled={allowed === null}
          onCheckedChange={(on) => (on ? setAsking(true) : void set(false).catch(read))}
        />
      )}
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title="Let Codex run unattended in this vault?"
        description={CODEX_RISK}
        confirmLabel="Let it run"
        cancelLabel="Not now"
        destructive
        onConfirm={() => set(true)}
      />
    </SettingsFieldRow>
  )
}
/** The vaults, by remote, where this machine was told that Pi runs its
 *  tools without asking. Asked once per vault, on this machine. */
const piWarnedAtom = atomWithStorage<Record<string, true>>('holi:piUnattendedWarned', {})

/** Which agent a new session starts in, on this machine: a row per agent,
 *  the default marked and the others a click from being it, and whether
 *  Codex may run unattended in the vault. */
function AgentsCard() {
  const remote = useAtomValue(activeRemoteAtom)
  const agent = useAgentService()
  const { resolved, write } = useVaultSettings()
  const current = resolved?.agentProvider ?? VAULT_SETTING_DEFAULTS.agentProvider
  const [warned, setWarned] = useAtom(piWarnedAtom)
  const [askPi, setAskPi] = useState(false)
  const makeDefault = (id: AgentProviderId): void => {
    // The default is what Holis, automations and Create vault app run on:
    // Pi there runs every tool without asking, which is said once.
    if (id === 'pi' && remote !== null && warned[remote] !== true) {
      setAskPi(true)
      return
    }
    void write('agentProvider', id, 'local')
  }
  return (
    <SettingsGroup
      title="Agents"
      description="A new session starts in the default one, on this machine. Hover the Sessions + to start another."
    >
      {resolved === null ? (
        <SettingsRowsLoading rows={3} label="Reading the settings" />
      ) : (
        AGENTS.map((agent) => (
          <SettingsFieldRow
            key={agent.id}
            title={agent.label}
            description={agent.description}
            mark={<AgentMark agent={agent.id} size="lg" />}
          >
            {agent.id === current ? (
              <Badge variant="success-light">Default</Badge>
            ) : (
              <Button variant="outline" size="sm" onClick={() => makeDefault(agent.id)}>
                Make default
              </Button>
            )}
          </SettingsFieldRow>
        ))
      )}
      {resolved !== null && remote !== null && agent !== null ? (
        <CodexUnattendedRow key={remote} remote={remote} />
      ) : null}
      <ConfirmDialog
        open={askPi}
        onOpenChange={setAskPi}
        title="Run unattended work on Pi?"
        description="Holis, automations and Create vault app will run on Pi with nobody watching. Pi asks before no tool: each run edits the files it may touch without asking you. Holi keeps it to those files, and runs it only on macOS."
        confirmLabel="Make Pi the default"
        onConfirm={async () => {
          if (remote !== null) setWarned((all) => ({ ...all, [remote]: true }))
          await write('agentProvider', 'pi', 'local')
        }}
      />
    </SettingsGroup>
  )
}

/**
 * What the repo weighs on GitHub against the 10 GB GitHub recommends
 * (docs/features/vaults-sync.md, Repo size). GitHub recomputes the size on
 * its own schedule, so it is asked at most every ten minutes, and the row
 * says it is waiting rather than guess.
 */
function RepoSizeRow({ remote }: { remote: string }) {
  const sizeKb = useRepoSize(remote)
  const percent = sizeKb === null ? null : repoUsagePercent(sizeKb)
  return (
    <SettingsFieldRow
      title="Size on GitHub"
      description={`GitHub recommends keeping a repository under ${formatRepoSize(REPO_SIZE_LIMIT_KB)}. It updates the size on its own schedule.`}
    >
      {sizeKb === null || percent === null ? (
        <span className="text-muted-foreground text-sm">Asking GitHub…</span>
      ) : (
        <div className="flex w-full max-w-56 flex-col items-end gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium tabular-nums">{formatRepoSize(sizeKb)}</span>
            {percent >= 60 ? (
              <Badge variant={percent >= 90 ? 'destructive-light' : 'warning-light'}>
                {percent}%
              </Badge>
            ) : (
              <span className="text-muted-foreground text-xs tabular-nums">{percent}%</span>
            )}
          </div>
          <Progress
            value={Math.min(percent, 100)}
            aria-label="Share of GitHub's recommended size"
          />
        </div>
      )}
    </SettingsFieldRow>
  )
}

export function GeneralPage() {
  const remote = useAtomValue(activeRemoteAtom)
  const entry = useAtomValue(vaultsAtom).find((v) => v.remote === remote)
  const sync = syncLabel(useAtomValue(syncStateAtom))
  const retrySync = useSetAtom(retrySyncAtom)
  const agent = useAgentService()
  const firstRun = useSetAtom(claudeFirstRunAtom)

  if (entry === undefined) {
    return (
      <SettingsGroup title="Vault" description="The vault open in this window.">
        <SettingsRowsLoading rows={3} label="Reading the vault" />
      </SettingsGroup>
    )
  }

  return (
    <>
      <SettingsGroup
        title="Vault"
        description="A vault is a GitHub repository, kept in step with a copy on this machine."
      >
        <SettingsFieldRow title="Name" description="The repository's name.">
          <span className="text-sm font-medium">{entry.name}</span>
        </SettingsFieldRow>
        <SettingsFieldRow
          title="Repository"
          description="Where the vault lives, and who it is shared with."
        >
          <Button variant="outline" size="sm" onClick={() => openExternal(githubUrl(entry.remote))}>
            {entry.remote}
            <ExternalLinkIcon data-icon="inline-end" aria-hidden="true" />
          </Button>
        </SettingsFieldRow>
        <SettingsFieldRow
          title="On this machine"
          description={<span className="break-all">{entry.path}</span>}
        >
          <Button variant="outline" size="sm" onClick={() => void window.holi.openPath(entry.path)}>
            <FolderOpenIcon data-icon="inline-start" aria-hidden="true" />
            Show folder
          </Button>
        </SettingsFieldRow>
        <RepoSizeRow remote={entry.remote} />
        <SettingsFieldRow
          title="Sync"
          description="Your edits are committed and pushed as you work, and others' are pulled in."
        >
          <div className="flex items-center gap-2">
            <Badge variant={SYNC_BADGE[sync.tone]}>{sync.text}</Badge>
            {sync.tone === 'warn' ? (
              <Button variant="outline" size="sm" onClick={() => void retrySync()}>
                Retry
              </Button>
            ) : null}
          </div>
        </SettingsFieldRow>
        {/* Each machine's Claude Code asks once to trust the vault's folder and
          to sign in, and refuses background work until it has: a colleague
          who cloned the vault approves it here (state/claude-first-run.ts). */}
        <SettingsFieldRow
          title="Claude Code"
          description={
            agent === null
              ? 'Turn on the agent plugin to use Claude Code in this vault.'
              : 'Trust this vault and sign in, once on each machine. Until then the agent cannot work in the background here.'
          }
        >
          <Button
            variant="outline"
            size="sm"
            disabled={agent === null || remote === null}
            onClick={() => remote !== null && firstRun(remote)}
          >
            <ShieldCheckIcon data-icon="inline-start" aria-hidden="true" />
            Trust and sign in
          </Button>
        </SettingsFieldRow>
      </SettingsGroup>
      <AgentsCard />
    </>
  )
}
