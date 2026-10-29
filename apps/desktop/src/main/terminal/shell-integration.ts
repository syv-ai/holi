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
 * - **anything else** (fish, nu): no shim; main asks the OS for the shell's
 *   cwd instead (`lsof`).
 *
 * The files are written once per run into a fresh `mkdtemp` directory (0700,
 * unpredictable, so no one else can plant a startup file there).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

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

const BASH_INIT = `${HEADER}
# What a login bash reads, since --init-file makes it a non-login one.
if [ -r /etc/profile ]; then . /etc/profile; fi
for __holi_f in ~/.bash_profile ~/.bash_login ~/.profile; do
  if [ -r "$__holi_f" ]; then . "$__holi_f"; break; fi
done
unset __holi_f
__holi_osc7() {
  local s=$? LC_ALL=C p="$PWD" out="" c i n
  for ((i = 0; i < \${#p}; i++)); do
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

/**
 * How to start `shell` as a login shell, with the integration when Holi has
 * one for it. `env` is the environment it would otherwise start with.
 */
export function shellLaunch(
  shell: string,
  env: Record<string, string>,
  dir: string | null,
): ShellLaunch {
  const name = basename(shell)
  if (dir !== null && name === 'zsh') {
    return {
      args: ['-l'],
      env: { [USER_ZDOTDIR]: env.ZDOTDIR || env.HOME || '', ZDOTDIR: join(dir, 'zsh') },
    }
  }
  if (dir !== null && name === 'bash') {
    return { args: ['--init-file', join(dir, 'bash-init.sh')], env: {} }
  }
  return { args: ['-l'], env: {} }
}
