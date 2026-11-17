type Operation = 'query' | 'mutate'
type Endpoint = {
  query?: (input?: unknown) => Promise<any>
  mutate?: (input?: unknown) => Promise<any>
}

const endpoint = (path: string): Endpoint => ({
  query: (input) => window.holiSmoke.call('smoke:trpc', { path, operation: 'query', input }),
  mutate: (input) => window.holiSmoke.call('smoke:trpc', { path, operation: 'mutate', input }),
})

function tree(prefix = ''): any {
  return new Proxy(
    {},
    {
      get(_target, key) {
        if (key === 'query' || key === 'mutate') return endpoint(prefix)[key as Operation]
        const path = prefix ? `${prefix}.${String(key)}` : String(key)
        return tree(path)
      },
    },
  )
}

export const trpc = tree()

declare global {
  interface Window {
    holiSmoke: { call(channel: string, input?: unknown): Promise<any> }
  }
}
