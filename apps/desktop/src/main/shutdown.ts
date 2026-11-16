/** Run the app's irreversible shutdown steps in order. A failed drain stops the
 * sequence so the updater, vault and bridge remain available for a retry. */
export async function drainShutdown(steps: {
  stopBackground(): Promise<void>
  stopPlugins(): Promise<void>
  closeTerminals(): Promise<void>
  disposeUpdater(): void
  settleVault(): Promise<void>
  closeVaults(): Promise<void>
  closeBridge(): Promise<void>
}): Promise<void> {
  await steps.stopBackground()
  await steps.stopPlugins()
  await steps.closeTerminals()
  steps.disposeUpdater()
  await steps.settleVault()
  await steps.closeVaults()
  await steps.closeBridge()
}
