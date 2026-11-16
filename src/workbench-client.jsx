import React from 'react'
import {
  BINARY_STRUCTURE_EXTENSIONS, STRUCTURE_EXTENSIONS, WORKBENCH_PREVIEW, WORKBENCH_ROUTE, WORKBENCH_TAB, workbenchId,
} from './workbench-contract.js'

const { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } = React
const zh = navigator.language.toLowerCase().startsWith('zh')
const label = zh ? {
  title: '分子结构工作台',
  loading: '正在加载分子结构工作台…',
  open: '在对话中打开',
  hide: '收起工作台',
  retry: '重试',
  sidebar: '在侧栏打开',
  closeFullscreen: '退出全屏',
  measure: '最近重原子测距',
  cancelMeasure: '取消测距',
  firstResidue: '点选第一个残基。',
  nextResidue: '点选另一个残基。',
  distance: '最近重原子对',
} : {
  title: 'Molecular Structure Workbench',
  loading: 'Loading Molecular Structure Workbench…',
  open: 'Open in chat',
  hide: 'Collapse workbench',
  retry: 'Retry',
  sidebar: 'Open in sidebar',
  closeFullscreen: 'Exit fullscreen',
  measure: 'Closest heavy-atom distance',
  cancelMeasure: 'Cancel distance picking',
  firstResidue: 'Pick the first residue.',
  nextResidue: 'Pick a different residue.',
  distance: 'Closest heavy-atom pair',
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    ...(options.body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(options.body) } : {}),
  })
  const data = await response.json()
  if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`)
  return data
}

function useWorkbenchData(path, body, revision = 0) {
  const [state, setState] = useState(null)
  useEffect(() => {
    if (!path) return
    const abort = new AbortController()
    const input = body === undefined ? {} : { method: 'POST', body: JSON.parse(body) }
    request(path, { ...input, signal: abort.signal }).then(
      data => { if (!abort.signal.aborted) setState({ path, body, revision, data }) },
      error => { if (!abort.signal.aborted) setState({ path, body, revision, error: error.message }) },
    )
    return () => abort.abort()
  }, [path, body, revision])
  return state?.path === path && state?.body === body && state?.revision === revision ? state : null
}

function workbenchApi(sessionId, viewerId, action, params, signal) {
  return request(`${WORKBENCH_ROUTE}/api`, {
    method: 'POST', body: { action, sessionId, viewerId, ...params }, signal,
  })
}

function residueLabel(residue) {
  return `${residue.compId} ${residue.chain}:${residue.residueNumber}${residue.insertionCode ?? ''}`
}

function ResidueDistance({ sessionId, viewerId, lastDistance }) {
  const [measuring, setMeasuring] = useState(false)
  const [first, setFirst] = useState(null)
  const [measurement, setMeasurement] = useState(lastDistance ?? null)
  const [error, setError] = useState(null)
  useEffect(() => {
    if (!measuring) return
    const abort = new AbortController()
    let timer
    let baseline
    let chosen
    async function poll() {
      try {
        const { residue } = await workbenchApi(sessionId, viewerId, 'selected-residue', {}, abort.signal)
        if (abort.signal.aborted) return
        if (baseline === undefined) baseline = residue?.id ?? null
        if (residue && residue.id !== baseline) {
          if (!chosen) {
            chosen = residue
            setFirst(residue)
          } else if (residue.id !== chosen.id) {
            const result = await workbenchApi(sessionId, viewerId, 'residue-distance', { picks: [chosen, residue] }, abort.signal)
            if (abort.signal.aborted) return
            setMeasurement(result.data.state)
            setMeasuring(false)
            return
          }
        }
        timer = setTimeout(poll, 550)
      } catch (error) {
        if (abort.signal.aborted) return
        setError(error.message)
        setMeasuring(false)
      }
    }
    void poll()
    return () => { clearTimeout(timer); abort.abort() }
  }, [measuring, sessionId, viewerId])

  const pair = measurement?.measurement
  const formatEndpoint = (residue, atom) => `${residue.compId} ${residue.chain}:${residue.authSeqId}${residue.insertionCode ?? ''} ${atom}`
  return <div className="mv-workbench-measure">
    <button type="button" aria-pressed={measuring} onClick={() => {
      setError(null)
      setFirst(null)
      setMeasuring(value => !value)
    }}>{measuring ? label.cancelMeasure : label.measure}</button>
    {error ? <span role="alert">{error}</span> : null}
    {measuring ? <span role="status">{first ? `${residueLabel(first)} · ${label.nextResidue}` : label.firstResidue}</span> : null}
    {!measuring && pair ? <span aria-label={label.distance}>
      {formatEndpoint(measurement.first, pair.firstAtom)} · {formatEndpoint(measurement.second, pair.secondAtom)} · {pair.distanceAngstrom.toFixed(2)} Å
    </span> : null}
  </div>
}

function FullWorkbench({ endpoint, sessionId, viewerId, data, layout, title }) {
  const frame = useRef(null)
  const container = useRef(null)
  const mode = useRef('inline')
  const setMode = useRef(null)
  const [fullscreen, setFullscreen] = useState(false)

  useLayoutEffect(() => {
    const scope = new AbortController()
    const shell = container.current
    const viewer = frame.current
    const send = message => viewer.contentWindow?.postMessage({ jsonrpc: '2.0', ...message }, '*')
    const notify = (method, params) => send({ method, params })
    const availableDisplayModes = ['inline', 'fullscreen']
    const hostContext = () => ({
      displayMode: mode.current,
      availableDisplayModes,
      theme: getComputedStyle(document.documentElement).colorScheme.includes('dark') ? 'dark' : 'light',
      locale: navigator.language,
      platform: 'web',
    })

    setMode.current = (next) => {
      if (!availableDisplayModes.includes(next)) throw new Error('Unsupported workbench display mode.')
      if (next === mode.current) return next
      if (next === 'fullscreen' && shell.showPopover) {
        shell.setAttribute('popover', 'manual')
        shell.showPopover()
      }
      if (next === 'inline' && shell.hasAttribute('popover')) {
        shell.hidePopover()
        shell.removeAttribute('popover')
      }
      mode.current = next
      setFullscreen(next === 'fullscreen')
      notify('ui/notifications/host-context-changed', { displayMode: next })
      return next
    }

    function markActive() {
      if (document.activeElement !== viewer) return
      void workbenchApi(sessionId, viewerId, 'activate', {}, scope.signal).catch(() => {})
    }

    function handleEscape(event) {
      if (event.key === 'Escape' && mode.current === 'fullscreen') setMode.current('inline')
    }

    async function onMessage(event) {
      if (event.source !== viewer.contentWindow || event.origin !== 'null') return
      const { id, method, params } = event.data ?? {}
      if (method === 'ui/notifications/initialized') {
        notify('ui/notifications/tool-input', { arguments: data.args })
        notify('ui/notifications/tool-result', data.result)
        return
      }
      if (id === undefined || typeof method !== 'string') return
      try {
        let result
        switch (method) {
          case 'ui/initialize':
            result = {
              protocolVersion: params.protocolVersion,
              hostInfo: { name: 'DeepSeek Harness Molecular Workbench', version: '1.0.0' },
              hostCapabilities: { serverTools: {}, serverResources: {}, logging: {}, openLinks: {} },
              hostContext: hostContext(),
            }
            break
          case 'ui/request-display-mode':
            result = { mode: setMode.current(params.mode) }
            break
          case 'ui/open-link': {
            const url = new URL(params.url)
            if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Expected a public HTTPS link.')
            window.open(url.href, '_blank', 'noopener,noreferrer')
            result = {}
            break
          }
          case 'tools/call':
          case 'resources/read':
            result = (await workbenchApi(sessionId, viewerId, 'rpc', { method, params }, scope.signal)).result
            break
          default:
            throw new Error(`Unsupported DSH workbench request ${method}.`)
        }
        if (!scope.signal.aborted) send({ id, result })
      } catch (error) {
        if (!scope.signal.aborted) send({ id, error: { code: -32603, message: error.message } })
      }
    }

    window.addEventListener('message', onMessage, { signal: scope.signal })
    window.addEventListener('keydown', handleEscape, { signal: scope.signal })
    window.addEventListener('blur', () => setTimeout(markActive, 0), { signal: scope.signal })
    viewer.src = `${endpoint}/frame`
    return () => {
      notify('ui/resource-teardown', {})
      scope.abort()
      if (shell.hasAttribute('popover')) shell.hidePopover()
      setMode.current = null
    }
  }, [endpoint, sessionId, viewerId, data])

  return <div className={`mv-workbench-frame mv-workbench-${layout}${fullscreen ? ' mv-workbench-fullscreen' : ''}`} ref={container}>
    {fullscreen && <button type="button" className="mv-workbench-exit" onClick={() => setMode.current?.('inline')}>
      {label.closeFullscreen}
    </button>}
    <ResidueDistance sessionId={sessionId} viewerId={viewerId} lastDistance={data.lastDistance} />
    <iframe title={title || label.title} ref={frame} sandbox="allow-scripts allow-downloads" allow="clipboard-write *" referrerPolicy="no-referrer" />
  </div>
}

function WorkbenchFrame({ sessionId, id, layout, title }) {
  const [retry, setRetry] = useState(0)
  const endpoint = `${WORKBENCH_ROUTE}/${encodeURIComponent(sessionId)}/${id}`
  const state = useWorkbenchData(`${endpoint}/setup`, undefined, retry)
  if (state?.error) return <div className="mv-empty" role="alert">
    {state.error} <button type="button" onClick={() => setRetry(value => value + 1)}>{label.retry}</button>
  </div>
  if (!state?.data) return <p className="mv-empty" role="status">{label.loading}</p>
  return <FullWorkbench endpoint={endpoint} sessionId={sessionId} viewerId={id} data={state.data} layout={layout} title={title} />
}

function sessionCards() {
  let newest = null
  const listeners = new Set()
  return {
    getSnapshot: () => newest?.id,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    opened(snapshot) {
      if (newest && (newest.id === snapshot.id || newest.openedAt > snapshot.openedAt)) return
      newest = snapshot
      for (const listener of listeners) listener()
    },
  }
}

const cardsBySession = new Map()
const openedInSidebar = new Set()

export function sidebarAddress(id) {
  return `dsh-resource://dsh-molecular-workbench/viewer/${id}`
}

export function WorkbenchCard({ snapshot, sessionId, openResource, closeResource }) {
  if (!cardsBySession.has(sessionId)) cardsBySession.set(sessionId, sessionCards())
  const cards = cardsBySession.get(sessionId)
  const newest = useSyncExternalStore(cards.subscribe, cards.getSnapshot)
  const [manualVisibility, setVisible] = useState(null)
  const visible = manualVisibility ?? (newest === snapshot.id && snapshot.placement !== 'sidebar')
  const bodyId = useId()
  useLayoutEffect(() => { cards.opened(snapshot) }, [cards, snapshot])
  useEffect(() => {
    if (!openResource || newest !== snapshot.id || snapshot.placement !== 'sidebar' || openedInSidebar.has(snapshot.id)) return
    openedInSidebar.add(snapshot.id)
    openResource(sidebarAddress(snapshot.id))
  }, [newest, openResource, snapshot.id, snapshot.placement])
  return <section className="mv-workbench-card" aria-label={label.title}>
    <header className="mv-workbench-header">
      <strong>{snapshot.title}</strong>
      <button type="button" aria-expanded={visible} aria-controls={bodyId} onClick={() => {
        if (!visible) closeResource?.(sidebarAddress(snapshot.id))
        setVisible(!visible)
      }}>
        {visible ? label.hide : label.open}
      </button>
      {openResource && <button type="button" onClick={() => {
        setVisible(false)
        openResource(sidebarAddress(snapshot.id))
      }}>{label.sidebar}</button>}
    </header>
    <div id={bodyId}>
      {visible && <WorkbenchFrame sessionId={sessionId} id={snapshot.id} title={snapshot.title} layout="chat" />}
    </div>
  </section>
}

function SidebarWorkbench({ sessionId, useTabInfo }) {
  const { tab } = useTabInfo()
  const address = tab.navigation.address
  if (!address.startsWith(sidebarAddress(''))) return null
  const id = address.slice(sidebarAddress('').length)
  return workbenchId(id) && tab.visible
    ? <WorkbenchFrame sessionId={sessionId} id={id} layout="pane" />
    : null
}

function NativePreview({ sessionId, resourceAddress, content }) {
  const supported = content.kind === 'renderer'
  const body = JSON.stringify({ action: 'preview', sessionId, address: resourceAddress })
  const state = useWorkbenchData(supported ? `${WORKBENCH_ROUTE}/api` : null, body, content.revision)
  useEffect(() => {
    if (!supported) return
    if (state?.data) content.loaded(state.data.version)
    if (state?.error) content.failed()
  }, [content.loaded, content.failed, state, supported])
  if (!supported) return null
  if (state?.error) return <div className="mv-empty" role="alert">
    {state.error} <button type="button" onClick={content.reload}>{label.retry}</button>
  </div>
  if (!state?.data) return <p className="mv-empty" role="status">{label.loading}</p>
  const { scene } = state.data
  return <WorkbenchFrame sessionId={sessionId} id={scene.id} title={scene.title} layout="pane" />
}

export function registerWorkbenchClient(ctx) {
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: WORKBENCH_TAB, kind: WORKBENCH_TAB, patterns: [`${sidebarAddress('')}*`],
    title: () => label.title,
  }))
  ctx.effect(() => ctx.documentPreviews.register({
    id: WORKBENCH_PREVIEW,
    extensions: STRUCTURE_EXTENSIONS,
    binaryExtensions: BINARY_STRUCTURE_EXTENSIONS,
    title: () => label.title,
    loading: 'renderer',
  }))
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: WORKBENCH_TAB,
    inject: sessionId => ({ sessionId }),
  }, SidebarWorkbench)))
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
    name: 'sidebar.right.tab.document', key: WORKBENCH_PREVIEW,
    inject: sessionId => ({ sessionId }),
  }, NativePreview)))
}

export const WORKBENCH_STYLE = `
.mv-workbench-card { border: 1px solid color-mix(in srgb, currentColor 15%, transparent); border-radius: 10px; overflow: hidden; }
.mv-workbench-header { min-height: 36px; padding: 6px 10px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mv-workbench-header strong { margin-inline-end: auto; overflow-wrap: anywhere; }
.mv-workbench-header button, .mv-workbench-exit, .mv-workbench-measure button { color: inherit; background: transparent; border: 1px solid color-mix(in srgb, currentColor 23%, transparent); border-radius: 5px; padding: 3px 8px; cursor: pointer; }
.mv-workbench-measure { display: flex; padding: 4px 8px; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12px; }
.mv-workbench-frame { position: relative; width: 100%; min-width: 0; display: flex; flex-direction: column; }
.mv-workbench-chat { height: clamp(430px, 65vh, 680px); }
.mv-workbench-pane { height: 100%; min-height: 430px; }
.mv-workbench-frame iframe { display: block; width: 100%; flex: 1; min-height: 0; border: 0; }
.mv-workbench-fullscreen { position: fixed; inset: 0; z-index: 10000; margin: 0; padding: 0; border: 0; width: 100vw; height: 100dvh; max-height: none; background: Canvas; color: CanvasText; }
.mv-workbench-fullscreen::backdrop { background: Canvas; }
.mv-workbench-exit { align-self: flex-end; margin: 4px 8px; }
`
