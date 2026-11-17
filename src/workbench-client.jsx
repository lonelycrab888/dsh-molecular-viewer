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
  ready: '渲染已就绪',
  rendering: '正在连接并渲染…',
  renderError: '渲染失败',
  ask: '就选区提问',
  previewAsk: '就此预览的选区提问',
  cancel: '取消',
  question: '这个选区包含哪些结构特征？',
  send: '发送到对话',
  sent: '已发送选区问题',
  examples: '入门示例',
  running: '正在运行示例',
  exampleDone: '示例已完成',
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
  ready: 'Renderer ready',
  rendering: 'Connecting and rendering…',
  renderError: 'Rendering failed',
  ask: 'Ask about selection',
  previewAsk: 'Ask about this preview selection',
  cancel: 'Cancel',
  question: 'What structural features are present in this selection?',
  send: 'Send to chat',
  sent: 'Selection question sent',
  examples: 'Starter examples',
  running: 'Running example',
  exampleDone: 'Example complete',
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

function ViewerToolbar({ sessionId, viewerId, examples, retry, nativePreview }) {
  const [live, setLive] = useState(null)
  const [selection, setSelection] = useState(null)
  const [question, setQuestion] = useState(label.question)
  const [sending, setSending] = useState(false)
  const [feedback, setFeedback] = useState(null)
  useEffect(() => {
    const abort = new AbortController()
    let timer
    async function check() {
      let interval = 850
      try {
        const status = await workbenchApi(sessionId, viewerId, 'status', {}, abort.signal)
        if (!abort.signal.aborted) setLive(status)
        if (status.viewerReady && (!status.starter || status.starter.phase === 'complete')) interval = 2500
      } catch (error) {
        if (!abort.signal.aborted) setLive({ renderState: 'error', error: error.message })
      }
      if (!abort.signal.aborted) timer = setTimeout(check, interval)
    }
    void check()
    return () => { abort.abort(); clearTimeout(timer) }
  }, [sessionId, viewerId])

  const askLabel = nativePreview ? label.previewAsk : label.ask
  const renderFailed = live?.renderState === 'error'
  const starter = live?.starter
  async function submit(action, params) {
    setSending(true)
    setFeedback(null)
    try {
      const result = await workbenchApi(sessionId, viewerId, action, params)
      if (action === 'capture-selection') setSelection(result)
      if (action === 'ask-selection') {
        setSelection(null)
        setFeedback({ message: label.sent })
      }
    } catch (error) {
      setFeedback({ error: error.message })
    } finally {
      setSending(false)
    }
  }
  return <div className="mv-workbench-toolbar">
    <div className="mv-workbench-measure">
      <span role="status" title={live?.error ?? live?.state?.lastFailure?.message}>{renderFailed ? label.renderError : live?.viewerReady ? label.ready : label.rendering}</span>
      {renderFailed && <button type="button" onClick={retry}>{label.retry}</button>}
      <button type="button" aria-expanded={!!selection} disabled={sending || !live?.viewerReady}
        onClick={() => selection ? setSelection(null) : void submit('capture-selection', {})}>{askLabel}</button>
      {!!examples?.length && <details>
        <summary>{label.examples}</summary>
        <div className="mv-workbench-examples">
          {examples.map(example => <button key={example.id} type="button" disabled={sending}
            onClick={() => void submit('launch-example', { exampleId: example.id })}>{example.title}</button>)}
        </div>
      </details>}
      {feedback && <span role={feedback.error ? 'alert' : 'status'}>{feedback.error ?? feedback.message}</span>}
    </div>
    {selection && <form className="mv-workbench-measure" onSubmit={event => {
      event.preventDefault()
      void submit('ask-selection', { question, selectionId: selection.selectionId })
    }}>
      <div className="mv-selection-snapshot">
        <strong>{selection.source ?? selection.structure}</strong> · {selection.summary}
      </div>
      <input aria-label={askLabel} value={question} maxLength={1000} onChange={event => setQuestion(event.target.value)} />
      <button type="submit" disabled={sending || !question.trim()}>{label.send}</button>
      <button type="button" disabled={sending} onClick={() => setSelection(null)}>{label.cancel}</button>
    </form>}
    {starter && starter.phase !== 'pending' && <div className="mv-workbench-starter" role={starter.phase === 'error' ? 'alert' : 'status'}>
      {starter.phase === 'running' ? `${label.running} ${starter.step}/${starter.total}`
        : starter.phase === 'error' ? starter.error
          : <>{label.exampleDone}<ul>{starter.results.map((result, index) => <li key={index}>{result.summary}</li>)}</ul></>}
    </div>}
  </div>
}

function FullWorkbench({ endpoint, sessionId, viewerId, data, layout, title, move, retry, reveal, nativePreview }) {
  const frame = useRef(null)
  const container = useRef(null)
  const mode = useRef(layout === 'pane' && move ? 'fullscreen' : 'inline')
  const moveRef = useRef(move)
  moveRef.current = move
  const setMode = useRef(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [moveError, setMoveError] = useState(null)

  useLayoutEffect(() => {
    const scope = new AbortController()
    const shell = container.current
    const viewer = frame.current
    const send = message => viewer.contentWindow?.postMessage({ jsonrpc: '2.0', ...message }, '*')
    const notify = (method, params) => send({ method, params })
    const revealCard = () => {
      if (scope.signal.aborted) return
      const row = shell.closest('[data-chat-turn]')
      const chatFrame = row?.closest('[data-chat-flow]')?.parentElement?.parentElement?.parentElement
      const marks = chatFrame?.querySelectorAll('nav button[data-index][aria-label]') ?? []
      const mark = Array.from(marks).find(item => item.ariaLabel?.match(/\d+/)?.[0] === row.dataset.chatTurn)
      // Use the DSH Turn Navigator to release tail-follow before revealing the card itself.
      mark?.click()
      shell.closest('.mv-workbench-card')?.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' })
    }
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
      if (event.key === 'Escape' && mode.current === 'fullscreen' && !moveRef.current) setMode.current('inline')
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
        let nextPlacement
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
            if (!availableDisplayModes.includes(params.mode)) throw new Error('Unsupported workbench display mode.')
            if (moveRef.current) {
              if (params.mode !== mode.current) nextPlacement = params.mode === 'fullscreen' ? 'sidebar' : 'inline'
              result = { mode: params.mode }
            } else {
              result = { mode: setMode.current(params.mode) }
            }
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
            if (reveal && params.name === 'structure.acknowledge_renderer_hydrated' && result.structuredContent?.ready) {
              const bounds = viewer.getBoundingClientRect()
              if (bounds.bottom <= 0 || bounds.top >= window.innerHeight) requestAnimationFrame(revealCard)
            }
            break
          default:
            throw new Error(`Unsupported DSH workbench request ${method}.`)
        }
        if (!scope.signal.aborted) {
          send({ id, result })
          if (nextPlacement) {
            const target = nextPlacement
            setMoveError(null)
            setTimeout(() => {
              if (scope.signal.aborted) return
              void moveRef.current?.(target).catch(error => {
                if (!scope.signal.aborted) {
                  setMoveError(error.message)
                  notify('ui/notifications/host-context-changed', { displayMode: mode.current })
                }
              })
            }, 120)
          }
        }
      } catch (error) {
        if (!scope.signal.aborted) send({ id, error: { code: -32603, message: error.message } })
      }
    }

    window.addEventListener('message', onMessage, { signal: scope.signal })
    window.addEventListener('keydown', handleEscape, { signal: scope.signal })
    window.addEventListener('blur', () => setTimeout(markActive, 0), { signal: scope.signal })
    const token = crypto.randomUUID()
    void workbenchApi(sessionId, viewerId, 'attach-renderer', { token }, scope.signal).then(() => {
      if (scope.signal.aborted) return
      if (reveal) {
        viewer.addEventListener('load', () => requestAnimationFrame(revealCard), { once: true, signal: scope.signal })
      }
      viewer.src = `${endpoint}/frame`
    }, error => {
      if (!scope.signal.aborted) setMoveError(error.message)
    })
    return () => {
      notify('ui/resource-teardown', {})
      scope.abort()
      void request(`${WORKBENCH_ROUTE}/api`, {
        method: 'POST', keepalive: true, body: { action: 'detach-renderer', sessionId, viewerId, token },
      }).catch(() => {})
      if (shell.hasAttribute('popover')) shell.hidePopover()
      setMode.current = null
    }
  }, [endpoint, sessionId, viewerId, data, reveal])

  return <div className={`mv-workbench-frame mv-workbench-${layout}${fullscreen ? ' mv-workbench-fullscreen' : ''}`} ref={container}>
    {fullscreen && <button type="button" className="mv-workbench-exit" onClick={() => setMode.current?.('inline')}>
      {label.closeFullscreen}
    </button>}
    <ViewerToolbar sessionId={sessionId} viewerId={viewerId} examples={data.examples} retry={retry} nativePreview={nativePreview} />
    {moveError && <div className="mv-empty" role="alert">{moveError}</div>}
    <ResidueDistance sessionId={sessionId} viewerId={viewerId} lastDistance={data.lastDistance} />
    <iframe title={title || label.title} ref={frame} sandbox="allow-scripts allow-downloads" allow="clipboard-write *" referrerPolicy="no-referrer" />
  </div>
}

function WorkbenchFrame({ sessionId, id, layout, title, move, reveal, nativePreview }) {
  const [retry, setRetry] = useState(0)
  const endpoint = `${WORKBENCH_ROUTE}/${encodeURIComponent(sessionId)}/${id}`
  const state = useWorkbenchData(`${endpoint}/setup`, undefined, retry)
  if (state?.error) return <div className="mv-empty" role="alert">
    {state.error} <button type="button" onClick={() => setRetry(value => value + 1)}>{label.retry}</button>
  </div>
  if (!state?.data) return <p className="mv-empty" role="status">{label.loading}</p>
  return <FullWorkbench endpoint={endpoint} sessionId={sessionId} viewerId={id} data={state.data} layout={layout}
    title={title} move={move} reveal={reveal} nativePreview={nativePreview} retry={() => setRetry(value => value + 1)} />
}

function sessionCards() {
  let state = { newest: null, records: {}, locations: {} }
  const listeners = new Set()
  const publish = next => {
    state = next
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    opened(snapshot) {
      const time = snapshot.deliveredAt ?? snapshot.openedAt
      if (state.records[snapshot.id]?.time >= time) return
      const current = { id: snapshot.id, time }
      const newest = state.newest?.time > time ? state.newest : current
      const locations = { ...state.locations }
      delete locations[snapshot.id]
      publish({ newest, locations, records: { ...state.records, [snapshot.id]: current } })
    },
    place(id, location) {
      if (state.locations[id] === location) return
      publish({ ...state, locations: { ...state.locations, [id]: location } })
    },
  }
}

const cardsBySession = new Map()
const openedInSidebar = new Map()
const moving = new Map()

function cardsFor(sessionId) {
  if (!cardsBySession.has(sessionId)) cardsBySession.set(sessionId, sessionCards())
  return cardsBySession.get(sessionId)
}

export function sidebarAddress(id) {
  return `dsh-resource://dsh-molecular-workbench/viewer/${id}`
}

export function workbenchNavigation(ctx, sessionId) {
  return {
    openResource: address => ctx.sidebarRight.openResourceIn(sessionId, address),
    openTabs: ctx.sidebarRight.openTabs,
    closeResource: address => {
      const tab = ctx.sidebarRight.openTabs.getSnapshot().find(item => item.sessionId === sessionId && item.contentId === address)
      if (tab) ctx.sidebarRight.closeIn(sessionId, tab.tabId)
    },
  }
}

async function transferWorkbench(sessionId, viewerId, target, navigation) {
  const key = `${sessionId}/${viewerId}`
  const pending = moving.get(key)
  if (pending) return pending
  const transfer = (async () => {
    let settled = false
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const { state } = await workbenchApi(sessionId, viewerId, 'status', {})
      const revision = state.sceneApplied?.sceneRevision
      const saved = state.durablySaved?.sceneRevision
      if (!state.pendingCommands && !state.deliveredCommands &&
          (revision == null || (saved != null && saved >= revision))) {
        settled = true
        break
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    if (!settled) throw new Error(zh ? '工作台还在保存当前场景，请稍后再试。' : 'The workbench is saving this scene. Try again shortly.')
    await workbenchApi(sessionId, viewerId, 'placement', { placement: target })
    const address = sidebarAddress(viewerId)
    cardsFor(sessionId).place(viewerId, target)
    if (target === 'sidebar') navigation.openResource(address)
    else navigation.closeResource(address)
  })()
  moving.set(key, transfer)
  try {
    await transfer
  } finally {
    if (moving.get(key) === transfer) moving.delete(key)
  }
}

export function WorkbenchCard({ snapshot, sessionId, openResource, closeResource, openTabs }) {
  const cards = cardsFor(sessionId)
  const state = useSyncExternalStore(cards.subscribe, cards.getSnapshot)
  const time = snapshot.deliveredAt ?? snapshot.openedAt
  const liveDelivery = useRef(Date.now() - time < 15000).current
  const moved = state.records[snapshot.id]?.time > time
  const location = state.locations[snapshot.id]
  const newest = state.newest?.id === snapshot.id
  const tabs = useSyncExternalStore(openTabs.subscribe, openTabs.getSnapshot)
  const sidebar = tabs.some(tab => tab.sessionId === sessionId && tab.contentId === sidebarAddress(snapshot.id))
  const endpoint = `${WORKBENCH_ROUTE}/${encodeURIComponent(sessionId)}/${snapshot.id}`
  const saved = useWorkbenchData(newest && !moved && !location ? `${endpoint}/location` : null)
  const placement = saved?.data?.placement ?? (saved?.error ? snapshot.placement : undefined)
  const visible = !moved && !sidebar && (location ? location === 'inline' : newest && placement === 'inline')
  const bodyId = useId()
  const [error, setError] = useState(null)
  useLayoutEffect(() => { cards.opened(snapshot) }, [cards, snapshot])
  useEffect(() => {
    const key = `${sessionId}/${snapshot.id}`
    if (!openResource || moved || !newest || location || sidebar ||
        placement !== 'sidebar' || openedInSidebar.get(key) === time) return
    openedInSidebar.set(key, time)
    openResource(sidebarAddress(snapshot.id))
  }, [openResource, sessionId, moved, newest, location, sidebar, snapshot.id, placement, time])
  if (moved) return null
  const move = target => transferWorkbench(sessionId, snapshot.id, target, { openResource, closeResource })
  return <section className="mv-workbench-card" aria-label={label.title}>
    <header className="mv-workbench-header">
      <strong>{snapshot.title}</strong>
      <button type="button" aria-expanded={visible} aria-controls={bodyId} onClick={() => {
        setError(null)
        if (visible) cards.place(snapshot.id, 'closed')
        else void move('inline').catch(error => setError(error.message))
      }}>
        {visible ? label.hide : label.open}
      </button>
      {openResource && <button type="button" onClick={() => {
        setError(null)
        void move('sidebar').catch(error => setError(error.message))
      }}>{label.sidebar}</button>}
    </header>
    {error && <div className="mv-empty" role="alert">{error}</div>}
    <div id={bodyId}>
      {visible && <WorkbenchFrame sessionId={sessionId} id={snapshot.id} title={snapshot.title} layout="chat" move={move} reveal={location === 'inline' || liveDelivery} />}
    </div>
  </section>
}

function SidebarWorkbench({ sessionId, useTabInfo, openResource, closeResource }) {
  const { tab } = useTabInfo()
  const address = tab.navigation.address
  if (!address.startsWith(sidebarAddress(''))) return null
  const id = address.slice(sidebarAddress('').length)
  return workbenchId(id) && tab.visible
    ? <WorkbenchFrame sessionId={sessionId} id={id} layout="pane"
      move={target => transferWorkbench(sessionId, id, target, { openResource, closeResource })} />
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
  return <WorkbenchFrame sessionId={sessionId} id={scene.id} title={scene.title} layout="pane" nativePreview />
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
    inject: sessionId => ({ sessionId, ...workbenchNavigation(ctx, sessionId) }),
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
.mv-workbench-toolbar { padding-inline: 4px; }
.mv-workbench-toolbar details { position: relative; }
.mv-workbench-toolbar summary { cursor: pointer; }
.mv-workbench-examples { display: grid; gap: 4px; padding: 6px 0; }
.mv-selection-snapshot { flex-basis: 100%; overflow-wrap: anywhere; }
.mv-workbench-toolbar input { min-width: 12em; flex: 1; }
.mv-workbench-starter { max-height: 88px; overflow: auto; padding: 4px 8px; font-size: 12px; }
.mv-workbench-starter ul { margin: 4px 0; padding-inline-start: 18px; }
.mv-workbench-frame { position: relative; width: 100%; min-width: 0; display: flex; flex-direction: column; }
.mv-workbench-chat { height: clamp(430px, 65vh, 680px); }
.mv-workbench-pane { height: 100%; min-height: 430px; }
.mv-workbench-frame iframe { display: block; width: 100%; flex: 1; min-height: 0; border: 0; }
.mv-workbench-fullscreen { position: fixed; inset: 0; z-index: 10000; margin: 0; padding: 0; border: 0; width: 100vw; height: 100dvh; max-height: none; background: Canvas; color: CanvasText; }
.mv-workbench-fullscreen::backdrop { background: Canvas; }
.mv-workbench-exit { align-self: flex-end; margin: 4px 8px; }
`
