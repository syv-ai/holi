import assert from 'node:assert/strict'

export function createMdxSmokeClient(page) {
  const wire = (name, input, type = 'mutation') => ({ path: `mdxTrust.${name}`, type, input })
  const rpc = (operation) => page.evaluate(`window.holi.trpc(${JSON.stringify(operation)})`)
  const call = async (name, input, type) => {
    const response = await rpc(wire(name, input, type))
    assert(response?.ok, `${name} refused by the application router`)
    return response.data
  }
  const refuse = async (response, label, message) => {
    const result = await response
    assert(result?.ok === false, label)
    if (message) assert(message.test(result.message), label)
  }
  return { wire, rpc, call, refuse }
}
