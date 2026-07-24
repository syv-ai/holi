/** The explorer's action strip: the vault name and the three VS Code header
 *  actions. Icons are inline SVGs (the app ships no icon font). */
export function ExplorerHeader({
  title,
  onNewFile,
  onNewFolder,
  onCollapseAll,
}: {
  title: string
  onNewFile: () => void
  onNewFolder: () => void
  onCollapseAll: () => void
}) {
  return (
    <div className="flex items-center justify-between px-2 py-1">
      <span className="truncate text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
        {title}
      </span>
      <span className="flex shrink-0 gap-0.5 text-neutral-500">
        <button
          className="rounded p-1 hover:bg-neutral-800 hover:text-neutral-200"
          title="New File"
          aria-label="New File"
          onClick={onNewFile}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
            <path d="M9 1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5L9 1zm3 12H4V2h4v3h4v8zM7 7h1v2h2v1H8v2H7v-2H5V9h2V7z" />
          </svg>
        </button>
        <button
          className="rounded p-1 hover:bg-neutral-800 hover:text-neutral-200"
          title="New Folder"
          aria-label="New Folder"
          onClick={onNewFolder}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
            <path d="M2 3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3H2zm9 5h1v2h2v1h-2v2h-1v-2H9V10h2V8z" />
          </svg>
        </button>
        <button
          className="rounded p-1 hover:bg-neutral-800 hover:text-neutral-200"
          title="Collapse All"
          aria-label="Collapse All"
          onClick={onCollapseAll}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
            <path d="M2 3h12v1H2V3zm0 3h8v1H2V6zm0 3h12v1H2V9zm0 3h8v1H2v-1z" />
          </svg>
        </button>
      </span>
    </div>
  )
}
