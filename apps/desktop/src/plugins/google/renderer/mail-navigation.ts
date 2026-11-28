import { atom } from 'jotai'

interface MailNavigationRequest {
  id: number
  remote: string
  mailbox: 'inbox'
}

const sequenceAtom = atom(0)

/** A native notice can arrive before Mail has ever mounted; keep the request until it does. */
export const mailNavigationRequestAtom = atom<MailNavigationRequest | null>(null)

export const requestMailNavigationAtom = atom(
  null,
  (get, set, request: Omit<MailNavigationRequest, 'id'>): void => {
    const id = get(sequenceAtom) + 1
    set(sequenceAtom, id)
    set(mailNavigationRequestAtom, { ...request, id })
  },
)

export const consumeMailNavigationAtom = atom(null, (get, set, id: number): void => {
  if (get(mailNavigationRequestAtom)?.id === id) set(mailNavigationRequestAtom, null)
})
