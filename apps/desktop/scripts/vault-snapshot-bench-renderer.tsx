import { useLayoutEffect, useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import { createStore, Provider, useAtomValue } from 'jotai'
import {
  subscribeToVault,
  snapshotAtom,
  activeRemoteAtom,
  snapshotLoadedAtom,
} from '../src/renderer/src/state/vaults'
import { snapshotTasksAtom, tasksAtom } from '../src/renderer/src/state/tasks'
import { FilesSection } from '../src/renderer/src/features/sidebar/files-section'
import { DocumentView } from '../src/renderer/src/features/documents/document-view'
import { PlanningView } from '../src/renderer/src/features/planning/planning-view'
import { SidebarProvider } from '../src/renderer/src/components/ui/sidebar'
import { TooltipProvider } from '../src/renderer/src/components/ui/tooltip'
import '../src/renderer/src/index.css'

const store = createStore()
store.set(activeRemoteAtom, 'bench/snapshot')
let atomWrites = 0
let derivedComputations = 0
let commits = 0
let treeItems = 0
let taskCount = 0
let documentText = ''
let consumerReady = false
let resolveReady!: (ready: boolean) => void
let resolveDataReady!: (ready: boolean) => void
const ready = new Promise<boolean>((resolve) => (resolveReady = resolve))
const dataReady = new Promise<boolean>((resolve) => (resolveDataReady = resolve))

function BenchConsumers() {
  const snapshot = useAtomValue(snapshotAtom)
  const loaded = useAtomValue(snapshotLoadedAtom)
  const taskRows = useAtomValue(snapshotTasksAtom)
  const tasks = useAtomValue(tasksAtom)
  const derivedTreeItems = useMemo(() => {
    derivedComputations++
    return snapshot.docs.length + snapshot.files.length + snapshot.dirs.length
  }, [snapshot])
  const derivedTaskCount = useMemo(() => {
    derivedComputations++
    return taskRows.items.length
  }, [taskRows])
  useLayoutEffect(() => {
    commits++
    resolveReady(true)
    treeItems = derivedTreeItems
    taskCount = derivedTaskCount
    const editor = document.querySelector('[contenteditable="true"].tiptap')
    const task = document.querySelector('[data-bench-task]')
    const taskText = task?.textContent ?? ''
    documentText = editor?.textContent ?? ''
    if (
      loaded &&
      editor &&
      documentText.includes('Deterministic fixture body 0.') &&
      taskText.includes('Task 0')
    ) {
      consumerReady = true
      resolveDataReady(true)
    }
  }, [loaded, derivedTaskCount, derivedTreeItems, snapshot])
  return (
    <main className="flex h-screen gap-3 overflow-hidden p-2">
      <aside className="w-64 shrink-0">
        <SidebarProvider>
          <FilesSection activeId={null} onOpen={() => undefined} onMoved={() => undefined} />
        </SidebarProvider>
      </aside>
      <section className="min-w-0 flex-1">
        <DocumentView path="nested/000/note-0.md" onOpen={() => undefined} focused={false} />
      </section>
      <section className="min-w-0 flex-1" data-bench-task>
        <PlanningView onOpenTask={() => undefined} focused={false} />
        {tasks.size > 0 && <output>{[...tasks.values()][0]?.title}</output>}
      </section>
    </main>
  )
}

const unsubs = [
  store.sub(snapshotAtom, () => {
    atomWrites++
  }),
]
const offVault = subscribeToVault(store)
const tree = createRoot(document.getElementById('root')!)
window.snapshotBench = {
  ready,
  dataReady,
  metrics: () => ({
    atomWrites,
    derivedComputations,
    commits,
    treeItems,
    taskCount,
    documentText,
    consumerReady,
  }),
  resetMetrics: () => {
    atomWrites = 0
    derivedComputations = 0
    commits = 0
  },
  dispose: () => {
    offVault()
    unsubs.forEach((off) => off())
    tree.unmount()
  },
}
tree.render(
  <Provider store={store}>
    <TooltipProvider>
      <BenchConsumers />
    </TooltipProvider>
  </Provider>,
)

declare global {
  interface Window {
    snapshotBench: {
      ready: Promise<boolean>
      dataReady: Promise<boolean>
      metrics: () => {
        atomWrites: number
        derivedComputations: number
        commits: number
        treeItems: number
        taskCount: number
        documentText: string
        consumerReady: boolean
      }
      resetMetrics: () => void
      dispose: () => void
    }
  }
}
