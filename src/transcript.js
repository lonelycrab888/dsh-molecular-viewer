import { PLUGIN_ID, WORKBENCH_TOOL, workbenchId } from './workbench-contract.js'

function isOpenResult(meta) {
  return meta?.plugin === PLUGIN_ID && meta.ok === true && meta.action === 'open' &&
    meta.scene?.kind === 'workbench' && workbenchId(meta.scene.id)
}

function turnMatch(turn) {
  return Number.isInteger(turn) ? { id: String(turn), role: 'start' } : null
}

// Put successful workbench opens on their turn independently of work-details folding.
export const sceneDefinition = {
  kind: PLUGIN_ID,
  match: {
    'tool/result': event => event.surfaceOp === 'append' && event.data.message?.isError !== true &&
      isOpenResult(event.data.meta) ? turnMatch(event.data.turn) : null,
    'tool/ptc-dispatch': event => event.data.name === WORKBENCH_TOOL && !event.data.isError &&
      isOpenResult(event.data.meta) ? turnMatch(event.data.meta.scene.turn) : null,
  },
  start: (_context, { event }) => ({
    turn: event.type === 'tool/ptc-dispatch' ? event.data.meta.scene.turn : event.data.turn,
    scenes: [event.data.meta.scene],
  }),
  update: (context, { event }) => {
    const { state } = context
    const scene = event.data.meta.scene
    if (state.scenes.some(current => current.id === scene.id)) return state
    return { ...state, scenes: [...state.scenes, scene] }
  },
  buildLocationData: (context, scope, previous) => {
    const { scenes, turn } = context.state ?? {}
    if (scope !== 'turn' || !scenes?.length) return null
    if (previous?.value === scenes) return previous
    return { kind: 'turn', turn, key: PLUGIN_ID, value: scenes }
  },
}
