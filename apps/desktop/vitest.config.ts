import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
    // One file at a time — do NOT let test files run in parallel.
    //
    // Kept through the D60 deletion even though the suites that forced it (the mirror
    // and bridge tests) are gone, because the cause is coming straight back: the vault
    // store is a chokidar watcher, and watcher suites are *event*-bound, not CPU-bound.
    // Parallel forks contend for the fsevents backend and the event loop, so an `add`
    // that normally lands in ~200ms blows past an 8s wait and the suite goes red for
    // reasons with nothing to do with the code under test. Measured then: ~1-in-3
    // failures parallel, 0-in-N serialised. Pure CPU load barely moved the rate.
    //
    // fileParallelism: false is the Vitest 4 lever (it pins maxWorkers to 1). BEWARE:
    // the Vitest 3 form — `poolOptions: { forks: { singleFork: true } }` — is SILENTLY
    // IGNORED by Vitest 4 (deprecation warning, key discarded). This suite carried that
    // dead form for two sessions and ran fully parallel the whole time; that is what
    // made the flake "come back".
    //
    // The matching *production* lesson, for whoever rebuilds the watcher: fsevents can
    // genuinely drop an add/unlink (measured — the raw event never fires), so the store
    // must self-heal on a timer rather than trust event delivery for correctness.
    //
    // Do NOT "fix" a future flake by widening the waits. Measure first: both chokidar
    // theories in this repo that looked obvious were wrong (4b023b4 — a file that lives
    // for milliseconds is delivered as NOTHING AT ALL, and usePolling makes it worse).
    fileParallelism: false,
  },
})
