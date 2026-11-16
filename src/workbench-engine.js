import { fileURLToPath, pathToFileURL } from 'node:url'

const upstream = new URL('../vendor/structure-viewer/', import.meta.url)

export async function connectWorkbench(root, stateDirectory) {
  const { createStructureViewerServer } = await import(new URL('dist/server.mjs', upstream))
  const server = createStructureViewerServer({
    stateDirectory,
    bundledExamplesDirectory: fileURLToPath(new URL('examples/', upstream)),
  })
  const pending = new Map()
  let nextId = 0
  const transport = {
    async start() {},
    async send(message) {
      if (message.method === 'roots/list') {
        queueMicrotask(() => transport.onmessage({
          jsonrpc: '2.0',
          id: message.id,
          result: { roots: [{ uri: pathToFileURL(root).href, name: 'DSH workspace' }] },
        }))
      } else if ('id' in message) {
        const settle = pending.get(message.id)
        if (!settle) return
        if (message.error) settle(new Error(message.error.message))
        else settle(null, message.result === undefined ? undefined : JSON.parse(JSON.stringify(message.result)))
      }
    },
    async close() {
      for (const settle of pending.values()) settle(new Error('The molecular workbench disconnected.'))
      transport.onclose?.()
    },
  }
  await server.connect(transport)

  function request(method, params, signal, timeoutMs = 180_000) {
    signal?.throwIfAborted()
    return new Promise((resolve, reject) => {
      const id = ++nextId
      function settle(error, result) {
        pending.delete(id)
        clearTimeout(timer)
        signal?.removeEventListener('abort', cancel)
        if (error) reject(error)
        else resolve(result)
      }
      function cancel() {
        if (!pending.has(id)) return
        const reason = signal?.aborted ? 'Request cancelled.' : 'Molecular workbench request timed out.'
        settle(new Error(reason))
        transport.onmessage({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId: id, reason },
        })
      }
      const timer = setTimeout(cancel, timeoutMs)
      timer.unref()
      pending.set(id, settle)
      signal?.addEventListener('abort', cancel, { once: true })
      transport.onmessage({ jsonrpc: '2.0', id, method, params })
    })
  }

  try {
    await request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: { roots: { listChanged: false } },
      clientInfo: { name: 'dsh-molecular-workbench', version: '0.1.0' },
    }, undefined, 10_000)
    transport.onmessage({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const { tools } = await request('tools/list', {}, undefined, 10_000)
    return {
      request,
      tools: new Map(tools.map(tool => [tool.name, tool])),
      call: (name, args, signal) => request('tools/call', { name, arguments: args }, signal),
      close: () => server.close(),
    }
  } catch (error) {
    await server.close()
    throw error
  }
}
