/**
 * A folder document as a plugin claims one, for core's tree and tab tests:
 * a `<name>.app` folder is one document once it has its `index.html`,
 * finished once `app.yaml` is there, as vault apps' claim says. Core's
 * behaviour is what is under test, so the claim is written out here rather
 * than imported from the plugin.
 */
import { vi } from 'vitest'
import { AppWindow } from 'lucide-react'
import { CORE_CONTRIBUTION } from '@/components/core-surfaces'
import type { PathClaim, Surface } from '@/plugin-api/types'
import type { CoreContribution } from '@/state/plugins'

const SUFFIX = '.app'
const ENTRY = 'index.html'
const MANIFEST = 'app.yaml'

const isBundle = (path: string): boolean => {
  const name = path.split('/').pop() ?? ''
  return name.endsWith(SUFFIX) && name.length > SUFFIX.length
}

const nameOf = (path: string): string => (path.split('/').pop() ?? path).slice(0, -SUFFIX.length)

/** What the claim's New App runs: it resolves to the entry it made. */
export const createFolderDocument = vi.fn(
  async ({ parent, name }: { remote: string; parent: string; name: string }) =>
    `${parent === '' ? '' : `${parent}/`}${name}${SUFFIX}/${ENTRY}`,
)

/** What its "Finish this app" runs. */
export const finishFolderDocument = vi.fn()

const SURFACE: Surface = {
  kind: 'app',
  label: (id) => (id === undefined ? 'App' : nameOf(id)),
  icon: AppWindow,
  render: () => null,
}

const CLAIM: PathClaim = {
  match: isBundle,
  folder: { surface: 'app', entry: ENTRY, ready: (path, has) => has(`${path}/${MANIFEST}`) },
  decorate: { icon: AppWindow, name: nameOf, suffix: () => SUFFIX },
  rowMenu: [
    {
      label: 'Finish this app',
      when: (path, snapshot) => !snapshot.files.some((f) => f.path === `${path}/${MANIFEST}`),
      run: finishFolderDocument,
    },
  ],
  create: {
    id: 'app',
    label: 'New App',
    icon: AppWindow,
    placeholder: 'app name',
    run: createFolderDocument,
  },
}

/** Core's own contribution, with the folder document's surface and claim. */
export const WITH_FOLDER_DOCUMENTS: CoreContribution = {
  ...CORE_CONTRIBUTION,
  surfaces: [...CORE_CONTRIBUTION.surfaces, SURFACE],
  claims: [...CORE_CONTRIBUTION.claims, CLAIM],
}
