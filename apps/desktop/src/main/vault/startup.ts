export type RegisteredVault = { remote: string }

/** Run the ordinary cold preparation and plugin-open path without selecting a vault. */
export async function startRegisteredVaults<T>(
  remotes: readonly RegisteredVault[],
  start: (remote: string) => Promise<T>,
  failed: (remote: string, error: unknown) => void,
): Promise<void> {
  for (const { remote } of remotes) {
    try {
      await start(remote)
    } catch (error) {
      failed(remote, error)
    }
  }
}
