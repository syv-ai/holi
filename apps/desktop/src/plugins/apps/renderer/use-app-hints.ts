import { useLayoutEffect, useRef } from 'react'
import { useAtomValue } from 'jotai'
import { registerHostHintAdapter } from '@/plugin-api'
import { activeRemoteAtom, vimCodeEditingAtom } from '@/plugin-api'
import { createAppHintAdapter } from './app-hints'

type FrameLease = { nonce: string; token: string }

function appFramePaneFocused(frame: HTMLIFrameElement): boolean {
  const pane = frame.closest<HTMLElement>('[data-pane]')
  if (!pane) return false
  const visiblePanes = [...document.querySelectorAll<HTMLElement>('[data-pane]')].filter(
    (candidate) => {
      if (candidate.hidden || candidate.closest('[hidden],[inert],[aria-hidden="true"]'))
        return false
      for (let node: HTMLElement | null = candidate; node; node = node.parentElement) {
        const style = getComputedStyle(node)
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          (style.opacity !== '' && Number(style.opacity) === 0)
        )
          return false
      }
      return true
    },
  )
  return (
    visiblePanes.includes(pane) &&
    (visiblePanes.length <= 1 || pane.getAttribute('data-pane-focused') === 'true')
  )
}

export function useAppHints({
  frame,
  lease,
  remote,
  bundle,
  visible,
  gateOpen,
  loaded,
  activeRemote,
  store,
  authorize,
}: {
  frame: HTMLIFrameElement | null
  lease: FrameLease | null
  remote: string
  bundle: string
  visible: boolean
  gateOpen: boolean
  loaded: string | null
  activeRemote: string | null
  store: {
    get(atom: typeof activeRemoteAtom): string | null
    get(atom: typeof vimCodeEditingAtom): boolean
  }
  authorize: () => Promise<boolean>
}): void {
  const vimEnabled = useAtomValue(vimCodeEditingAtom)
  const authorizeRef = useRef(authorize)
  authorizeRef.current = authorize
  useLayoutEffect(() => {
    let disposed = false
    const adapter =
      frame && lease && visible && gateOpen && loaded === bundle && activeRemote === remote
        ? createAppHintAdapter(frame, lease.nonce, {
            current: () =>
              !disposed &&
              store.get(activeRemoteAtom) === remote &&
              store.get(vimCodeEditingAtom) &&
              document.visibilityState === 'visible' &&
              document.hasFocus() &&
              frame.isConnected &&
              frame.getAttribute('aria-hidden') !== 'true' &&
              frame.ownerDocument.activeElement === frame &&
              appFramePaneFocused(frame),
            authorize: () => authorizeRef.current(),
          })
        : null
    const unregister = frame && adapter ? registerHostHintAdapter(frame, adapter) : null
    const eligible = () =>
      Boolean(
        adapter &&
        !disposed &&
        store.get(activeRemoteAtom) === remote &&
        store.get(vimCodeEditingAtom) &&
        document.visibilityState === 'visible' &&
        document.hasFocus() &&
        frame?.isConnected &&
        frame.ownerDocument.activeElement === frame &&
        appFramePaneFocused(frame),
      )
    const config = () =>
      frame?.contentWindow?.postMessage(
        {
          type: 'holi:vim-app-config',
          nonce: lease?.nonce,
          enabled: eligible(),
        },
        '*',
      )
    config()
    const changed = () => {
      adapter?.invalidate?.()
      config()
    }
    const blurred = () => {
      adapter?.invalidate?.()
      frame?.contentWindow?.postMessage(
        { type: 'holi:vim-app-config', nonce: lease?.nonce, enabled: false },
        '*',
      )
    }
    window.addEventListener('focusin', changed, true)
    window.addEventListener('pointerdown', changed, true)
    window.addEventListener('blur', blurred)
    window.addEventListener('focus', changed)
    document.addEventListener('visibilitychange', changed)
    const observer = new MutationObserver((records) => {
      const ownedByHintLayer = (node: Node) =>
        node instanceof Element &&
        (node.matches('[data-host-hints]') || !!node.closest('[data-host-hints]'))
      const relevant = records.some((record) => {
        if (record.type === 'childList') {
          if (ownedByHintLayer(record.target)) return false
          const changedNodes = [...record.addedNodes, ...record.removedNodes]
          return changedNodes.some((node) => !ownedByHintLayer(node))
        }
        return !ownedByHintLayer(record.target)
      })
      if (!relevant) return
      adapter?.invalidate?.()
      config()
    })
    if (frame?.ownerDocument.body)
      observer.observe(frame.ownerDocument.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['data-pane-focused', 'hidden', 'inert', 'aria-hidden'],
      })
    return () => {
      disposed = true
      unregister?.()
      adapter?.dispose()
      window.removeEventListener('focusin', changed, true)
      window.removeEventListener('pointerdown', changed, true)
      window.removeEventListener('blur', blurred)
      window.removeEventListener('focus', changed)
      document.removeEventListener('visibilitychange', changed)
      observer.disconnect()
      frame?.contentWindow?.postMessage(
        { type: 'holi:vim-app-config', nonce: lease?.nonce, enabled: false },
        '*',
      )
    }
  }, [frame, lease, remote, bundle, visible, gateOpen, loaded, activeRemote, store, vimEnabled])
}
