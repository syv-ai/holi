/**
 * The signatures a person has made in the PDF viewer, on disk.
 *
 * The viewer keeps them in memory only, so without this a signature is gone the
 * moment its PDF closes. They live in `userData`, never a vault: a vault is a
 * shared git repo, and an image of someone's signature is not something to
 * push to teammates. The entries are the library's own serialized form
 * (`serializeEntries`), stored as they come; the store only checks that each
 * one is an object with an id, so a hand-edit gone wrong costs that entry and
 * not the rest.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSignatureStore } from '../src/main/pdf/signatures'

let dir: string
const pathFor = () => join(dir, 'pdf-signatures.json')

const entry = (id: string) => ({
  id,
  createdAt: 1790000000000,
  signature: {
    creationType: 'upload',
    previewDataUrl: 'data:image/png;base64,AA==',
    imageData: 'AA==',
  },
})

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holi-signatures-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('createSignatureStore', () => {
  it('is empty before a signature has been made', async () => {
    expect(await createSignatureStore(pathFor()).read()).toBe('[]')
  })

  it('keeps what was written, across instances', async () => {
    const json = JSON.stringify([entry('a'), entry('b')])
    await createSignatureStore(pathFor()).write(json)

    expect(JSON.parse(await createSignatureStore(pathFor()).read())).toEqual([
      entry('a'),
      entry('b'),
    ])
  })

  it('refuses a write that is not a list, rather than replacing the file with it', async () => {
    const store = createSignatureStore(pathFor())
    await store.write(JSON.stringify([entry('a')]))

    await expect(store.write('{"id":"a"}')).rejects.toThrow(/list/)
    await expect(store.write('not json')).rejects.toThrow()
    expect(JSON.parse(await store.read())).toEqual([entry('a')])
  })

  it('drops an entry without an id and keeps the others', async () => {
    await writeFile(pathFor(), JSON.stringify([entry('a'), { createdAt: 1 }, 'x', entry('b')]))

    expect(JSON.parse(await createSignatureStore(pathFor()).read())).toEqual([
      entry('a'),
      entry('b'),
    ])
  })

  it('reads a corrupt file as empty rather than failing the viewer', async () => {
    await writeFile(pathFor(), '{ truncated')

    expect(await createSignatureStore(pathFor()).read()).toBe('[]')
  })

  it('writes aside and renames, so a crash cannot leave a truncated file', async () => {
    const store = createSignatureStore(pathFor())
    await store.write(JSON.stringify([entry('a')]))

    expect(JSON.parse(await readFile(pathFor(), 'utf8'))).toEqual([entry('a')])
    await expect(readFile(`${pathFor()}.tmp`, 'utf8')).rejects.toThrow()
  })
})
