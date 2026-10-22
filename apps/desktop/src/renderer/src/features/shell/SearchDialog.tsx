/**
 * ⌘K (app-shell-21's search palette, on Holi's command menu): the places the
 * sidebar holds and the vaults this machine has, filtered as you type. Enter
 * opens the top match.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { Bot, FileText, PlusIcon } from 'lucide-react'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Icon,
} from '@/primitives'
import { appModeAtom } from '@/state/app-mode'
import { runningPluginsAtom } from '@/state/plugins'
import { switchVaultAtom } from '@/state/vault-switch'
import { activeRemoteAtom, vaultsAtom } from '@/state/vaults'

export function SearchDialog({
  open,
  onOpenChange,
  onAddVault,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAddVault: () => void
}): React.JSX.Element {
  const vaults = useAtomValue(vaultsAtom)
  const active = useAtomValue(activeRemoteAtom)
  const setMode = useSetAtom(appModeAtom)
  const switchVault = useSetAtom(switchVaultAtom)
  const hasAgents = useAtomValue(runningPluginsAtom).some((p) => p.agentsMode !== undefined)

  /** Every choice closes the palette first. */
  const choose = (run: () => void) => () => {
    onOpenChange(false)
    run()
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search"
      description="Go to a place or another vault"
    >
      <CommandInput placeholder="Search places and vaults" />
      <CommandList>
        <CommandEmpty>Nothing matches. Try a vault's name or owner.</CommandEmpty>
        <CommandGroup heading="Places">
          {hasAgents && (
            <CommandItem onSelect={choose(() => setMode('agents'))}>
              <Icon icon={Bot} />
              Agents
            </CommandItem>
          )}
          <CommandItem onSelect={choose(() => setMode('documents'))}>
            <Icon icon={FileText} />
            Documents
          </CommandItem>
        </CommandGroup>
        <CommandGroup heading="Vaults">
          {vaults
            .filter((vault) => vault.remote !== active)
            .map((vault) => (
              <CommandItem
                key={vault.remote}
                value={`${vault.name} ${vault.remote}`}
                onSelect={choose(() => switchVault(vault.remote))}
              >
                <span className="min-w-0 flex-1 truncate">{vault.name}</span>
                <span className="truncate text-xs text-muted-foreground">{vault.remote}</span>
              </CommandItem>
            ))}
          <CommandItem onSelect={choose(onAddVault)}>
            <Icon icon={PlusIcon} />
            Add vault…
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
