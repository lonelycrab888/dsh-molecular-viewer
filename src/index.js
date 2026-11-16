import { registerWorkbench } from './workbench.js'

export const inject = ['tools', 'webServer', 'connection', 'systemPrompt', 'workingDirectory', 'agents', 'workspaceFiles', 'sandboxPolicy']

export function apply(ctx) {
  const turns = new WeakMap()
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') turns.set(session, event.data.turn)
    if (event.type === 'turn/end') turns.delete(session)
  }, { global: true })

  registerWorkbench(ctx, turns)
}
