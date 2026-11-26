/** Whether a modal dialog is currently open over the shell. */
export function dialogOpen(): boolean {
  return (
    document.querySelector(
      '[role="alertdialog"][data-state="open"], [role="dialog"][data-state="open"]:not([data-modal="false"])',
    ) !== null
  )
}
