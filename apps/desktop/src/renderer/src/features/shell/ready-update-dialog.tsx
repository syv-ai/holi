import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useState } from 'react'
import { ConfirmDialog } from '@/composites/confirm-dialog'
import { installUpdateAtom, updateStatusAtom } from '@/state/updates'

const DISMISSED_KEY = 'holi:ready-update-dismissed'

function dismissalKey(version: string, channel: string): string {
  return `${channel}:${version}`
}

function wasDismissed(key: string): boolean {
  try {
    return window.localStorage.getItem(`${DISMISSED_KEY}:${key}`) === 'true'
  } catch {
    return false
  }
}

function saveDismissal(key: string): void {
  try {
    window.localStorage.setItem(`${DISMISSED_KEY}:${key}`, 'true')
  } catch {
    // The prompt remains dismissible when browser storage is unavailable.
  }
}

function hasOpenDialog(title: string): boolean {
  return [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].some(
    (dialog) => !dialog.textContent?.includes(title),
  )
}

export function ReadyUpdateDialog(): React.JSX.Element | null {
  const status = useAtomValue(updateStatusAtom)
  const install = useSetAtom(installUpdateAtom)
  const [visible, setVisible] = useState(false)
  const [eligibleKey, setEligibleKey] = useState<string | null>(null)
  const [dialogBlocked, setDialogBlocked] = useState(false)
  const [temporarilyClosed, setTemporarilyClosed] = useState(false)
  const readyKey =
    status?.state === 'ready' && status.availableVersion !== null
      ? dismissalKey(status.availableVersion, status.channel)
      : null

  useEffect(() => {
    let active = true
    let receivedPush = false
    const off = window.holi.window.onVisible((next) => {
      receivedPush = true
      setVisible(next)
    })
    // Subscribe first, then ask: a show/hide push wins if it races the answer.
    void window.holi.window.isVisible().then(
      (next) => {
        if (active && !receivedPush) setVisible(next)
      },
      () => {
        // The window can close before its initial visibility query answers.
      },
    )
    return () => {
      active = false
      off()
    }
  }, [])

  useEffect(() => {
    setEligibleKey(readyKey !== null && !wasDismissed(readyKey) ? readyKey : null)
  }, [readyKey])

  useEffect(() => {
    const updateBlock = () =>
      setDialogBlocked(hasOpenDialog(`Holi ${status?.availableVersion ?? ''} is ready`))
    updateBlock()
    const observer = new MutationObserver(updateBlock)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true })
    return () => observer.disconnect()
  }, [status?.availableVersion])

  const open =
    visible &&
    !dialogBlocked &&
    !temporarilyClosed &&
    readyKey !== null &&
    eligibleKey === readyKey &&
    status?.state === 'ready'
  if (readyKey === null || eligibleKey !== readyKey || status?.state !== 'ready') return null

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setTemporarilyClosed(true)
      }}
      onOpenAutoFocus={(event) => event.preventDefault()}
      onCancel={() => {
        saveDismissal(readyKey)
        setEligibleKey(null)
      }}
      size="sm"
      title={`Holi ${status.availableVersion} is ready`}
      description="Restart Holi to install this update. Your vault will be saved and synced before restarting."
      cancelLabel="Later"
      confirmLabel="Restart now"
      onConfirm={() => install()}
    />
  )
}
