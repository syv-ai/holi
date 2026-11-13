import { EMPTY_PROJECT } from '@holi/shared'
import { useState } from 'react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { fireEvent, render, screen } from '@/test/render'
import { EditProjectDialog } from '../edit-project-dialog'

test('Cancel stays interactive when focus changes during pointer down', async () => {
  const onOpenChange = vi.fn()
  function Harness() {
    const [focused, setFocused] = useState(false)
    return (
      <div onPointerDown={() => setFocused(true)}>
        <EditProjectDialog
          open
          visible
          focused={focused}
          onOpenChange={onOpenChange}
          project={EMPTY_PROJECT}
          fallbackName="Notes"
          people={[]}
          onSave={vi.fn(() => Promise.resolve())}
        />
      </div>
    )
  }
  render(<Harness />)

  const cancel = screen.getByRole('button', { name: 'Cancel' })
  fireEvent.pointerDown(cancel)
  expect(document.body.style.pointerEvents).not.toBe('none')
  await userEvent.click(cancel)
  expect(onOpenChange).toHaveBeenCalledWith(false)
})
