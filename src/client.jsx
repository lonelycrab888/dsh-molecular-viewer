import { useSyncExternalStore } from 'react'
import { sceneDefinition } from './transcript.js'
import { registerWorkbenchClient, workbenchNavigation, WorkbenchCard, WORKBENCH_STYLE } from './workbench-client.jsx'
import { PLUGIN_ID, WORKBENCH_TOOL } from './workbench-contract.js'

const zh = navigator.language.toLowerCase().startsWith('zh')
const text = zh ? {
  title: '分子结构查看器',
  pending: '正在准备分子结构…',
  failed: '分子查看器操作失败',
  viewerHint: '三维查看器显示在回复下方',
} : {
  title: 'Molecular Structure Viewer',
  pending: 'Preparing molecular structure…',
  failed: 'Molecular viewer action failed',
  viewerHint: 'The 3D viewer appears below the reply',
}

function TranscriptViewer({ turn, sessionId, openResource, closeResource, openTabs }) {
  const source = turn.data.source(PLUGIN_ID)
  const snapshots = useSyncExternalStore(source.subscribe, source.getSnapshot)
  if (!snapshots || !sessionId) return null
  return <div className="mv-transcript">
    {snapshots.map(snapshot => <WorkbenchCard key={snapshot.id} snapshot={snapshot} sessionId={sessionId}
      openResource={openResource} closeResource={closeResource} openTabs={openTabs} />)}
  </div>
}

function ToolCard({ block, phase }) {
  if (phase !== 'result') return <div className="mv-skeleton" title={text.pending} />

  const meta = block?.meta
  const failed = block?.isError === true || meta?.ok === false
  const content = Array.isArray(block?.content)
    ? block.content.filter(part => part?.type === 'text').map(part => part.text).join('\n')
    : ''
  return <div className={failed ? 'mv-card mv-card-error' : 'mv-card'}>
    <div className="mv-icon">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
        <circle cx="8" cy="8" r="2" />
        <ellipse cx="8" cy="8" rx="6.4" ry="2.8" transform="rotate(30 8 8)" />
        <ellipse cx="8" cy="8" rx="6.4" ry="2.8" transform="rotate(-30 8 8)" />
      </svg>
    </div>
    <div className="mv-card-main">
      <div className="mv-card-title">{failed ? text.failed : meta?.scene?.title || text.title}</div>
      <div className="mv-card-sub">{meta?.error || meta?.summary || content || text.viewerHint}</div>
    </div>
  </div>
}

const CHAT_STYLE = `
.mv-transcript { display: grid; gap: 6px; min-width: 0; }
.mv-icon { width: 26px; height: 26px; flex: none; border-radius: 8px; display: grid; place-items: center; background: linear-gradient(135deg, rgba(91,141,239,.16), rgba(168,121,232,.16)); color: #6f8fe8; }
.mv-icon svg { width: 17px; height: 17px; display: block; }
.mv-empty { display: flex; align-items: center; gap: 8px; padding: 12px; color: var(--dsw-alias-label-tertiary, #64748b); font-size: 12px; }
.mv-card { border: 1px solid var(--dsw-alias-border-l2, rgba(148,163,184,.3)); border-radius: 12px; padding: 10px 12px; margin: 6px 0; display: flex; align-items: center; gap: 10px; background: var(--dsw-alias-bg-module-platform, #fff); }
.mv-card-main { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
.mv-card-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary, #0f172a); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mv-card-sub { font-size: 11px; color: var(--dsw-alias-label-tertiary, #64748b); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mv-card-error { border-color: rgba(239,68,68,.35); background: rgba(239,68,68,.04); }
.mv-card-error .mv-card-title { color: var(--dsw-alias-state-error-primary, #dc2626); }
.mv-skeleton { height: 42px; border-radius: 12px; margin: 6px 0; background: linear-gradient(90deg, rgba(148,163,184,.09), rgba(148,163,184,.16), rgba(148,163,184,.09)); background-size: 200% 100%; animation: mv-shimmer 1.6s linear infinite; }
@keyframes mv-shimmer { to { background-position: -200% 0; } }
`

function injectStyles() {
  const style = document.createElement('style')
  style.dataset.dshPlugin = PLUGIN_ID
  style.textContent = CHAT_STYLE + WORKBENCH_STYLE
  document.head.append(style)
  return () => style.remove()
}

export const inject = ['slots', 'uiConversation', 'sidebarRight', 'sidebarRightTabs', 'documentPreviews']

export function apply(ctx) {
  ctx.effect(injectStyles)
  registerWorkbenchClient(ctx)
  ctx.uiConversation.events.register(sceneDefinition)
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    id: PLUGIN_ID,
    inject: sessionId => ({ sessionId, ...workbenchNavigation(ctx, sessionId) }),
  }, TranscriptViewer))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: WORKBENCH_TOOL,
  }, ToolCard))
}
