/**
 * Images attached in the chat: written into the vault under a local-only
 * folder, named in the message by path, and read back as a chip.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_UPLOAD_BYTES, UPLOADS_DIR, saveUpload } from '../main/host/uploads'
import {
  insertMarker,
  markerFor,
  pastedFiles,
  splitUserText,
  stillAttached,
  uploadLabel,
  uploadName,
  withPaths,
} from '../renderer/chat/attachments'

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'holi-uploads-'))
})
afterEach(() => rm(root, { recursive: true, force: true }))

const PNG = Buffer.from('not really a png').toString('base64')

describe('saveUpload', () => {
  it('writes the image under the vault, in a local-only folder, and answers its path', async () => {
    const res = await saveUpload(root, { name: 'My shot (1).PNG', data: PNG })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.path.startsWith(join(root, UPLOADS_DIR) + sep)).toBe(true)
    expect(UPLOADS_DIR).toContain('.local.')
    expect(res.path).toMatch(/-My-shot-1\.png$/i)
    expect((await readFile(res.path)).toString()).toBe('not really a png')
  })

  it('keeps a name from climbing out of the folder', async () => {
    const res = await saveUpload(root, { name: '../../etc/passwd.png', data: PNG })
    expect(res.ok && res.path.startsWith(join(root, UPLOADS_DIR))).toBe(true)
  })

  it('takes a file of any kind, keeping its extension', async () => {
    for (const name of ['notes.pdf', 'data.csv', 'archive.tar.gz', 'script.sh']) {
      const res = await saveUpload(root, { name, data: PNG })
      expect(res.ok && res.path.endsWith(name.slice(name.lastIndexOf('.')))).toBe(true)
    }
    const bare = await saveUpload(root, { name: 'Makefile', data: PNG })
    expect(bare.ok && bare.path).toMatch(/-Makefile$/)
    // An extension that is not plain characters is dropped, not kept.
    const odd = await saveUpload(root, { name: 'a.p;ng', data: PNG })
    expect(odd.ok && odd.path).not.toContain(';')
  })

  it('refuses an empty file and a huge one', async () => {
    expect((await saveUpload(root, { name: 'a.png', data: '' })).ok).toBe(false)
    const big = Buffer.alloc(MAX_UPLOAD_BYTES + 1).toString('base64')
    expect(await saveUpload(root, { name: 'a.png', data: big })).toEqual({
      ok: false,
      message: 'That file is over 50 MB.',
    })
  })
})

describe('the message', () => {
  const png = (name = 'image.png') => new File(['x'], name, { type: 'image/png' })
  const pdf = (name = 'notes.pdf') => new File(['x'], name, { type: 'application/pdf' })

  it('marks each picture [Image N], past every one attached or typed', () => {
    expect(markerFor(png(), [], '')).toBe('[Image 1]')
    expect(markerFor(png(), ['[Image 1]'], '')).toBe('[Image 2]')
    // A marker removed from the text frees nothing: numbers are not reused
    // while another is still around, and a typed one counts too.
    expect(markerFor(png(), [], 'see [Image 1] and [Image 2]')).toBe('[Image 3]')
  })

  it('marks other files by name, told apart when the name repeats', () => {
    expect(markerFor(pdf(), [], '')).toBe('[notes.pdf]')
    expect(markerFor(pdf(), ['[notes.pdf]'], '')).toBe('[notes.pdf (2)]')
  })

  it('puts a marker at the cursor, spaced from the words around it', () => {
    expect(insertMarker('', 0, 0, '[Image 1]')).toEqual({ text: '[Image 1]', caret: 9 })
    expect(insertMarker('Look here', 9, 9, '[Image 1]')).toEqual({
      text: 'Look here [Image 1]',
      caret: 19,
    })
    // In the middle of a sentence, with a space kept either side.
    expect(insertMarker('Fix thisand that', 8, 8, '[Image 1]')).toEqual({
      text: 'Fix this [Image 1] and that',
      caret: 19,
    })
    // Over a selection, which it replaces.
    expect(insertMarker('a XXX b', 2, 5, '[Image 1]').text).toBe('a [Image 1] b')
  })

  it('keeps only the attachments whose marker is still in the text', () => {
    const a = { id: '1', file: png(), marker: '[Image 1]' }
    const b = { id: '2', file: png(), marker: '[Image 2]' }
    expect(stillAttached('only [Image 2] left', [a, b])).toEqual([b])
    expect(stillAttached('', [a, b])).toEqual([])
  })

  it('replaces each marker with its @path, where it stood', () => {
    const paths = new Map([
      ['[Image 1]', '/v/.holi/state/chat.local.uploads/a-ab12cd-one.png'],
      ['[Image 2]', '/v/.holi/state/chat.local.uploads/b-ab12cd-two.png'],
    ])
    expect(withPaths('Broken: [Image 1] and it should be [Image 2].', paths)).toBe(
      'Broken: @/v/.holi/state/chat.local.uploads/a-ab12cd-one.png and it should be @/v/.holi/state/chat.local.uploads/b-ab12cd-two.png .',
    )
    expect(withPaths('[Image 1]', paths)).toBe(
      '@/v/.holi/state/chat.local.uploads/a-ab12cd-one.png',
    )
    // The same marker twice is the same file twice.
    expect(withPaths('[Image 1] [Image 1]', paths).match(/@\//g)).toHaveLength(2)
  })

  it('quotes a path with a space, and reads it back', () => {
    const path = '/v/My Vault/.holi/state/chat.local.uploads/lq3x9-ab12cd-notes.pdf'
    expect(withPaths('Read [notes.pdf]', new Map([['[notes.pdf]', path]]))).toBe(`Read @"${path}"`)
    expect(splitUserText(`Read\n\n@"${path}"`)).toEqual([
      { kind: 'text', text: 'Read' },
      { kind: 'file', path, label: 'notes.pdf', image: false },
    ])
  })

  it('reads an upload back as a chip, in its place among the words', () => {
    const path = '/v/.holi/state/chat.local.uploads/lq3x9-ab12cd-screenshot.png'
    expect(uploadLabel(path)).toBe('screenshot.png')
    expect(splitUserText(`Look at @${path} then fix it`)).toEqual([
      { kind: 'text', text: 'Look at' },
      { kind: 'file', path, label: 'screenshot.png', image: true },
      { kind: 'text', text: 'then fix it' },
    ])
    // Any other @mention stays the text it is.
    expect(splitUserText('ask @alice about it')).toEqual([
      { kind: 'text', text: 'ask @alice about it' },
    ])
  })

  it('gives a file with only a type an extension, and leaves the rest as they are', () => {
    expect(uploadName(new File([], 'image', { type: 'image/jpeg' }))).toBe('image.jpg')
    expect(uploadName(new File([], 'pic.webp', { type: 'image/webp' }))).toBe('pic.webp')
    expect(uploadName(new File([], 'Makefile', { type: '' }))).toBe('Makefile')
  })

  it('leaves the picture that comes with rich text to the text', () => {
    const data = (types: string[], files: File[]) =>
      ({ types, files, items: [] }) as unknown as DataTransfer
    expect(pastedFiles(data(['Files'], [png()])).files).toHaveLength(1)
    expect(pastedFiles(data(['text/plain', 'Files'], [png()])).files).toHaveLength(0)
    // A file with a name of its own is a file, whatever else is on the clipboard.
    expect(pastedFiles(data(['text/plain', 'Files'], [png('shot.png')])).files).toHaveLength(1)
  })
})
