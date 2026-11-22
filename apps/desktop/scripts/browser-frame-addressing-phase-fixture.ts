import type { WebContents } from 'electron'
import { fixtureFrames, waitForFixtureFrames } from './browser-frame-addressing-fixture'

export type Check = (condition: unknown, name: string) => asserts condition
export type PhaseInput = { contents: WebContents; port: number; check: Check }

export const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

export async function resetFixture(contents: WebContents, port: number): Promise<void> {
  await contents.loadURL(`http://127.0.0.1:${port}/`)
  await waitForFixtureFrames(() => fixtureFrames(contents), 5)
}
