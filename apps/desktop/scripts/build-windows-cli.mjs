import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

if (process.platform === 'win32') {
  const source = fileURLToPath(new URL('../src/main/native/windows-cli.c', import.meta.url))
  const output = fileURLToPath(new URL('../build/native/', import.meta.url))
  mkdirSync(output, { recursive: true })
  const stage = mkdtempSync(join(output, '.build-'))
  const cmd = join(process.env.SystemRoot, 'System32', 'cmd.exe')
  const target = join(output, 'holi.exe')
  const stagedExe = join(stage, 'holi.exe')
  try {
    let prefix = ''
    try {
      execFileSync(join(process.env.SystemRoot, 'System32', 'where.exe'), ['cl.exe'], {
        stdio: 'ignore',
        timeout: 5000,
      })
    } catch {
      const vswhere = join(
        process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
        'Microsoft Visual Studio',
        'Installer',
        'vswhere.exe',
      )
      if (!existsSync(vswhere)) throw new Error('Visual Studio C++ tools were not found')
      const root = execFileSync(
        vswhere,
        [
          '-latest',
          '-products',
          '*',
          '-requires',
          'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
          '-property',
          'installationPath',
        ],
        { encoding: 'utf8', timeout: 10000 },
      ).trim()
      if (!root) throw new Error('Visual Studio C++ tools were not found')
      const vcvars = join(root, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat')
      prefix = `call "${vcvars}" >nul && `
    }
    const command = `${prefix}cl.exe /nologo /O2 /W4 /WX /std:c17 /TC /Fo:"${join(stage, 'holi.obj')}" "${source}" /Fe:"${stagedExe}"`
    execFileSync(cmd, ['/d', '/s', '/c', command], { stdio: 'inherit', timeout: 120000 })
    renameSync(stagedExe, target)
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}
