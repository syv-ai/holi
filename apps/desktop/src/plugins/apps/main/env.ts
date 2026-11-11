/**
 * An app's secrets: the vault's `.env`, with `.env.local` winning, read fresh
 * on each call by core's one reader (`main/vault/dotenv.ts`), so a hand edit
 * applies at once and the parsing has one owner. An app gets only the names
 * its `app.yaml` lists under `env` (docs/features/vault-apps.md). Holi never
 * writes these files: they are the person's, and local (`isSecretPath`).
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import {
  CapabilityError,
  cap,
  paramsObject,
  readVaultEnv,
  stringParam,
} from '../../../main/plugin-api'
import { ENV_NAME } from '../shared/manifest'
import { manifestOf } from './grants'

export const ENV_NAMESPACES = ['env'] as const

export const envCapabilities = () => ({
  /** One secret the calling app declared, or null when the vault has no
   *  value for it. The app door only: the agent reads files itself. */
  'env.get': cap({
    doors: ['app'],
    params: (raw) => {
      const name = stringParam(paramsObject(raw), 'name')
      if (!ENV_NAME.test(name)) throw new CapabilityError('BAD_REQUEST', `not a name: ${name}`)
      return { name }
    },
    run: async (ctx, { name }): Promise<string | null> => {
      const bundle = ctx.bundle
      if (bundle === null || bundle === undefined) {
        throw new CapabilityError('FORBIDDEN', 'only an app has secrets')
      }
      const declared = (await manifestOf(ctx.root, bundle))?.env ?? []
      if (!declared.includes(name)) {
        throw new CapabilityError('FORBIDDEN', `${name} is not in this app's env in app.yaml`)
      }
      return (await readVaultEnv(ctx.root))[name] ?? null
    },
  }),
})
