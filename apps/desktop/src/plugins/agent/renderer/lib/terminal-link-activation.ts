export interface TerminalLinkActions {
  paths: ReadonlySet<string>
  root: string | null
  openDocument: (path: string) => void
  openExternal: (url: string) => void
  revealLocalFile: (path: string) => void
}

/** Open an agent terminal's link through Holi's existing safe routes only. */
export function activateTerminalLink(text: string, actions: TerminalLinkActions): void {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return
  }

  if (url.protocol === 'http:' || url.protocol === 'https:') {
    actions.openExternal(url.href)
    return
  }
  if (url.protocol !== 'file:' || (url.hostname !== '' && url.hostname !== 'localhost')) return

  let path: string
  try {
    path = decodeURIComponent(url.pathname)
  } catch {
    return
  }
  if (!path || path.includes('\0')) return
  // WHATWG URL represents a Windows drive path with a leading slash.
  if (/^\/[a-zA-Z]:\//.test(path)) path = path.slice(1)

  const root = actions.root?.replace(/[\\/]+$/, '')
  const normalizedRoot = root?.replaceAll('\\', '/')
  const normalizedPath = path.replaceAll('\\', '/')
  const prefix = normalizedRoot ? `${normalizedRoot}/` : null
  if (prefix && normalizedPath.startsWith(prefix)) {
    const relative = normalizedPath.slice(prefix.length)
    if (actions.paths.has(relative)) actions.openDocument(relative)
    return
  }

  actions.revealLocalFile(path)
}

export interface TerminalUrlLink {
  text: string
  start: number
  end: number
}

/** Only an intentional primary-button modifier click activates terminal links. */
export function isTerminalLinkActivation(event: MouseEvent): boolean {
  return event.button === 0 && (event.metaKey || event.ctrlKey)
}

export interface TerminalBufferLine {
  isWrapped: boolean
  getCell(index: number): { getChars(): string; getWidth(): number } | undefined
}

/** Read a wrapped logical line and map each character back to its terminal cell. */
export function wrappedTerminalLine(
  row: number,
  columns: number,
  getLine: (row: number) => TerminalBufferLine | undefined,
): { text: string; cellAt: (offset: number) => { x: number; y: number } | undefined } {
  let firstRow = row
  while (firstRow > 0 && getLine(firstRow)?.isWrapped) firstRow--
  let text = ''
  const cells: Array<{ x: number; y: number }> = []
  for (let y = firstRow; y <= row; y++) {
    const line = getLine(y)
    if (!line) continue
    for (let x = 0; x < columns; x++) {
      const cell = line.getCell(x)
      if (!cell) continue
      const chars = cell.getChars()
      if (!chars) continue
      text += chars
      for (let offset = 0; offset < chars.length; offset++)
        cells.push({ x: x + 1, y: y - firstRow + 1 })
      // Wide glyphs occupy two terminal cells but only one text character.
      if (cell.getWidth() === 2) continue
    }
  }
  return { text, cellAt: (offset) => cells[offset] }
}

/** Plain-text local file URLs for xterm's explicit link provider. */
export function fileUrlLinks(line: string): TerminalUrlLink[] {
  const links: TerminalUrlLink[] = []
  const candidate = /file:\/\/[^\s<>"']+/gi
  for (const match of line.matchAll(candidate)) {
    let text = match[0]
    while (/[),.;!?\]}]$/.test(text)) text = text.slice(0, -1)
    if (text) links.push({ text, start: match.index, end: match.index + text.length })
  }
  return links
}
