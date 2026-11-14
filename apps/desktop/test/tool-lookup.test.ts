import { describe, expect, it } from 'vitest'
import {
  delimiterFor,
  isRunnable,
  nodeFallbackDir,
  pathKey,
  readPath,
  resolveBin,
  toolPath,
  withPath,
} from '../src/main/bin'

/** Both branches run on any machine: the OS is a parameter, and the
 *  filesystem is the set of files a test says exist. */
const files = (...paths: string[]) => {
  const set = new Set(paths)
  return (path: string) => set.has(path)
}

const WIN_ENV = {
  Path: 'C:\\Windows\\system32;C:\\Tools',
  USERPROFILE: 'C:\\Users\\ada',
  APPDATA: 'C:\\Users\\ada\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\ada\\AppData\\Local',
}

describe('toolPath', () => {
  it('on macOS and Linux joins the inherited PATH and the usual folders with a colon', () => {
    expect(toolPath({ PATH: '/usr/bin:/bin', HOME: '/h' }, 'linux')).toBe(
      [
        '/usr/bin',
        '/bin',
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/h/.local/bin',
        '/h/.bun/bin',
        '/h/.volta/bin',
        '/h/.npm-global/bin',
        '/h/n/bin',
      ].join(':'),
    )
  })

  it('on Windows splits on a semicolon, so a drive letter stays whole', () => {
    const dirs = toolPath(WIN_ENV, 'win32').split(';')
    expect(dirs.slice(0, 2)).toEqual(['C:\\Windows\\system32', 'C:\\Tools'])
    expect(dirs).toContain('C:\\Users\\ada\\.local\\bin')
    expect(dirs).toContain('C:\\Users\\ada\\AppData\\Roaming\\npm')
    expect(dirs.some((dir) => dir.startsWith('/'))).toBe(false)
  })

  it('on Windows reads the PATH under any case, and lists a folder once whatever its case', () => {
    const dirs = toolPath(
      { ...WIN_ENV, Path: undefined, path: 'C:\\Tools;c:\\tools\\;C:\\More' },
      'win32',
    ).split(';')
    expect(dirs.filter((dir) => dir.toLowerCase().startsWith('c:\\tools'))).toHaveLength(1)
    expect(dirs).toContain('C:\\More')
  })
})

describe('PATH keys', () => {
  it('names the key an Explorer launch has, and PATH when there is none', () => {
    expect(pathKey({ Path: 'x' }, 'win32')).toBe('Path')
    expect(pathKey({}, 'win32')).toBe('PATH')
    // POSIX environment names are case-sensitive: `Path` is not the PATH.
    expect(pathKey({ Path: 'x' }, 'linux')).toBe('PATH')
    expect(readPath({ Path: 'x' }, 'linux')).toBe('')
  })

  it('writes one key on Windows, keeping the one the environment has', () => {
    const env = withPath({ Path: 'C:\\old', PATH: 'junk', Other: '1' }, 'C:\\new', 'win32')
    expect(Object.keys(env).filter((key) => key.toUpperCase() === 'PATH')).toEqual(['Path'])
    expect(env.Path).toBe('C:\\new')
    expect(env.Other).toBe('1')
  })

  it('writes PATH elsewhere and leaves every other key alone', () => {
    expect(withPath({ PATH: '/a', Path: 'kept' }, '/b', 'linux')).toEqual({
      PATH: '/b',
      Path: 'kept',
    })
  })

  it('does not change the environment it was given', () => {
    const env = { Path: 'C:\\old' }
    withPath(env, 'C:\\new', 'win32')
    expect(env).toEqual({ Path: 'C:\\old' })
  })
})

describe('resolveBin on Windows', () => {
  const env = { ...WIN_ENV, Path: 'C:\\a;C:\\b' }

  it('takes .exe over .cmd in the same folder', () => {
    const isFile = files('C:\\a\\claude.cmd', 'C:\\a\\claude.exe')
    expect(resolveBin('claude', env, { platform: 'win32', isFile })).toBe('C:\\a\\claude.exe')
  })

  it('never takes the extensionless shim npm writes beside a .cmd', () => {
    const isFile = files('C:\\a\\claude', 'C:\\a\\claude.cmd')
    expect(resolveBin('claude', env, { platform: 'win32', isFile })).toBe('C:\\a\\claude.cmd')
    expect(
      resolveBin('claude', env, { platform: 'win32', isFile: files('C:\\a\\claude') }),
    ).toBeNull()
  })

  it('keeps PATH order between folders', () => {
    const isFile = files('C:\\a\\claude.cmd', 'C:\\b\\claude.exe')
    expect(resolveBin('claude', env, { platform: 'win32', isFile })).toBe('C:\\a\\claude.cmd')
  })

  it('tries a name that already ends in a runnable extension as it is', () => {
    const isFile = files('C:\\b\\tool.bat')
    expect(resolveBin('tool.bat', env, { platform: 'win32', isFile })).toBe('C:\\b\\tool.bat')
  })

  it('follows PATHEXT, but only for what Holi can start', () => {
    const isFile = files('C:\\a\\x.vbs', 'C:\\a\\x.bat')
    const pathext = { ...env, PATHEXT: '.VBS;.BAT' }
    expect(resolveBin('x', pathext, { platform: 'win32', isFile })).toBe('C:\\a\\x.bat')
  })

  it('finds npm and the Claude installer where Windows puts them when PATH lacks them', () => {
    const isFile = files('C:\\Users\\ada\\AppData\\Roaming\\npm\\claude.cmd')
    expect(resolveBin('claude', { ...WIN_ENV, Path: 'C:\\a' }, { platform: 'win32', isFile })).toBe(
      'C:\\Users\\ada\\AppData\\Roaming\\npm\\claude.cmd',
    )
  })
})

describe('resolveBin on macOS and Linux', () => {
  it('looks for the bare name, with the extension of nobody', () => {
    const env = { PATH: '/usr/bin:/opt/x', HOME: '/h' }
    const isFile = files('/opt/x/claude', '/usr/bin/claude.cmd')
    expect(resolveBin('claude', env, { platform: 'linux', isFile })).toBe('/opt/x/claude')
    expect(
      resolveBin('claude', env, { platform: 'darwin', isFile: files('/h/.local/bin/claude') }),
    ).toBe('/h/.local/bin/claude')
  })
})

describe('isRunnable', () => {
  it('needs a runnable extension on Windows, and nothing but the file elsewhere', () => {
    const isFile = files('C:\\a\\x.exe', 'C:\\a\\x', 'C:\\a\\x.txt', '/a/x')
    expect(isRunnable('C:\\a\\x.exe', { platform: 'win32', isFile })).toBe(true)
    expect(isRunnable('C:\\a\\x', { platform: 'win32', isFile })).toBe(false)
    expect(isRunnable('C:\\a\\x.txt', { platform: 'win32', isFile })).toBe(false)
    expect(isRunnable('/a/x', { platform: 'linux', isFile })).toBe(true)
  })
})

describe('delimiters', () => {
  it('are ; on Windows and : elsewhere, and the fallback node folder follows', () => {
    expect(delimiterFor('win32')).toBe(';')
    expect(delimiterFor('darwin')).toBe(':')
    expect(nodeFallbackDir('C:\\holi\\bin', 'win32')).toBe('C:\\holi\\bin\\fallback')
    expect(nodeFallbackDir('/holi/bin', 'linux')).toBe('/holi/bin/fallback')
  })
})
