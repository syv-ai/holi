/** Whether a modal dialog is currently open over the shell. */
export function dialogOpen(): boolean {
  return (
    document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
    ) !== null
  )
}
