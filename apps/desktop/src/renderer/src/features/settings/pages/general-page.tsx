/** General: what the vault is and where it lives, its agents and its repo's size. */
import { useAtomValue, useSetAtom } from 'jotai'
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
import { useAgentService } from '@/state/agent-service'
import { AgentMark } from '@/composites/marks'
import { claudeFirstRunAtom } from '@/state/claude-first-run'
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
    description:
      "Anthropic's agent. Its sessions keep running in the background, and Holis and automations run on it.",
  },
  {
    id: 'codex',
    label: 'Codex',
    description:
      "OpenAI's agent, signed in as on the command line. Its sessions run while Holi is open.",
  },
]

/** Which agent a new session starts in, on this machine: a row per agent,
 *  the default marked and the others a click from being it. */
function AgentsCard() {
  const { resolved, write } = useVaultSettings()
  const current = resolved?.agentProvider ?? VAULT_SETTING_DEFAULTS.agentProvider
  return (
    <SettingsGroup
      title="Agents"
      description="A new session starts in the default one, on this machine. Hover the Sessions + to start another."
    >
      {resolved === null ? (
        <SettingsRowsLoading rows={2} label="Reading the settings" />
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
              <Button
                variant="outline"
                size="sm"
                onClick={() => void write('agentProvider', agent.id, 'local')}
              >
                Make default
              </Button>
            )}
          </SettingsFieldRow>
        ))
      )}
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
