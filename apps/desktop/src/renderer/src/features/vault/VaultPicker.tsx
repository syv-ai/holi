/**
 * The vault switcher: the nav menu's morphing menu, its dock the open vault's
 * name at the head of the sidebar, growing down into the list of vaults.
 * "Add vault…" belongs *in* the list: switching and adding are the same
 * gesture.
 *
 * Each row ends with its repo at a glance (`RepoMeter`): how full it is on
 * GitHub and a link there, read when the menu opens.
 *
 * **Switching only.** A vault's way out (Leave, Remove, Delete) lives in
 * Settings, Vault, for the open vault, away from a menu you open to switch.
 */
import { Check, ChevronDown, Library, Plus } from 'lucide-react'
import { useMemo, useRef } from 'react'
import { Button, Icon, MorphingMenu, Tooltip, type MorphingMenuItem } from '@/primitives'
import { RepoMeter } from '@/composites'
import { cn } from '@/lib/cn'
import { useRepoSize } from '@/state/repo-usage'

type Vault = { remote: string; name: string }

const ROW = 'h-auto min-h-8 justify-start gap-2 rounded-xl px-2.5 py-1.5 text-sm font-normal'

export function VaultPicker({
  vaults,
  activeRemote,
  onSelect,
  onAddVault,
}: {
  vaults: Vault[]
  activeRemote: string | null
  onSelect: (remote: string) => void
  onAddVault: () => void
}) {
  const active = vaults.find((v) => v.remote === activeRemote)
  // The menu restarts its layout pass when its items change identity, so they
  // depend on the list only and call the latest handlers.
  const handlers = useRef({ onSelect, onAddVault })
  handlers.current = { onSelect, onAddVault }

  const items = useMemo(
    (): MorphingMenuItem[] => [
      {
        id: 'vaults',
        label: 'Vaults',
        icon: Library,
        panel: (close) => (
          <div className="flex w-72 flex-col gap-0.5 p-1">
            {vaults.length === 0 && (
              <p data-morph-row="" className="px-2.5 py-1.5 text-sm text-muted-foreground">
                no vaults yet
              </p>
            )}
            {vaults.map((v) => (
              <VaultRow
                key={v.remote}
                vault={v}
                active={v.remote === activeRemote}
                onSelect={() => {
                  close()
                  if (v.remote !== activeRemote) handlers.current.onSelect(v.remote)
                }}
              />
            ))}
            {/* Pinned to the bottom: adding a vault is part of the same menu,
                not a separate control competing with the switcher. */}
            <div data-morph-row="" className="mx-2.5 my-1 h-px bg-border" />
            <Button
              variant="ghost"
              data-morph-row=""
              data-vault-add=""
              className={ROW}
              onClick={() => {
                close()
                handlers.current.onAddVault()
              }}
            >
              <Icon icon={Plus} size="sm" />
              Add vault…
            </Button>
          </div>
        ),
      },
    ],
    [vaults, activeRemote],
  )

  return (
    <MorphingMenu
      label="Vaults"
      anchor="top-left"
      items={items}
      className="min-w-0 flex-1"
      trigger={
        <span data-vault-picker="" className="flex min-w-0 flex-1 items-center gap-1">
          <span className="min-w-0 flex-1 truncate">
            {active?.name ?? (vaults.length ? 'select vault' : 'no vaults')}
          </span>
          <Icon icon={ChevronDown} />
        </span>
      }
    />
  )
}

function VaultRow({
  vault,
  active,
  onSelect,
}: {
  vault: Vault
  active: boolean
  onSelect: () => void
}) {
  const sizeKb = useRepoSize(vault.remote)
  return (
    <div data-morph-row="" className="flex items-center gap-1 pr-1">
      <Button
        variant="ghost"
        data-vault-option={vault.remote}
        aria-current={active ? 'true' : undefined}
        className={cn(ROW, 'min-w-0 flex-1', active && 'text-foreground')}
        onClick={onSelect}
      >
        <span className="flex w-3.5 shrink-0 justify-center">
          {active && <Icon icon={Check} size="sm" className="text-brand" />}
        </span>
        <Tooltip content={vault.remote} side="right">
          <span className="truncate">{vault.name}</span>
        </Tooltip>
      </Button>
      <RepoMeter
        sizeKb={sizeKb}
        onOpen={() => void window.holi.openExternal(`https://github.com/${vault.remote}`)}
      />
    </div>
  )
}
