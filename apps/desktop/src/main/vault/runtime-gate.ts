/** Guards vault work against runtime replacement, independently of UI selection. */
export function createRuntimeGate<T>(deps: { get(remote: string): T | null }) {
  return {
    capture(remote: string): T | null {
      return deps.get(remote)
    },
    isCurrent(remote: string, runtime: T): boolean {
      return deps.get(remote) === runtime
    },
    run(remote: string, work: (runtime: T) => void): void {
      const runtime = this.capture(remote)
      if (runtime !== null) work(runtime)
    },
  }
}
