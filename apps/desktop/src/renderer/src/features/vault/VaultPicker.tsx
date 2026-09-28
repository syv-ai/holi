/**
 * The vault switcher, a dropdown menu rather than a native `<select>`, because a
 * native select cannot hold an action row and "Add vault…" belongs *in* the
 * list: switching and adding are the same gesture.
 *
 * **Each vault has its options one level down** (D109). The row's ellipsis, or
 * → on the row, drills the same surface into that vault: back, then Leave, or
 * Remove when GitHub no longer shows it. A pick there opens the confirm;
 * nothing is removed from the menu itself. **Delete is not here:** it lives in
 * Settings, Vault only, away from a menu you open to switch.
 */
import { useSetAtom } from 'jotai'
import { ArrowLeft, Check, ChevronDown, Ellipsis, Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { VaultMembership } from '../../../../main/router'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Icon,
  IconButton,
  Tooltip,
} from '@/primitives'
import { trpc } from '@/lib/trpc'
import { openDialogAtom, type RemoveVaultIntent } from '@/state/dialogs'

export function VaultPicker({
  vaults,
  activeRemote,
  onSelect,
  onAddVault,
}: {
  vaults: { remote: string; name: string }[]
  activeRemote: string | null
  onSelect: (remote: string) => void
  onAddVault: () => void
}) {
  const active = vaults.find((v) => v.remote === activeRemote)
  const openDialog = useSetAtom(openDialogAtom)
  const [open, setOpen] = useState(false)
  /** The vault whose options are showing, or null for the list. */
  const [drill, setDrill] = useState<string | null>(null)

  const remove = (remote: string, intent: RemoveVaultIntent) =>
    openDialog({ id: 'remove-vault', size: 'sm', remote, intent })

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setDrill(null)
      }}
    >
      <Tooltip content="switch vault">
        <DropdownMenuTrigger
          data-vault-picker
          className="flex min-w-0 flex-1 items-center gap-1 px-2 py-1 text-sm font-bold text-foreground outline-none"
        >
          <span className="min-w-0 flex-1 truncate text-left">
            {active?.name ?? (vaults.length ? 'select vault' : 'no vaults')}
          </span>
          <Icon icon={ChevronDown} />
        </DropdownMenuTrigger>
      </Tooltip>

      <DropdownMenuContent>
        {drill !== null ? (
          <VaultOptions
            remote={drill}
            name={vaults.find((v) => v.remote === drill)?.name ?? drill}
            onBack={() => setDrill(null)}
            onRemove={(intent) => remove(drill, intent)}
          />
        ) : (
          <>
            {vaults.length === 0 && <DropdownMenuItem disabled>no vaults yet</DropdownMenuItem>}
            {vaults.map((v) => (
              <div key={v.remote} className="flex items-center gap-1">
                <DropdownMenuItem
                  data-vault-option={v.remote}
                  className={
                    v.remote === activeRemote ? 'min-w-0 flex-1 text-foreground' : 'min-w-0 flex-1'
                  }
                  onSelect={() => {
                    if (v.remote !== activeRemote) onSelect(v.remote)
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'ArrowRight') return
                    event.preventDefault()
                    setDrill(v.remote)
                  }}
                >
                  <span className="flex w-3.5 shrink-0 justify-center">
                    {v.remote === activeRemote && (
                      <Icon icon={Check} size="sm" className="text-brand" />
                    )}
                  </span>
                  <Tooltip content={v.remote} side="right">
                    <span className="truncate">{v.name}</span>
                  </Tooltip>
                </DropdownMenuItem>
                <IconButton
                  icon={Ellipsis}
                  label={`${v.name} options`}
                  shape="round"
                  tooltipSide="right"
                  data-vault-options={v.remote}
                  onClick={() => setDrill(v.remote)}
                />
              </div>
            ))}
            {/* Pinned to the bottom: adding a vault is part of the same menu, not a
                separate control competing with the switcher. */}
            <DropdownMenuSeparator />
            <DropdownMenuItem data-vault-add onSelect={onAddVault}>
              <Icon icon={Plus} size="sm" />
              <span>Add vault…</span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** One vault's options: what GitHub says this person may do to it. */
function VaultOptions({
  remote,
  name,
  onBack,
  onRemove,
}: {
  remote: string
  name: string
  onBack: () => void
  onRemove: (intent: RemoveVaultIntent) => void
}) {
  const [membership, setMembership] = useState<VaultMembership | 'error' | null>(null)
  const backRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // The list's row that had focus is gone; keep the keyboard in the menu.
    backRef.current?.focus()
    void trpc.vaults.membership
      .query({ remote })
      .then(setMembership)
      .catch(() => setMembership('error'))
  }, [remote])

  return (
    <>
      <DropdownMenuItem
        ref={backRef}
        data-vault-back
        className="text-muted-foreground"
        onSelect={(event) => {
          event.preventDefault()
          onBack()
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft') return
          event.preventDefault()
          onBack()
        }}
      >
        <Icon icon={ArrowLeft} size="sm" />
        <span className="truncate">{name}</span>
      </DropdownMenuItem>
      {membership === null ? (
        <DropdownMenuItem disabled>reading…</DropdownMenuItem>
      ) : membership === 'error' ? (
        <DropdownMenuItem disabled>GitHub did not answer</DropdownMenuItem>
      ) : membership.kind === 'gone' ? (
        <DropdownMenuItem data-vault-forget onSelect={() => onRemove('forget')}>
          Remove from this machine…
        </DropdownMenuItem>
      ) : membership.owned ? (
        <DropdownMenuItem disabled>you own this vault</DropdownMenuItem>
      ) : (
        <DropdownMenuItem data-vault-leave onSelect={() => onRemove('leave')}>
          Leave vault…
        </DropdownMenuItem>
      )}
    </>
  )
}
