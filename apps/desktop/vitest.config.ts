import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
    // One fork, one file at a time.
    //
    // The vault suites are not CPU-bound, they are *event*-bound: they wait on real
    // chokidar deliveries and a real Hocuspocus relay over a real socket. Run 25 files
    // across N workers and those waits compete with everyone else for CPU, so a
    // delivery that normally lands in milliseconds blows past an 8s wait and the suite
    // goes red for reasons with nothing to do with the code under test. That is what
    // made vault-mirror.test.ts flake about one run in four.
    //
    // Serialising costs nothing, measured: 9s either way, five runs each. The suite was
    // never CPU-bound, so taking the parallelism away removes the starvation without
    // removing any speed — the waits were always the wall clock.
    //
    // Do NOT "fix" a future flake here by widening the waits. Measure first: both
    // chokidar theories in this repo that looked obvious were wrong (4b023b4 — a file
    // that lives for milliseconds is delivered as NOTHING AT ALL, and usePolling makes
    // it worse, not better).
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
})
