import { render, screen } from '@/test/render'
import { expect, test, vi } from 'vitest'
import { PdfViewer } from '../renderer/pdf-viewer'

const lifecycle = vi.hoisted(() => ({
  mounted: vi.fn(),
  unmounted: vi.fn(),
  props: [] as boolean[],
}))

vi.mock('../renderer/pdf-document', async () => {
  const React = await import('react')
  return {
    PdfDocument: ({ visible }: { visible: boolean }) => {
      React.useEffect(() => {
        lifecycle.mounted()
        return () => lifecycle.unmounted()
      }, [])
      lifecycle.props.push(visible)
      return <div data-testid="pdf-document" />
    },
  }
})

test('keeps the first displayed PDF document mounted while hidden', async () => {
  const view = render(<PdfViewer path="notes/file.pdf" visible />)
  expect(await screen.findByTestId('pdf-document')).toBeInTheDocument()
  view.rerender(<PdfViewer path="notes/file.pdf" visible={false} />)
  expect(screen.getByTestId('pdf-document')).toBeInTheDocument()
  expect(lifecycle.mounted).toHaveBeenCalledTimes(1)
  expect(lifecycle.unmounted).not.toHaveBeenCalled()
  expect(lifecycle.props.at(-1)).toBe(false)
})
