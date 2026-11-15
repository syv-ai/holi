export type OpenIntent =
  | { channel: 'vault:open'; remote: string; path: string; heading?: string; focus?: false }
  | {
      channel: 'vault:navigate'
      remote: string
      plugin: string
      name: string
      payload: unknown
    }

/** Holds intents until the renderer is ready, preserving arrival order across channels. */
export function createOpenIntentQueue() {
  const held: OpenIntent[] = []

  return {
    send(intent: OpenIntent, ready: boolean, dispatch: (intent: OpenIntent) => void): void {
      if (ready) dispatch(intent)
      else held.push(intent)
    },
    drain(dispatch: (intent: OpenIntent) => void): void {
      for (const intent of held.splice(0)) dispatch(intent)
    },
  }
}
