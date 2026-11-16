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

/** Offline sync is best-effort after required local drains; own the budget timer
 * and observe even a rejection arriving after that budget has elapsed. */
export async function settleVaultForQuit(
  vault: {
    commitNow(): Promise<unknown>
    pushNow(): Promise<unknown>
  } | null,
): Promise<void> {
  if (vault === null) return
  await vault.commitNow().catch((err: unknown) => console.error('[quit] commit failed:', err))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve()
        .then(() => vault.pushNow())
        .catch((err: unknown) => console.error('[quit] push failed:', err)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1_000)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
