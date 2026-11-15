import { describe, expect, it, vi } from 'vitest'
import { Provider, createStore } from 'jotai'
import userEvent from '@testing-library/user-event'
import { act, fireEvent } from '@testing-library/react'
import { useState } from 'react'
import { render, screen } from '@/test/render'
import { useVimField, VimFieldMode } from '@/plugin-api'
import { vimCodeEditingAtom } from '@/state/preferences'
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { hostHintKeyAtom } from '@/state/shortcuts'

function Field({ onSubmit, trackValue = false }: { onSubmit: () => void; trackValue?: boolean }) {
  const [value, setValue] = useState('alpha')
  const vim = useVimField('fixture', trackValue ? value : undefined)
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <input
        aria-label="search"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        {...vim.vimFieldProps}
      />
      <VimFieldMode mode={vim.vimFieldMode} />
      <button type="button" onClick={() => setValue('replacement')}>
        Replace value
      </button>
      <button>Submit</button>
    </form>
  )
}

describe('plugin-consumed native field binding', () => {
  it('resets stale normal/operator state after an uncontrolled external DOM replacement', async () => {
    const store = createStore()
    store.set(vimCodeEditingAtom, true)
    render(
      <Provider store={store}>
        <Field onSubmit={vi.fn()} />
      </Provider>,
    )
    const field = screen.getByRole('textbox', { name: 'search' })
    await userEvent.click(field)
    await userEvent.keyboard('{Escape}d')
    fireEvent.click(screen.getByRole('button', { name: 'Replace value' }))
    expect(field).toHaveValue('replacement')
    await userEvent.keyboard('x')
    expect(field).toHaveValue('replacementx')
    expect(screen.getByLabelText('Vim insert mode')).toBeInTheDocument()
  })

  it('exports the same binding and keeps normal-mode Enter from submitting', async () => {
    const store = createStore()
    store.set(vimCodeEditingAtom, true)
    const submit = vi.fn()
    render(
      <Provider store={store}>
        <Field onSubmit={submit} />
      </Provider>,
    )
    const field = screen.getByRole('textbox', { name: 'search' })
    await userEvent.click(field)
    await userEvent.keyboard('{Escape}')
    expect(screen.getByLabelText('Vim normal mode')).toBeInTheDocument()
    await userEvent.keyboard('{Enter}')
    expect(submit).not.toHaveBeenCalled()
  })

  it('keeps normal mode across controlled native edits and preserves undo values', async () => {
    const store = createStore()
    store.set(vimCodeEditingAtom, true)
    render(
      <Provider store={store}>
        <Field onSubmit={vi.fn()} />
      </Provider>,
    )
    const field = screen.getByRole('textbox', { name: 'search' })
    await userEvent.click(field)
    await userEvent.keyboard('{Escape}0l')
    expect(screen.getByLabelText('Vim normal mode')).toBeInTheDocument()
    expect(field).toHaveValue('alpha')
    await userEvent.keyboard('{Enter}')
    expect(screen.getByLabelText('Vim normal mode')).toBeInTheDocument()
  })

  it.each([false, true])(
    'retains normal after native input and undo with value tracking %s',
    async (trackValue) => {
      const descriptor = Object.getOwnPropertyDescriptor(document, 'execCommand')
      const history: string[] = []
      Object.defineProperty(document, 'execCommand', {
        configurable: true,
        value: vi.fn((command: string) => {
          const field = document.activeElement as HTMLInputElement
          const before = field.value
          const next =
            command === 'undo'
              ? (history.pop() ?? before)
              : before.slice(0, field.selectionStart ?? 0) + before.slice(field.selectionEnd ?? 0)
          if (command !== 'undo') history.push(before)
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
            field,
            next,
          )
          field.dispatchEvent(
            new InputEvent('input', {
              bubbles: true,
              inputType: command === 'undo' ? 'historyUndo' : 'deleteContentBackward',
            }),
          )
          return true
        }),
      })
      try {
        const store = createStore()
        store.set(vimCodeEditingAtom, true)
        const submit = vi.fn()
        render(
          <Provider store={store}>
            <Field onSubmit={submit} trackValue={trackValue} />
          </Provider>,
        )
        const field = screen.getByRole('textbox', { name: 'search' })
        await userEvent.click(field)
        await userEvent.keyboard('{Escape}0x')
        expect(field).toHaveValue('lpha')
        expect(screen.getByLabelText('Vim normal mode')).toBeInTheDocument()
        await userEvent.keyboard('u{Enter}')
        expect(field).toHaveValue('alpha')
        expect(screen.getByLabelText('Vim normal mode')).toBeInTheDocument()
        expect(submit).not.toHaveBeenCalled()
      } finally {
        if (descriptor) Object.defineProperty(document, 'execCommand', descriptor)
        else Reflect.deleteProperty(document, 'execCommand')
      }
    },
  )

  it('cancels an incomplete operator without deleting or submitting', async () => {
    const store = createStore()
    store.set(vimCodeEditingAtom, true)
    const submit = vi.fn()
    render(
      <Provider store={store}>
        <Field onSubmit={submit} />
      </Provider>,
    )
    const field = screen.getByRole('textbox', { name: 'search' })
    await userEvent.click(field)
    await userEvent.keyboard('{Escape}d{Enter}')
    expect(field).toHaveValue('alpha')
    expect(submit).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Vim normal mode')).toBeInTheDocument()
  })

  it('handles Escape before the dialog capture handler and keeps the overlay open', async () => {
    const store = createStore()
    store.set(vimCodeEditingAtom, true)
    render(
      <Provider store={store}>
        <Dialog>
          <DialogTrigger>Open field</DialogTrigger>
          <DialogContent>
            <Field onSubmit={vi.fn()} />
          </DialogContent>
        </Dialog>
      </Provider>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Open field' }))
    const field = screen.getByRole('textbox', { name: 'search' })
    await userEvent.click(field)
    await userEvent.keyboard('{Escape}')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByLabelText('Vim normal mode')).toBeInTheDocument()
  })

  it('gives an active host-hint session first refusal inside a dialog', async () => {
    const store = createStore()
    store.set(vimCodeEditingAtom, true)
    const handleHint = vi.fn(() => true)
    store.set(hostHintKeyAtom, () => handleHint)
    render(
      <Provider store={store}>
        <Dialog open>
          <DialogContent>
            <Field onSubmit={vi.fn()} />
            <Button>Hint target</Button>
          </DialogContent>
        </Dialog>
      </Provider>,
    )
    const field = screen.getByRole('textbox', { name: 'search' })
    await userEvent.click(field)
    await userEvent.keyboard('{Escape}')
    expect(handleHint).toHaveBeenCalledOnce()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(field).toHaveFocus()
  })

  it('does not intercept a composing Escape key', async () => {
    const store = createStore()
    store.set(vimCodeEditingAtom, true)
    render(
      <Provider store={store}>
        <Field onSubmit={vi.fn()} />
      </Provider>,
    )
    const field = screen.getByRole('textbox', { name: 'search' })
    await userEvent.click(field)
    fireEvent.keyDown(field, { key: 'Escape', isComposing: true })
    expect(screen.getByLabelText('Vim insert mode')).toBeInTheDocument()
  })

  it.each(['Escape', 'Enter'])(
    'leaves composing %s native without dismissing or submitting',
    async (key) => {
      const store = createStore()
      store.set(vimCodeEditingAtom, true)
      const submit = vi.fn()
      const routed = vi.fn()
      render(
        <Provider store={store}>
          <Dialog open>
            <DialogContent onKeyDown={routed}>
              <Field onSubmit={submit} />
            </DialogContent>
          </Dialog>
        </Provider>,
      )
      const field = screen.getByRole('textbox', { name: 'search' })
      await userEvent.click(field)
      fireEvent.compositionStart(field)
      const event = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        isComposing: true,
      })
      act(() => field.dispatchEvent(event))
      expect(event.defaultPrevented).toBe(false)
      expect(routed).not.toHaveBeenCalled()
      expect(screen.getByRole('dialog')).toBeInTheDocument()
      expect(screen.getByLabelText('Vim insert mode')).toBeInTheDocument()
      expect(submit).not.toHaveBeenCalled()
      fireEvent.compositionEnd(field)
      await userEvent.keyboard('{Escape}')
      expect(screen.getByLabelText('Vim normal mode')).toBeInTheDocument()
    },
  )

  it('keeps the enabled indicator slot while unfocused without exposing a mode', async () => {
    const store = createStore()
    store.set(vimCodeEditingAtom, true)
    render(
      <Provider store={store}>
        <Field onSubmit={vi.fn()} />
      </Provider>,
    )
    const field = screen.getByRole('textbox', { name: 'search' })
    await userEvent.click(field)
    expect(screen.getByLabelText('Vim insert mode')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Replace value' }))
    expect(screen.queryByLabelText(/Vim .* mode/)).not.toBeInTheDocument()
    expect(document.querySelector('[aria-hidden="true"].invisible')).toBeInTheDocument()
  })

  it('stops showing mode when the machine preference is switched off', async () => {
    const store = createStore()
    store.set(vimCodeEditingAtom, true)
    render(
      <Provider store={store}>
        <Field onSubmit={vi.fn()} />
      </Provider>,
    )
    const field = screen.getByRole('textbox', { name: 'search' })
    await userEvent.click(field)
    await userEvent.keyboard('{Escape}')
    act(() => store.set(vimCodeEditingAtom, false))
    expect(screen.queryByLabelText(/Vim .* mode/)).not.toBeInTheDocument()
  })

  it('starts in insert and leaves ordinary controlled input typing intact', async () => {
    const store = createStore()
    store.set(vimCodeEditingAtom, true)
    render(
      <Provider store={store}>
        <Field onSubmit={vi.fn()} />
      </Provider>,
    )
    const field = screen.getByRole('textbox', { name: 'search' })
    await userEvent.click(field)
    expect(screen.getByLabelText('Vim insert mode')).toBeInTheDocument()
    await userEvent.keyboard('x')
    expect(field).toHaveValue('alphax')
  })
})
