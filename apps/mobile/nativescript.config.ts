import type { NativeScriptConfig } from '@nativescript/core'

export default {
  id: 'ai.syv.holi.compatibility',
  appPath: 'app',
  cli: { packageManager: 'pnpm' },
  appResourcesPath: 'App_Resources',
  ios: { discardUncaughtJsExceptions: false },
} satisfies NativeScriptConfig
