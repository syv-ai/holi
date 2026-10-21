/**
 * The links drawer: both directions of the focused note's wiki-links
 * (`docs/features/wiki-links.md`). It follows the same focused markdown tab as
 * the history drawer, and asks main again whenever the vault changes on disk:
 * there is no link index to keep current, only a grep per ask.
 */
import { atom } from 'jotai'
import { trpc } from '../lib/trpc'

export type NoteLinks = Awaited<ReturnType<typeof trpc.notes.links.query>>

export const linksOpenAtom = atom(false)
