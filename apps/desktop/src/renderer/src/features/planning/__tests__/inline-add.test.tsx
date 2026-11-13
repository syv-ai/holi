import { fireEvent, render, screen, waitFor } from '@/test/render'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { InlineAdd, type InlineAddState } from '../inline-add'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function ControlledInlineAdd({ onAdd }: { onAdd: (title: string) => Promise<void> }) {
  const [state, setState] = useState<InlineAddState>({ open: true, title: '', busy: false })
  return <InlineAdd label="Add task" onAdd={onAdd} state={state} onStateChange={setState} />
}

function RetainedControlledInlineAdd({ onAdd }: { onAdd: (title: string) => Promise<void> }) {
  const [state, setState] = useState<InlineAddState>({ open: true, title: '', busy: false })
  const [mounted, setMounted] = useState(true)
  return (
    <>
      <button type="button" onClick={() => setMounted((current) => !current)}>
        Toggle editor
      </button>
      {mounted ? (
        <InlineAdd label="Add task" onAdd={onAdd} state={state} onStateChange={setState} />
      ) : null}
    </>
  )
}

describe('InlineAdd', () => {
  it('clears an uncontrolled draft after a successful add', async () => {
    const saving = deferred<void>()
    render(<InlineAdd label="Add task" onAdd={() => saving.promise} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Add task' }), {
      target: { value: 'Draft task' },
    })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Add task' }), { key: 'Enter' })
    saving.resolve()
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Add task' })).toHaveValue(''))
  })

  it('keeps the controlled state cleared when save completion updates busy', async () => {
    const saving = deferred<void>()
    const onAdd = vi.fn(() => saving.promise)
    render(<ControlledInlineAdd onAdd={onAdd} />)
    const input = screen.getByRole('textbox', { name: 'Add task' })
    fireEvent.change(input, { target: { value: 'Draft task' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    saving.resolve()
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Add task' })).toHaveValue(''))
    expect(onAdd).toHaveBeenCalledTimes(1)
  })

  it('preserves parent-owned save state across an editor remount', async () => {
    const saving = deferred<void>()
    render(<RetainedControlledInlineAdd onAdd={() => saving.promise} />)
    const input = screen.getByRole('textbox', { name: 'Add task' })
    fireEvent.change(input, { target: { value: 'Draft task' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'Toggle editor' }))
    fireEvent.click(screen.getByRole('button', { name: 'Toggle editor' }))
    expect(screen.getByRole('textbox', { name: 'Add task' })).toHaveAttribute('readonly')
    saving.resolve()
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Add task' })).toHaveValue(''))
    expect(screen.getByRole('textbox', { name: 'Add task' })).not.toHaveAttribute('readonly')
  })

  it('keeps the draft and clears busy after a failed save', async () => {
    const saving = deferred<void>()
    render(<ControlledInlineAdd onAdd={() => saving.promise} />)
    const input = screen.getByRole('textbox', { name: 'Add task' })
    fireEvent.change(input, { target: { value: 'Draft task' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    saving.reject(new Error('save failed'))
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Add task' })).toHaveValue('Draft task')
      expect(screen.getByRole('textbox', { name: 'Add task' })).not.toHaveAttribute('readonly')
    })
  })

  it('does not submit again on Enter while a save is pending', async () => {
    const saving = deferred<void>()
    const onAdd = vi.fn(() => saving.promise)
    render(<ControlledInlineAdd onAdd={onAdd} />)
    const input = screen.getByRole('textbox', { name: 'Add task' })
    fireEvent.change(input, { target: { value: 'Draft task' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onAdd).toHaveBeenCalledTimes(1)
    saving.resolve()
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Add task' })).toHaveValue(''))
  })
})
