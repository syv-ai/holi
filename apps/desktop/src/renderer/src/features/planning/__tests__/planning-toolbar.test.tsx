import { useState } from 'react'
import { Provider, createStore } from 'jotai'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@/test/render'
import { PlanningToolbar } from '@/features/planning/planning-toolbar'
import { EMPTY_PLANNING_FILTER, PLANNING_SORTS } from '@/lib/planning'
import { vimCodeEditingAtom } from '@/state/preferences'

function Toolbar() {
  const [filter, setFilter] = useState(EMPTY_PLANNING_FILTER)
  return (
    <PlanningToolbar
      filter={filter}
      onFilterChange={setFilter}
      sort={PLANNING_SORTS[0]!.id}
      onSortChange={() => {}}
      people={[]}
      tags={[]}
      onNewTask={() => {}}
    />
  )
}

describe('planning toolbar native Vim consumer', () => {
  it('keeps search edits controlled and advertises the active mode', async () => {
    const store = createStore()
    store.set(vimCodeEditingAtom, true)
    render(
      <Provider store={store}>
        <Toolbar />
      </Provider>,
    )
    const search = screen.getByRole('textbox', { name: 'Search tasks' })
    await userEvent.click(search)
    await userEvent.keyboard('{Escape}')
    expect(screen.getByLabelText('Vim normal mode')).toBeInTheDocument()
    await userEvent.keyboard('a')
    expect(screen.getByLabelText('Vim insert mode')).toBeInTheDocument()
    await userEvent.keyboard('query')
    expect(search).toHaveValue('query')
  })
})
