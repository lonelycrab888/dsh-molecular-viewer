import { WORKBENCH_TOOL, workbenchId } from './workbench-contract.js'

export const VIEWER_ID = 'dsh-molecular-viewer'
export const TOOL_NAME = 'molecular_viewer'

function isOpenResult(meta) {
  return meta?.plugin === VIEWER_ID && meta.ok === true && meta.action === 'open' &&
    (typeof meta.scene?.url === 'string' || (meta.scene?.kind === 'workbench' && workbenchId(meta.scene.id)))
}

function turnMatch(turn) {
  return { id: String(turn), role: 'start' }
}

function eventTurn(event) {
  return event.type === 'tool/ptc-dispatch' ? event.data.meta.scene.turn : event.data.turn
}

function capture(state, event) {
  if (event.type === 'tool/call') {
    return { ...state, calls: new Set([...state.calls, event.data.callId]) }
  }
  if (event.data.meta.plugin === VIEWER_ID || state.calls.has(event.data.message?.source?.callId)) {
    return { ...state, scenes: [...state.scenes, event.data.meta.scene] }
  }
  return state
}

// Put the successful open result on its turn, where the Chat tail can
// render it independently of the user's work-details folding preference.
export const sceneDefinition = {
  kind: VIEWER_ID,
  match: {
    'tool/call': event => [TOOL_NAME, WORKBENCH_TOOL].includes(event.data.name) ? turnMatch(event.data.turn) : null,
    'tool/result': event => event.surfaceOp === 'append' && event.data.message?.isError !== true &&
      isOpenResult(event.data.meta) ? turnMatch(event.data.turn) : null,
    'tool/ptc-dispatch': event => [TOOL_NAME, WORKBENCH_TOOL].includes(event.data.name) && !event.data.isError &&
      isOpenResult(event.data.meta) && Number.isInteger(eventTurn(event)) ? turnMatch(eventTurn(event)) : null,
  },
  start: (_context, { event }) => capture({ turn: eventTurn(event), calls: new Set(), scenes: [] }, event),
  update: (context, { event }) => capture(context.state, event),
  buildLocationData: (context, scope, previous) => {
    const { scenes, turn } = context.state ?? {}
    if (scope !== 'turn' || !scenes?.length) return null
    if (previous?.value === scenes) return previous
    return { kind: 'turn', turn, key: VIEWER_ID, value: scenes }
  },
}
