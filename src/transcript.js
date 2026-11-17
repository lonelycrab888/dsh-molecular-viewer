import { PLUGIN_ID, WORKBENCH_TOOL, workbenchId } from './workbench-contract.js'

function openMatch(event) {
  const { meta } = event.data
  return meta?.plugin === PLUGIN_ID && meta.ok === true && meta.action === 'open' &&
    meta.scene?.kind === 'workbench' && workbenchId(meta.scene.id)
    ? { id: String(event.seq), role: 'start' }
    : null
}

export const sceneDefinition = {
  kind: PLUGIN_ID,
  target: 'chat',
  match: {
    'tool/result': event => event.surfaceOp === 'append' && event.data.message?.isError !== true ? openMatch(event) : null,
    'tool/ptc-dispatch': event => event.data.name === WORKBENCH_TOOL && !event.data.isError ? openMatch(event) : null,
  },
  start: (_context, match) => match.event.data.meta.scene,
  update: context => context.state,
  publication: () => 'immediate',
  buildViewNode: context => {
    const match = context.start
    if (!match) return null
    const current = context.current.get('chat')
    return current?.location === match.location ? current : {
      key: context.key,
      kind: PLUGIN_ID,
      id: context.id,
      target: 'chat',
      anchorSeq: match.event.seq,
      location: match.location,
      visibility: 'visible',
      groupTree: 'turn',
      data: context.state,
    }
  },
}
