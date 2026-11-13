/** Guards selected-vault work against switches and runtime replacement. */
export function createSelectedRuntimeGate<T>(deps: {
  selected(): { remote: string } | null
  get(remote: string): T | null
}) {
  return {
    capture(remote: string): T | null {
      const selected = deps.selected()
      if (selected?.remote !== remote) return null
      const runtime = deps.get(remote)
      return runtime !== null && runtime === selected ? runtime : null
    },
    isCurrent(remote: string, runtime: T): boolean {
      const selected = deps.selected()
      return selected?.remote === remote && selected === runtime && deps.get(remote) === runtime
    },
    run(remote: string, work: (runtime: T) => void): void {
      const runtime = this.capture(remote)
      if (runtime !== null) work(runtime)
    },
  }
}
