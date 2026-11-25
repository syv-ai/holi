// Self-contained so the hosted runner can install this in the paused signed app.
// Verified at dev.275 and HEAD: preload/index.ts -> main/ipc.ts -> trpc-call.ts;
// renderer lib/cap-client.ts sends cap.run mutations, not google.* procedure paths.
export function observeUpgradeUiRequests(ipcMain, fixtureRemote) {
  const records = []
  const originalHandle = ipcMain.handle
  ipcMain.handle = function (channel, listener, ...registrationArgs) {
    if (channel !== 'holi:trpc') {
      return originalHandle.call(this, channel, listener, ...registrationArgs)
    }
    return originalHandle.call(
      this,
      channel,
      function (...args) {
        const op = args[1]
        const capability =
          op?.path === 'cap.run' &&
          op?.type === 'mutation' &&
          ['google.status', 'google.allAccounts'].includes(op?.input?.name)
            ? op.input.name
            : null
        if (!capability || records.length >= 20) return listener.apply(this, args)
        const record = {
          capability,
          fixtureVaultMatch: op.input.remote === fixtureRemote,
          result: 'pending',
        }
        records.push(record)
        const finish = (value, failure) => {
          // Observation must never replace a handler outcome, even for an unexpected shape.
          try {
            record.result =
              failure ??
              (value?.ok === true ? 'success' : value?.ok === false ? 'envelope-error' : 'unknown')
            if (record.result === 'envelope-error') {
              record.code = [
                'BAD_REQUEST',
                'UNAUTHORIZED',
                'FORBIDDEN',
                'NOT_FOUND',
                'CONFLICT',
                'PRECONDITION_FAILED',
                'TIMEOUT',
                'INTERNAL_SERVER_ERROR',
                'METHOD_NOT_SUPPORTED',
                'TOO_MANY_REQUESTS',
              ].includes(value.code)
                ? value.code
                : 'other'
            }
            if (record.result === 'success') {
              if (capability === 'google.status') {
                record.accountPresent = value.data?.account != null
                record.needsReconnect = value.data?.needsReconnect === true
              } else {
                record.currentAccountPresent = value.data?.current != null
              }
            }
          } catch {
            record.result = 'unknown'
          }
        }
        let result
        try {
          result = listener.apply(this, args)
        } catch (error) {
          finish(null, 'throw')
          throw error
        }
        if (result instanceof Promise) {
          // Observe settlement without replacing the original promise or its rejection.
          Promise.prototype.then.call(
            result,
            (value) => finish(value),
            () => finish(null, 'rejection'),
          )
        } else {
          finish(result)
        }
        return result
      },
      ...registrationArgs,
    )
  }
  return () => records.map((record) => ({ ...record }))
}

// Persist while the inspector is live, including when the original observation throws.
// The workflow error remains authoritative if diagnostics cannot be collected.
export async function captureUpgradeUiRequests({ execute, receipt, persist }) {
  try {
    receipt.uiCapabilityRequests = await execute('globalThis.__holi565?.uiRequests?.() ?? []')
    receipt.uiCapabilityCapture = 'captured'
  } catch {
    receipt.uiCapabilityCapture = 'unavailable'
  }
  await persist()
}
