function data(bytes: Uint8Array): NSData {
  return NSData.dataWithBytesLength(bytes, bytes.length)
}

export function nativePath(value: string): NSData {
  return data(
    new Uint8Array(Array.from(unescape(encodeURIComponent(value)), (char) => char.charCodeAt(0))),
  )
}

function bytes(value: NSData): Uint8Array {
  return new Uint8Array(interop.bufferFromData(value)).slice()
}

function text(value: NSData): string {
  return decodeURIComponent(
    Array.from(bytes(value), (byte) => `%${byte.toString(16).padStart(2, '0')}`).join(''),
  )
}

function checked<T>(operation: (error: interop.Reference<NSError>) => T): T {
  const error = new interop.Reference<NSError>()
  const result = operation(error)
  if (error.value) throw new Error(error.value.localizedDescription)
  return result
}

const bridge = () => HoliNativeFiles.alloc().init()

/** Byte-path operations: paths never pass through NSString filesystem conversion. */
export const nativeIO = {
  canonical(path: string): string {
    const result = checked((error) => bridge().canonicalPathError(nativePath(path), error))
    if (!result) throw new Error('Native canonical path is unavailable')
    return text(result)
  },
  names(path: string): string[] {
    const result = checked((error) => bridge().namesError(nativePath(path), error))
    if (!result) throw new Error('Native directory entries are unavailable')
    return Array.from(result, text).filter((name) => name !== '.' && name !== '..')
  },
  kind(path: string): string | null {
    return checked((error) => bridge().kindError(nativePath(path), error))
  },
  mkdir(path: string): void {
    if (!checked((error) => bridge().makeDirectoryError(nativePath(path), error)))
      throw new Error('Native directory creation failed')
  },
  read(path: string): Uint8Array {
    const result = checked((error) => bridge().readError(nativePath(path), error))
    if (!result) throw new Error('Native file bytes are unavailable')
    return bytes(result)
  },
  writeExclusive(path: string, value: Uint8Array, fault?: string): void {
    if (
      !checked((error) =>
        bridge().writeExclusiveDataFaultError(nativePath(path), data(value), fault ?? null, error),
      )
    )
      throw new Error('Native exclusive write failed')
  },
  publish(stage: string, target: string, exclusive: boolean, fault?: string): void {
    if (
      !checked((error) =>
        bridge().publishFromToExclusiveFaultError(
          nativePath(stage),
          nativePath(target),
          exclusive,
          fault ?? null,
          error,
        ),
      )
    )
      throw new Error('Native publication failed')
  },
  removeFile(path: string): void {
    if (!checked((error) => bridge().removeFileError(nativePath(path), error)))
      throw new Error('Native file cleanup failed')
  },
}
