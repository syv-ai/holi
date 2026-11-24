import { randomBytes } from 'node:crypto'
import { MDX_RESOURCE_PURPOSE, type MdxExternalResourceState } from '@holi/shared'
import type { MdxConsentStore } from './mdx-consent'

// Main supplies the verified account, canonical remote and canonical clone root.
type Scope = Parameters<MdxConsentStore['listGrants']>[0]
type Owner = {
  current(): boolean
  recheck(): Promise<boolean>
  generation(): number
  graphCurrent(): boolean
  abortCompile(): void
}
type Offer = {
  origin: string
  discoveryOrigins: Set<string>
}
type Member = {
  owner: Owner
  offers: Map<string, Offer>
  grantIds: Map<string, string>
}
type ScopedConsent = {
  members: Set<Member>
  grantRevision: number
  approvals: Set<string>
  changed: boolean
}

const opaqueId = () => randomBytes(32).toString('hex')
const ownerKey = (scope: Scope) => JSON.stringify([scope.root, scope.remote, scope.accountId])

/** One coordinator per diagnostics root. Each lease attaches once and closes on retirement.
 * The lease owns file, document, trust and graph checks; the store owns durable grants and
 * captured revocations (which must outlive both a lease and its scope's membership). */
export function createMdxConsentCoordinator(external?: {
  consent: MdxConsentStore
  changed?(remote: string): void
}) {
  const scopes = new Map<string, ScopedConsent>()
  const unsubscribe = external?.consent.onRevocationSaved((scope) => {
    const scoped = scopes.get(ownerKey(scope))
    if (!scoped) return
    // Retire IDs in every split before a replacement can be approved, including
    // when shutdown saves a blocked removal and then resumes admission.
    // A read spanning this publication must not recreate a retired ID.
    scoped.grantRevision++
    for (const member of scoped.members) {
      for (const [id, origin] of member.grantIds) {
        if (origin === scope.origin) member.grantIds.delete(id)
      }
    }
  })
  return {
    close() {
      unsubscribe?.()
    },
    attach(scope: Scope, owner: Owner) {
      const key = ownerKey(scope)
      const scoped = scopes.get(key) ?? {
        members: new Set<Member>(),
        grantRevision: 0,
        approvals: new Set<string>(),
        changed: false,
      }
      scopes.set(key, scoped)
      const member: Member = { owner, offers: new Map(), grantIds: new Map() }
      scoped.members.add(member)
      const releaseScope = () => {
        if (scoped.members.size === 0 && scoped.approvals.size === 0) scopes.delete(key)
      }
      const assertOwner = () => {
        if (!owner.current()) throw new Error('MDX lease unavailable')
      }
      const grantChanged = (origin: string, change: 'approval' | 'revocation') => {
        scoped.grantRevision++
        for (const other of scoped.members) {
          other.owner.abortCompile()
          for (const [id, offer] of other.offers) {
            // Deleting the offer also retires any admitted approval of it. An independent
            // offer, even from another split, can still finish its atomic publication.
            if (
              offer.origin === origin ||
              (change === 'revocation' && offer.discoveryOrigins.has(origin))
            )
              other.offers.delete(id)
          }
        }
        // A push triggers compiles in all splits. Wait until admitted approvals finish
        // so their still-current offers aren't retired by an unrelated decision.
        if (scoped.approvals.size) scoped.changed = true
        else external?.changed?.(scope.remote)
      }
      return {
        newSource() {
          // Use publication identity, not the renderer's generation number (which can be
          // reused). Private discoveries don't become offers until a current compile ends.
          const empty = new Map<string, Offer>()
          member.offers = empty
          const discoveries = new Map<string, ReadonlySet<string>[]>()
          return {
            discover(origin: string, through: ReadonlySet<string>) {
              // Inspection finishes adding provenance from cached paths before publication.
              const paths = discoveries.get(origin) ?? []
              paths.push(through)
              discoveries.set(origin, paths)
            },
            publish() {
              if (member.offers !== empty) return
              const offers = new Map<string, Offer>()
              for (const [origin, paths] of discoveries) {
                const discoveryOrigins = new Set<string>()
                // One offer represents all discoveries for an origin. Revoke it if any
                // reviewed path depended on the revoked origin.
                for (const path of paths) for (const hop of path) discoveryOrigins.add(hop)
                offers.set(opaqueId(), { origin, discoveryOrigins })
              }
              member.offers = offers
            },
          }
        },
        async list(): Promise<MdxExternalResourceState> {
          assertOwner()
          const revision = scoped.grantRevision
          const offers = member.offers
          const grants = await (external?.consent.listGrants(scope).catch(() => {
            throw new Error('Could not read MDX resource grants')
          }) ?? [])
          if (!(await owner.recheck()) || scoped.grantRevision !== revision || !owner.current())
            throw new Error('MDX context changed')

          // A source retirement cannot invalidate an unchanged grant list or its Revoke
          // actions. It only suppresses pending offers from a superseded publication.
          const ids = new Map([...member.grantIds].map(([id, origin]) => [origin, id]))
          const approved = grants.map<MdxExternalResourceState['approved'][number]>((grant) => ({
            ...grant,
            id: ids.get(grant.origin) ?? opaqueId(),
            purpose: MDX_RESOURCE_PURPOSE,
          }))
          member.grantIds = new Map(approved.map(({ id, origin }) => [id, origin]))
          const blocked = new Set(
            grants.filter((grant) => grant.revocationPending).map((grant) => grant.origin),
          )
          return {
            generation: owner.generation(),
            pending:
              offers === member.offers && owner.graphCurrent()
                ? [...offers].flatMap(([id, { origin }]) =>
                    blocked.has(origin) ? [] : [{ id, origin, purpose: MDX_RESOURCE_PURPOSE }],
                  )
                : [],
            approved,
          }
        },
        async approve(id: string): Promise<{ ok: true }> {
          assertOwner()
          const offer = member.offers.get(id)
          if (!external || !offer || !owner.graphCurrent())
            throw new Error('MDX resource request unavailable')
          const { origin } = offer
          if (scoped.approvals.has(origin))
            throw new Error('MDX resource approval already in progress')
          scoped.approvals.add(origin)
          const stillOwned = () =>
            member.offers.get(id) === offer && owner.current() && owner.graphCurrent()
          try {
            if (!(await owner.recheck()) || !stillOwned()) throw new Error('MDX context changed')
            await external.consent.grant({ ...scope, origin }, stillOwned).catch(() => {
              throw new Error(
                stillOwned()
                  ? 'Could not save MDX resource approval'
                  : 'MDX resource request unavailable',
              )
            })
            // The store published atomically while owned, even if the view has since retired.
            grantChanged(origin, 'approval')
            return { ok: true }
          } finally {
            scoped.approvals.delete(origin)
            releaseScope()
            if (scoped.approvals.size === 0 && scoped.changed) {
              scoped.changed = false
              external.changed?.(scope.remote)
            }
          }
        },
        reject(id: string): { ok: true } {
          assertOwner()
          if (!owner.graphCurrent() || !member.offers.delete(id))
            throw new Error('MDX resource request unavailable')
          return { ok: true }
        },
        async revoke(id: string): Promise<{ ok: true }> {
          assertOwner()
          const origin = member.grantIds.get(id)
          if (!external || !origin) throw new Error('MDX resource grant unavailable')
          // Deny and abort synchronously. The store captures the removal even if saving
          // fails or the owner disappears. Keep the same grant ID for an explicit retry.
          const removal = external.consent.revoke({ ...scope, origin })
          grantChanged(origin, 'revocation')
          await removal.catch(() => {
            throw new Error(
              'MDX resource access was blocked for this run, but revocation could not be saved',
            )
          })
          return { ok: true }
        },
        close() {
          member.offers = new Map()
          member.grantIds.clear()
          scoped.members.delete(member)
          releaseScope()
        },
      }
    },
  }
}
