/**
 * Whether the vault's GitHub panel is open.
 *
 * An atom rather than `useState` in `Shell` because two things open it now: the
 * sidebar's own control, and the settings tab (#16), which is a sibling of the
 * pane state rather than a child of the shell. Identity and membership are not
 * preferences, so they keep their own read-only panel — this is the door
 * between the two, so that a gear does not come to mean two different things.
 */
import { atom } from 'jotai'

export const vaultPanelOpenAtom = atom(false)
