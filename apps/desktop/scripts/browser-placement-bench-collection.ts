import { cpus, loadavg, totalmem, freemem } from 'node:os'
import { app, type BrowserWindow, type WebContentsView } from 'electron'
import { oneCorePercent } from './browser-placement-bench-analysis.mjs'

export function createBenchmarkSampling({
  win,
  allPageIds,
  allPagePids,
  placementMessages,
}: {
  win: BrowserWindow
  allPageIds: Set<number>
  allPagePids: Set<number>
  placementMessages: { count: number }
}) {
  const previousCpu = new Map<number, { cumulative: number; at: number }>()
  return async (trial: string, phase: string) => {
    const logicalCpuCount = cpus().length
    const sampledAt = performance.now()
    const views = win.contentView.children as WebContentsView[]
    for (const view of views) {
      allPageIds.add(view.webContents.id)
      allPagePids.add(view.webContents.getOSProcessId())
    }
    const appMetrics = app.getAppMetrics().map((item) => ({
      type: item.type,
      pid: item.pid,
      cpu: {
        ...item.cpu,
        rawMachinePercentCPUUsage: item.cpu.percentCPUUsage,
        oneCorePercentCPUUsage: oneCorePercent(item.cpu.percentCPUUsage, logicalCpuCount),
      },
      memory: item.memory,
    }))
    const tasks: unknown[] = []
    try {
      if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3')
      await win.webContents.debugger.sendCommand('Performance.enable')
      const hostMetrics = (await win.webContents.debugger.sendCommand(
        'Performance.getMetrics',
      )) as {
        metrics?: { name: string; value: number }[]
      }
      tasks.push({
        role: 'host-renderer',
        webContentsId: win.webContents.id,
        metrics: hostMetrics.metrics?.filter((m) =>
          ['TaskDuration', 'LayoutDuration', 'RecalcStyleDuration'].includes(m.name),
        ),
      })
    } catch {
      tasks.push({ role: 'host-renderer', unavailable: true })
    }
    const shellDiagnostics = await win.webContents.executeJavaScript(
      `({ hostPid:${win.webContents.getOSProcessId()}, focused:${win.isFocused()}, minimized:${win.isMinimized()}, visibilityState:document.visibilityState, visibilityEpoch:window.__placementVisibilityEpoch, stats: window.__placementBenchStats ?? null, hosts: [...document.querySelectorAll('[data-browser-tab] > div:last-child')].map((el) => { const r = el.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height } }), overlays: [...document.body.children].filter((el) => el.matches('[role="dialog"], [role="alertdialog"], [data-radix-popper-content-wrapper], [data-slot$="-overlay"]')).map((el) => { const r=el.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height } }) })`,
    )
    for (const view of win.contentView.children as WebContentsView[]) {
      if (view.webContents.isDestroyed()) continue
      try {
        if (!view.webContents.debugger.isAttached()) view.webContents.debugger.attach('1.3')
        await view.webContents.debugger.sendCommand('Performance.enable')
        const result = (await view.webContents.debugger.sendCommand('Performance.getMetrics')) as {
          metrics?: { name: string; value: number }[]
        }
        tasks.push({
          role: 'browser-page',
          webContentsId: view.webContents.id,
          metrics: result.metrics?.filter((m) =>
            ['TaskDuration', 'LayoutDuration', 'RecalcStyleDuration'].includes(m.name),
          ),
        })
      } catch {
        tasks.push({ unavailable: true })
      }
    }
    const cpuCrossCheck = appMetrics.map((item) => {
      const prior = previousCpu.get(item.pid)
      const cumulative = item.cpu.cumulativeCPUUsage
      if (cumulative !== undefined) previousCpu.set(item.pid, { cumulative, at: sampledAt })
      return {
        pid: item.pid,
        cumulativeCpuSeconds: cumulative ?? null,
        wallSecondsSincePrior:
          prior && cumulative !== undefined ? (sampledAt - prior.at) / 1000 : null,
        deltaCpuSeconds: prior && cumulative !== undefined ? cumulative - prior.cumulative : null,
        deltaOneCorePercent:
          prior && cumulative !== undefined && sampledAt > prior.at
            ? ((cumulative - prior.cumulative) / ((sampledAt - prior.at) / 1000)) * 100
            : null,
      }
    })
    const observation = {
      at: new Date().toISOString(),
      system: {
        loadAverage: loadavg(),
        totalMemoryBytes: totalmem(),
        freeMemoryBytes: freemem(),
        logicalCpuCount,
      },
      trial,
      mainPid: process.pid,
      pagePids: [...allPagePids],
      pageWebContentsIds: [...allPageIds],
      phase,
      appMetrics,
      cpuCrossCheck,
      taskMetrics: tasks,
      shellDiagnostics,
      nativeBounds: (win.contentView.children as WebContentsView[]).map((view) => ({
        id: view.webContents.id,
        ...view.getBounds(),
      })),
      placementMessages: placementMessages.count,
      viewCount: win.contentView.children.length,
    }
    return {
      observation,
      snapshot: {
        condition: {
          focused: win.isFocused(),
          visible: win.isVisible() && shellDiagnostics.visibilityState === 'visible',
          minimized: win.isMinimized(),
        },
        stats: shellDiagnostics.stats,
        visibilityEpoch: shellDiagnostics.visibilityEpoch,
      },
    }
  }
}
