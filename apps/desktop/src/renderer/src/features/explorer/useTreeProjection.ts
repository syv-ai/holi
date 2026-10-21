import { useMemo } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { isHiddenPath } from '@holi/shared'
import { claimsAtom, pathMarksAtom } from '@/state/plugins'
import { revealRequestAtom } from '@/state/reveal'
import {
  activeRemoteAtom,
  showHiddenByVaultAtom,
  shownClaimsByVaultAtom,
  snapshotAtom,
} from '@/state/vaults'

/**
 * The snapshot as the explorer shows it: hidden files, and the files of a
 * hideable claim (task files), filtered by the per-vault toggles, plus the per-path facts a row paints (icon, what plugins
 * mark it with, ignored).
 * Claimed files show as the files they are, a broken one too, so it can be
 * opened and fixed; a hideable claim's toggle hides its files.
 * The tree data itself is built by the caller, which adds the folders still
 * being named (they live in the explorer actions, which need `docPaths`).
 */
export function useTreeProjection() {
  const snapshot = useAtomValue(snapshotAtom)
  const activeRemote = useAtomValue(activeRemoteAtom)
  const revealPath = useAtomValue(revealRequestAtom)?.path ?? null
  const [hiddenByVault, setHiddenByVault] = useAtom(showHiddenByVaultAtom)
  const [shownByVault, setShownByVault] = useAtom(shownClaimsByVaultAtom)
  const showHidden = activeRemote !== null && hiddenByVault[activeRemote] === true
  const claims = useAtomValue(claimsAtom)
  /** Each hideable claim, and whether the tree shows its files now. */
  const hideables = useMemo(() => {
    const shown = new Set(activeRemote === null ? [] : (shownByVault[activeRemote] ?? []))
    return claims.flatMap((claim) =>
      claim.hideable === undefined
        ? []
        : [{ claim, ...claim.hideable, shown: shown.has(claim.hideable.label) }],
    )
  }, [claims, shownByVault, activeRemote])

  /** Every path the explorer can act on, for the explorer actions. */
  const docPaths = useMemo(
    () => [
      ...snapshot.docs.map((d) => d.path),
      ...snapshot.files.map((f) => f.path),
      ...Object.values(snapshot.claimed)
        .flatMap((set) => [...set.items.map((i) => i.path), ...set.broken.map((b) => b.path)])
        .filter((p) => !hideables.some((h) => !h.shown && h.claim.match(p))),
    ],
    [snapshot, hideables],
  )
  // Machine-local files show like any other: `.local.` means "does not sync",
  // not "hide from me", and git's dim already marks them.
  const visible = useMemo(() => {
    const paths = showHidden
      ? docPaths
      : docPaths.filter((p) => p === revealPath || !isHiddenPath(p))
    const dirs = showHidden ? snapshot.dirs : snapshot.dirs.filter((d) => !isHiddenPath(d))
    return { paths, dirs }
  }, [docPaths, snapshot.dirs, showHidden, revealPath])

  const marks = useAtomValue(pathMarksAtom)
  const iconByPath = useMemo(() => new Map(Object.entries(snapshot.icons)), [snapshot.icons])
  const ignored = useMemo(() => new Set(snapshot.ignored), [snapshot.ignored])

  return {
    docPaths,
    visible,
    marks,
    iconByPath,
    ignored,
    showHidden,
    hideables,
    toggleHidden: () =>
      activeRemote !== null && setHiddenByVault({ ...hiddenByVault, [activeRemote]: !showHidden }),
    /** Show or hide the files of the hideable claim named `label`. */
    toggleClaimed: (label: string) => {
      if (activeRemote === null) return
      const shown = shownByVault[activeRemote] ?? []
      setShownByVault({
        ...shownByVault,
        [activeRemote]: shown.includes(label)
          ? shown.filter((l) => l !== label)
          : [...shown, label],
      })
    },
  }
}
