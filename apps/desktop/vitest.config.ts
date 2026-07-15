import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
    // One file at a time — do NOT let test files run in parallel.
    //
    // The vault suites are not CPU-bound, they are *event*-bound: they wait on real
    // chokidar (fsevents) deliveries and a real Hocuspocus relay over a real socket.
    // Run files in parallel forks and those forks contend for the fsevents backend and
    // the event loop, so a chokidar `add` that normally lands in ~200ms blows past the
    // 8s wait and the suite goes red for reasons with nothing to do with the code under
    // test. Measured: with parallel files under fs-event load, vault-mirror.test.ts
    // fails ~1-in-3 ("timeout waiting for: createNote called"); serialised, 0-in-N.
    // Pure CPU load barely moves the rate — it is fsevents/event-loop contention
    // between concurrent watching forks, not CPU starvation.
    //
    // fileParallelism: false is the Vitest 4 lever (it pins maxWorkers to 1). BEWARE:
    // the Vitest 3 form for this — `poolOptions: { forks: { singleFork: true } }` — is
    // SILENTLY IGNORED by Vitest 4 (it only prints a deprecation warning and discards
    // the key). This suite carried that dead form for two sessions and ran fully
    // parallel the whole time; that is what made the flake "come back". spikes/bridge
    // already uses fileParallelism: false — keep them in step.
    //
    // Do NOT "fix" a future flake here by widening the waits. Measure first: both
    // chokidar theories in this repo that looked obvious were wrong (4b023b4 — a file
    // that lives for milliseconds is delivered as NOTHING AT ALL, and usePolling makes
    // it worse, not better).
    fileParallelism: false,
  },
})
