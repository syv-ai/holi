/**
 * Which shell the bottom panel runs when nothing says (docs/features/status-bar.md):
 * the person's `$SHELL` where they set one, else PowerShell 7 (`pwsh`) where it is
 * installed and Windows PowerShell where not, on Windows, and zsh elsewhere. A Start-menu launch has no `$SHELL`, and Windows has no
 * `/bin/zsh`.
 */
import { posix, win32 } from 'node:path'
import { resolveBin } from '../bin'

/** The shell's path. `$SHELL` wins (Git Bash sets it for its own children, and
 *  a person may export it), on Windows when it is a Windows path; without one on Windows, `pwsh` where
 *  `find` finds it (PowerShell 7 has its own profile, which a person who installed
 *  it set up), else Windows PowerShell by its fixed place under the system
 *  folder, which every Windows has. */
export function defaultShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  find: (name: string) => string | null = (name) => resolveBin(name, env, { platform }),
): string {
  if (platform !== 'win32') return env.SHELL || '/bin/zsh'
  // A Windows `$SHELL` is a Windows path; a Cygwin or MSYS one (`/bin/bash`) is
  // none node-pty can start, so it is not taken.
  if (env.SHELL && /^(?:[A-Za-z]:[\\/]|\\\\)/.test(env.SHELL)) return env.SHELL
  const pwsh = find('pwsh')
  if (pwsh !== null) return pwsh
  const system = env.SystemRoot || env.windir || 'C:\\Windows'
  return win32.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** A terminal's tab title: the shell's name, as the person says it (`bash`,
 *  not `bash.exe`). */
export function shellTitle(shell: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? win32.basename(shell).replace(/\.(exe|cmd|bat)$/i, '')
    : posix.basename(shell)
}
