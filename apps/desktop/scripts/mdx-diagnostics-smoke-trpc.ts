const call = (channel: string) => ({
  mutate: (input: unknown) => window.holiSmoke.call(channel, input),
})

export const trpc = {
  mdxTrust: {
    acquireDiagnosticsLease: call('mdx:acquire'),
    cancelCompile: call('mdx:cancel'),
    compile: call('mdx:compile'),
    releaseDiagnosticsLease: call('mdx:release'),
  },
}

declare global {
  interface Window {
    holiSmoke: {
      call(channel: string, input: unknown): Promise<any>
      trust(value: boolean): Promise<unknown>
    }
  }
}
