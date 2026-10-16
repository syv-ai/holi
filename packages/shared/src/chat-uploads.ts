/**
 * Where the agent chat keeps what a person attaches, relative to the vault:
 * machine state, and a `.local.` folder, so never committed or synced. Main
 * writes there and the chat reads from there; the name lives only here.
 */
export const CHAT_UPLOADS_DIR = '.holi/state/chat.local.uploads'
