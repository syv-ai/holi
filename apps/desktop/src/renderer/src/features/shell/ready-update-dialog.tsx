import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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

export function ReadyUpdateDialog(): React.JSX.Element | null {
  const status = useAtomValue(updateStatusAtom)
  const install = useSetAtom(installUpdateAtom)
  const [visible, setVisible] = useState(false)
  const [eligibleKey, setEligibleKey] = useState<string | null>(null)
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

  if (readyKey === null || eligibleKey !== readyKey || status?.state !== 'ready') return null
  const dismiss = () => {
    saveDismissal(readyKey)
    setEligibleKey(null)
  }

  return (
    <Dialog
      open={visible}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) dismiss()
      }}
    >
      <DialogContent aria-describedby="ready-update-description" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Holi {status.availableVersion} is ready</DialogTitle>
          <DialogDescription id="ready-update-description">
            Restart Holi to install this update. Your vault will be saved and synced before
            restarting.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={dismiss}>
            Later
          </Button>
          <Button type="button" onClick={() => void install()}>
            Restart now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
