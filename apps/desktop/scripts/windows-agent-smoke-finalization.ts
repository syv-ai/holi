import { writeFileSync } from 'node:fs'

/** Join the fixture and its cleanup before sealing its report and exiting.
 * Closing the last window can queue Electron's implicit quit: no asynchronous
 * work may separate that close, report publication and the explicit exit. */
export async function finalizeElectronSmoke(options: {
  run(): Promise<Readonly<Record<string, unknown>>>
  cleanup(): Promise<void>
  closeWindow(): void
  exit(code: number): void
  reportPath: string
}): Promise<void> {
  const failures = new Set<unknown>()
  let report: Readonly<Record<string, unknown>> | undefined
  try {
    report = await options.run()
  } catch (error) {
    failures.add(error)
  }
  try {
    await options.cleanup()
  } catch (error) {
    failures.add(error)
  }
  try {
    options.closeWindow()
  } catch (error) {
    failures.add(error)
  }
  if (failures.size) throw new AggregateError([...failures], 'Dependency Electron smoke failed')
  writeFileSync(options.reportPath, JSON.stringify(report), { flag: 'wx' })
  options.exit(0)
}
