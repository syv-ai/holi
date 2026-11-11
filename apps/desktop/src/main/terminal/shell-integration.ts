/**
 * Shell integration for the bottom panel's shells (docs/features/status-bar.md):
 * a shim that loads the person's own startup files exactly as their shell
 * would, then adds one prompt hook that reports the working directory as
 * OSC 7 (`ESC ] 7 ; file://host/path BEL`). Main reads it off the PTY
 * (`terminal-context.ts`) to draw the panel's context chips.
 *
 * - **zsh**: `ZDOTDIR` points at a Holi-managed directory whose `.zshenv`,
 *   `.zprofile`, `.zshrc` and `.zlogin` each source the person's file of the
 *   same name from their real `ZDOTDIR` (or `$HOME`), with `ZDOTDIR` set back
 *   to theirs while it runs. The last file restores it for good, so a nested
 *   `zsh` and anything reading `$ZDOTDIR` see their own. The hook is added
 *   after their `.zshrc`, so a theme that resets `precmd_functions` keeps it.
 * - **bash**: `--init-file` a script that does what a login bash does
 *   (`/etc/profile`, then the first of `~/.bash_profile`, `~/.bash_login`,
 *   `~/.profile`), then appends the hook to `PROMPT_COMMAND`.
 * - **PowerShell** (Windows): `-NoExit -Command` runs a script after the
 *   person's profile, which wraps their `prompt` to print the OSC 7 first.
 * - **anything else** (fish, nu, cmd): no shim; main asks the OS for the
 *   shell's cwd instead (`lsof`, which Windows has no counterpart of).
 *
 * The files are written once per run into a fresh `mkdtemp` directory (0700,
 * unpredictable, so no one else can plant a startup file there).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { shellTitle } from './default-shell'

/** How a shell is started with the integration: its arguments and the
 *  environment it adds. */
export interface ShellLaunch {
  args: string[]
  env: Record<string, string>
}

/** zsh: where it would have read its startup files, before Holi's ZDOTDIR. */
const USER_ZDOTDIR = 'HOLI_USER_ZDOTDIR'

/** Swap to the person's ZDOTDIR, source their `file`, and swap back,
 *  remembering where they left ZDOTDIR (their `.zshenv` may move it). */
function zshSource(file: string): string {
  return [
    `__holi_zdotdir="$ZDOTDIR"`,
    `ZDOTDIR="\${${USER_ZDOTDIR}:-$HOME}"`,
    `[[ -r "$ZDOTDIR/${file}" ]] && builtin source "$ZDOTDIR/${file}"`,
    `${USER_ZDOTDIR}="$ZDOTDIR"`,
    `ZDOTDIR="$__holi_zdotdir"`,
  ].join('\n')
}

/** The last startup file: ZDOTDIR is theirs again from here on. */
const ZSH_FINISH = [
  `ZDOTDIR="$${USER_ZDOTDIR}"`,
  `[[ "$ZDOTDIR" == "$HOME" ]] && unset ZDOTDIR`,
  `unset ${USER_ZDOTDIR} __holi_zdotdir`,
].join('\n')

/** OSC 7 with the path percent-encoded byte by byte (RFC 8089). */
const ZSH_HOOK = `
__holi_osc7() {
  emulate -L zsh
  setopt extendedglob
  local LC_ALL=C
  local enc=\${PWD//(#m)[^A-Za-z0-9\\/._~-]/%\${(l:2::0:)$(( [##16] #MATCH ))}}
  builtin printf '\\e]7;file://%s%s\\a' "$HOST" "$enc"
}
autoload -Uz add-zsh-hook && add-zsh-hook precmd __holi_osc7`

const HEADER = '# Holi shell integration (docs/features/status-bar.md). Rewritten each run.'

const ZSH_FILES: Record<string, string> = {
  '.zshenv': `${HEADER}\n${zshSource('.zshenv')}\n`,
  '.zprofile': `${HEADER}\n${zshSource('.zprofile')}\n`,
  '.zshrc': [
    HEADER,
    // macOS's /etc/zshrc set HISTFILE from ZDOTDIR while it was Holi's; put
    // the history back where the person keeps it.
    `if [[ "$HISTFILE" == "$ZDOTDIR/.zsh_history" ]]; then HISTFILE="\${${USER_ZDOTDIR}:-$HOME}/.zsh_history"; fi`,
    zshSource('.zshrc'),
    ZSH_HOOK,
    `[[ -o login ]] || { ${ZSH_FINISH.split('\n').join('; ')}; }`,
    '',
  ].join('\n'),
  '.zlogin': `${HEADER}\n${zshSource('.zlogin')}\n${ZSH_FINISH}\n`,
}

/**
 * PowerShell: the person's own `prompt` is wrapped, not replaced, so a theme
 * (oh-my-posh, starship) keeps drawing; the wrapper only puts the OSC 7 in
 * front of what it draws. Started with `-NoExit -Command` after their profile
 * has loaded, so a profile that defines `prompt` is the one wrapped. ASCII only,
 * and no `e escape: Windows PowerShell 5.1 has neither.
 */
const PWSH_INIT = `${HEADER}
if (-not (Test-Path variable:global:__holi_prompt)) {
  $global:__holi_prompt = $function:prompt
  function global:prompt {
    $status = $?
    # Safe under Set-StrictMode, where reading a variable never set throws.
    $had = Test-Path variable:global:LASTEXITCODE
    $code = if ($had) { $global:LASTEXITCODE }
    $osc = ''
    try {
      if ($PWD.Provider.Name -eq 'FileSystem') {
        $url = [System.Uri]::new($PWD.ProviderPath).AbsoluteUri
        $osc = [string][char]27 + ']7;' + $url + [string][char]7
      }
    } catch {}
    if ($had) { $global:LASTEXITCODE = $code }
    # Their prompt reads $? first, so hand it the status the command left.
    if (-not $status) { $null = Get-Item -LiteralPath '::holi' -ErrorAction Ignore }
    $text = & $global:__holi_prompt
    if ($had) { $global:LASTEXITCODE = $code }
    $osc + $text
  }
}
`

/**
 * The bash script. `pathSetup` is lines run inside `__holi_osc7` before the
 * path is encoded: empty for the script macOS and Linux run (so it is unchanged
 * byte for byte), and Git Bash's, which reports the folder as Windows spells it.
 */
const bashInit = (pathSetup: string): string => `${HEADER}
# What a login bash reads, since --init-file makes it a non-login one.
if [ -r /etc/profile ]; then . /etc/profile; fi
for __holi_f in ~/.bash_profile ~/.bash_login ~/.profile; do
  if [ -r "$__holi_f" ]; then . "$__holi_f"; break; fi
done
unset __holi_f
__holi_osc7() {
  local s=$? LC_ALL=C p="$PWD" out="" c i n
${pathSetup}  for ((i = 0; i < \${#p}; i++)); do
    c="\${p:i:1}"
    case "$c" in
      [A-Za-z0-9/._~-]) out+="$c" ;;
      *) printf -v n '%d' "'$c"; printf -v c '%%%02X' $((n & 255)); out+="$c" ;;
    esac
  done
  builtin printf '\\e]7;file://%s%s\\a' "$HOSTNAME" "$out"
  return $s
}
# Last, so the person's own PROMPT_COMMAND still sees the command's status.
__holi_pc="$PROMPT_COMMAND"
while [[ "$__holi_pc" == *[[:space:]\\;] ]]; do __holi_pc="\${__holi_pc%?}"; done
PROMPT_COMMAND="\${__holi_pc:+\$__holi_pc; }__holi_osc7"
unset __holi_pc
`

const BASH_INIT = bashInit('')

/**
 * Git Bash: its `$PWD` is a drive path (`/c/Users/ada`, which `parseOsc7` reads)
 * or sits under an MSYS-only root (`/tmp`, `/home/ada`) that is no Windows
 * path, so `cygpath -m` turns that into `C:/...` first (only then: starting a
 * process at every prompt is slow on Windows). A separate file, so the script
 * macOS and Linux run is untouched.
 */
const BASH_INIT_WINDOWS = bashInit(
  [
    '  case "$p" in',
    '    /[A-Za-z] | /[A-Za-z]/*) ;;',
    '    *) p="$(cygpath -m "$PWD" 2>/dev/null)" || p="$PWD"; [[ "$p" == /* ]] || p="/$p" ;;',
    '  esac',
    '',
  ].join('\n'),
)

/**
 * Write the shim files under `dir`.
 * @public exported for its test
 */
export function writeShellIntegration(dir: string): void {
  const zsh = join(dir, 'zsh')
  mkdirSync(zsh, { recursive: true, mode: 0o700 })
  for (const [name, text] of Object.entries(ZSH_FILES)) {
    writeFileSync(join(zsh, name), text, { mode: 0o600 })
  }
  writeFileSync(join(dir, 'bash-init.sh'), BASH_INIT, { mode: 0o600 })
  writeFileSync(join(dir, 'bash-init-win.sh'), BASH_INIT_WINDOWS, { mode: 0o600 })
  writeFileSync(join(dir, 'pwsh-init.ps1'), PWSH_INIT, { mode: 0o600 })
}

let written: string | null | undefined

/** The directory the shim lives in this run, written on first use; null when
 *  it cannot be written (the shell then starts without it). */
export function defaultIntegrationDir(): string | null {
  if (written !== undefined) return written
  try {
    const dir = mkdtempSync(join(tmpdir(), 'holi-shell-'))
    writeShellIntegration(dir)
    written = dir
  } catch (err) {
    console.error('[terminal] shell integration not written:', err)
    written = null
  }
  return written
}

/** Windows' own `bash.exe` in System32 starts WSL, which cannot read the
 *  Windows path of Holi's init file and is no MSYS bash: it keeps `-l`. */
const isWslLauncher = (shell: string, platform: NodeJS.Platform): boolean =>
  platform === 'win32' && /[\\/](system32|sysnative|windowsapps)[\\/]/i.test(shell)

/** A shell's name as the platform spells it: its file name, and on Windows
 *  without the extension and in lower case (`C:\Git\bin\BASH.EXE` is `bash`). */
function shellName(shell: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return posix.basename(shell)
  return shellTitle(shell, platform).toLowerCase()
}

/** `text` as the body of a PowerShell single-quoted string. */
const psQuote = (text: string): string => text.replaceAll("'", "''")

/**
 * How to start `shell` as a login shell, with the integration when Holi has
 * one for it. `env` is the environment it would otherwise start with.
 *
 * On Windows a shell is named without `.exe`, PowerShell takes its own
 * arguments (`-l` is not a PowerShell switch, and it exits 1 on it) and cmd,
 * which has no login mode, takes none.
 */
export function shellLaunch(
  shell: string,
  env: Record<string, string>,
  dir: string | null,
  platform: NodeJS.Platform = process.platform,
): ShellLaunch {
  const name = shellName(shell, platform)
  const windows = platform === 'win32'
  // Not on Windows: MSYS zsh's $PWD is no Windows path, and Holi has no shim
  // for it that reports one.
  if (dir !== null && name === 'zsh' && platform !== 'win32') {
    return {
      args: ['-l'],
      env: {
        [USER_ZDOTDIR]: env.ZDOTDIR || env.HOME || '',
        ZDOTDIR: posix.join(dir, 'zsh'),
      },
    }
  }
  if (dir !== null && name === 'bash' && !isWslLauncher(shell, platform)) {
    // Git Bash reads a Windows path in either spelling; slashes need no quoting.
    const init = windows
      ? win32.join(dir, 'bash-init-win.sh').replaceAll('\\', '/')
      : posix.join(dir, 'bash-init.sh')
    return { args: ['--init-file', init], env: {} }
  }
  if (windows) {
    if (name === 'pwsh' || name === 'powershell') {
      if (dir === null) return { args: ['-NoLogo'], env: {} }
      // After their profile, as PowerShell itself would. The script is read
      // and run as text: a script file would be refused under the default
      // execution policy, which would refuse their profile too.
      const script = win32.join(dir, 'pwsh-init.ps1')
      return {
        args: [
          '-NoLogo',
          '-NoExit',
          '-Command',
          `Invoke-Expression ([System.IO.File]::ReadAllText('${psQuote(script)}'))`,
        ],
        env: {},
      }
    }
    if (name === 'cmd') return { args: [], env: {} }
  }
  return { args: ['-l'], env: {} }
}
