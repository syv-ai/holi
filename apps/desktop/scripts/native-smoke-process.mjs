export function observeChild(child) {
  let exit = null
  let spawnFailure = null
  const closed = new Promise((resolve) => {
    child.once('error', (error) => {
      spawnFailure = error.message
      resolve({ error: error.message })
    })
    child.once('close', (code, signal) => {
      exit = { code, signal }
      resolve(exit)
    })
  })
  return {
    closed,
    get exit() {
      return exit
    },
    get spawnFailure() {
      return spawnFailure
    },
  }
}

export function startupDiagnostic(label, childState, logs) {
  return `Timed out: ${label}; childExit=${JSON.stringify(childState.exit)}; spawnFailure=${childState.spawnFailure}; logs=${logs}`
}
