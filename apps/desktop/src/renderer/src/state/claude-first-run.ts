/**
 * Claude Code's first run in a vault this machine just onboarded.
 *
 * Each vault has its own Claude Code config directory, so a new one has not
 * been trusted or signed in, and a background session there is refused
 * ("Workspace not trusted") until an interactive `claude` has asked. The
 * onboarding asks for that run here; the shell answers once the vault is open
 * and its agent is running, with a terminal on `claude /login` in the vault,
 * where Claude Code shows its own trust prompt and then its login. Holi never
 * answers either question for the person.
 */
import { atom } from 'jotai'

/** The vault whose first run is still owed, or null. */
export const claudeFirstRunAtom = atom<string | null>(null)
