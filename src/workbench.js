import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { downloadStructureBytes, MAX_STRUCTURE_BYTES } from './download.js'
import { connectWorkbench } from './workbench-engine.js'
import { prepareStarter, runStarter, starters } from './starter-examples.js'
import { PLUGIN_ID, STRUCTURE_EXTENSIONS, WORKBENCH_ROUTE, WORKBENCH_TOOL, workbenchId } from './workbench-contract.js'

const workbenchActions = new Set(['open', 'viewers', 'status', 'wait', 'context', 'operations', 'help', 'run', 'examples'])
const shorthandOperations = new Map([
  ['status', 'structure.get_viewer_status'],
  ['context', 'structure.get_context'],
])
const MAX_READY_WAIT_MS = 15_000
const openIntentUuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const rendererIndependent = new Set(['structure.get_render_job_control', 'structure.cancel_render'])
const blockedOpen = new Set(['structure.open', 'structure.open_from_chat', 'structure.open_in_side_pane'])
const publishingOperations = new Set([
  'structure.export', 'structure.render_image', 'structure.render_movie', 'structure.load_public_density',
])
const CSP = [
  "default-src 'none'", "script-src 'unsafe-inline' blob:", "style-src 'unsafe-inline' blob:",
  'img-src data: blob:', 'worker-src blob:', 'font-src data:', 'media-src blob: data:',
  "base-uri 'none'", "form-action 'none'", 'sandbox allow-scripts allow-downloads',
].join('; ')

function profileDirectory() {
  return resolve(process.env.DSH_HOME || join(homedir(), '.dsh'), 'cache', 'dsh-molecular-workbench')
}

function containsPath(root, absolutePath) {
  const portion = relative(root, absolutePath)
  return portion !== '..' && !portion.startsWith(`..${sep}`) && !isAbsolute(portion)
}

async function sourcePath(root, address) {
  const file = await realpath(resolve(root, address))
  if (!containsPath(root, file)) {
    throw Object.assign(new Error('This structure is outside the current DSH workspace. Use Import structures beside the DSH composer, or open its containing directory as a DSH workspace and retry.'), { code: 'outside_workspace' })
  }
  if (!(await stat(file)).isFile()) throw new Error('Choose a regular structure file.')
  return file
}

function importSource(input) {
  if (/^(?:pdb:)?[1-9][a-z0-9]{3}$/i.test(input)) {
    const id = input.replace(/^pdb:/i, '').toUpperCase()
    return { url: `https://files.rcsb.org/download/${id}.cif`, name: `${id}.cif` }
  }
  if (/^https:\/\//i.test(input)) return { url: input }
  if (/^data_\S+/i.test(input)) return { text: input, name: 'inline.cif' }
  if (/^(?:ATOM  |HETATM|HEADER|TITLE )/m.test(input)) return { text: input, name: 'inline.pdb' }
  return undefined
}

function safeDownloadName(url, bytes) {
  const name = basename(decodeURIComponent(url.pathname)).replace(/[^a-z0-9._-]/gi, '_').slice(-150)
  if (STRUCTURE_EXTENSIONS.some(extension => name.toLowerCase().endsWith(`.${extension}`))) return name
  const start = bytes.toString('utf8', 0, 1024).trimStart()
  if (/^(?:#.*\n)*data_/i.test(start)) return 'download.cif'
  if (/^(?:HEADER|TITLE |ATOM  |HETATM|MODEL )/m.test(start)) return 'download.pdb'
  throw new Error('The download needs a supported filename extension or recognizable PDB/mmCIF text.')
}

async function importStructure(root, source, signal) {
  let bytes
  let name = source.name
  if (source.url) {
    const download = await downloadStructureBytes(source.url, signal, 'Molecular structure')
    bytes = download.bytes
    name ??= safeDownloadName(download.url, bytes)
  } else {
    if (Buffer.byteLength(source.text) > MAX_STRUCTURE_BYTES) throw new Error('Structure file exceeds the 40 MiB limit.')
    bytes = Buffer.from(source.text)
  }
  return stageStructure(root, name, bytes, signal)
}

async function stageStructure(root, name, bytes, signal) {
  signal?.throwIfAborted()
  const base = join(root, '.dsh-molecular-sources')
  await mkdir(base, { mode: 0o700 }).catch(error => {
    if (error.code !== 'EEXIST') throw error
  })
  if (!(await lstat(base)).isDirectory() || await realpath(base) !== base) {
    throw new Error('The molecular source directory must be a local workspace directory.')
  }
  const directory = await mkdtemp(join(base, 'source-'))
  try {
    const file = join(directory, name)
    await writeFile(file, bytes, { flag: 'wx', mode: 0o600, signal })
    return { file, directory }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

function scene(record, turn) {
  return {
    kind: 'workbench', id: record.id, title: record.title, placement: record.placement, openedAt: record.openedAt,
    deliveredAt: record.deliveredAt ?? record.openedAt,
    ...(record.starterId ? { starterId: record.starterId } : {}),
    ...(turn === undefined ? {} : { turn }),
  }
}

function makeDirectory(owner) {
  return join(profileDirectory(), createHash('sha256').update(owner).digest('hex'))
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

async function parseBody(request) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new Error('The request requires application/json.')
  }
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 32 * 1024 * 1024) throw new Error('The workbench request exceeds 32 MiB.')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function visibleTo(tool, audience) {
  return tool?._meta?.ui?.visibility?.includes(audience)
}

function publicResult(action, result) {
  const text = result.content?.filter(part => part.type === 'text').map(part => part.text).join('\n')
  const ok = !result.isError && result.structuredContent?.applied !== false
  return {
    ok,
    action,
    summary: text || (!ok ? 'The molecular operation failed.' : 'Molecular operation completed.'),
    ...(result.structuredContent === undefined ? {} : { data: result.structuredContent }),
  }
}

async function writePrivateJson(directory, file, value) {
  const temporary = join(directory, `record-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
    await rename(temporary, join(directory, file))
  } finally {
    await rm(temporary, { force: true })
  }
}

async function readLastDistance(directory) {
  try {
    return JSON.parse(await readFile(join(directory, 'last-distance.json'), 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return undefined
  }
}

async function callForViewer(engine, record, operation, input, signal) {
  return engine.call(operation, { ...input, sessionId: record.sessionId }, signal)
}

async function runForViewer(engine, record, directory, operation, input, signal) {
  const result = await callForViewer(engine, record, operation, input, signal)
  if (!result.isError && result.structuredContent?.applied !== false && operation === 'structure.control_viewer' && input.action === 'measure_residue_distance') {
    const measurement = result.structuredContent?.state
    const revised = await callForViewer(engine, record, 'structure.get_context', {
      sections: ['overview'], maxItems: 1,
    }, signal)
    const geometryRevision = revised.structuredContent?.geometryRevision
    if (measurement?.measurement && Number.isInteger(geometryRevision)) {
      await writePrivateJson(directory, 'last-distance.json', {
        geometryRevision, summary: publicResult('run', result).summary, measurement,
      })
    }
  }
  if (!result.isError && operation === 'structure.get_context') {
    const lastDistance = await readLastDistance(directory)
    if (lastDistance && lastDistance.geometryRevision === result.structuredContent?.geometryRevision) {
      return {
        ...result,
        content: [...(result.content ?? []), { type: 'text', text: `Last closest-heavy-atom measurement: ${lastDistance.summary}` }],
        structuredContent: { ...result.structuredContent, lastResidueDistance: lastDistance.measurement },
      }
    }
  }
  return result
}

async function selectedResidue(engine, record, signal) {
  const context = await callForViewer(engine, record, 'structure.get_context', {
    sections: ['selection'], maxItems: 1,
  }, signal)
  if (context.isError) throw new Error(publicResult('context', context).summary)
  const selected = context.structuredContent?.sections?.selection?.selected
  if (!selected?.atomCount) return null
  const result = await callForViewer(engine, record, 'structure.query', {
    expression: { kind: 'current', target: 'selection' }, level: 'residue', limit: 2,
    sceneRevision: context.structuredContent.revision,
  }, signal)
  const query = result.structuredContent?.state?.query
  return query?.rows?.length === 1 && !query.nextCursor ? query.rows[0] : null
}

function rpcParams(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a molecular operation argument object.')
  }
  return value
}

function operationName(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Supply a nonempty operation name, such as "structure.get_state".')
  }
  const name = value.trim()
  return name.includes('.') ? name : `structure.${name}`
}

function normalizeToolCall(value) {
  const args = rpcParams(value)
  let action = args.action
  let operation = args.operation
  if (action === undefined && operation !== undefined) {
    action = 'run'
  } else if (typeof action === 'string' && action.trim() && !workbenchActions.has(action) && operation === undefined) {
    operation = action
    action = 'run'
  }
  if (!workbenchActions.has(action)) {
    throw new Error('Choose a workbench action, such as "open" or "operations", or specify an operation such as "structure.get_state".')
  }
  if (action === 'run' || action === 'help') operation = operationName(operation)
  else operation = shorthandOperations.get(action)

  if (args.arguments !== undefined && args.params !== undefined) {
    throw new Error('Supply operation parameters in one field, either "arguments" or "params".')
  }
  const input = args.arguments !== undefined ? args.arguments : args.params
  if (input === undefined) return { ...args, action, operation }
  const { viewerId, ...parameters } = rpcParams(input)
  if (args.viewerId !== undefined && viewerId !== undefined && args.viewerId !== viewerId) {
    throw new Error('Supply one consistent viewerId for the operation.')
  }
  return { ...args, action, operation, viewerId: args.viewerId ?? viewerId, arguments: parameters }
}

const tool = {
  name: WORKBENCH_TOOL,
  description: [
    'Open and control the live Mol* Molecular Structure Workbench in DSH.',
    'Use open with a workspace file path, RCSB PDB ID, public HTTPS URL, inline PDB/mmCIF, or exampleId "gfp-1ema".',
    'Repeated opens of the same unchanged source in the same conversation reuse its workbench. Use reopen with a fresh openIntentId for a separate viewer. After open, if viewerReady is false, call wait once for that viewerId before scene operations. If it is still pending, ask the user to show the existing card in DSH and resume after rendering is ready. Compare structures by adding them to that same viewer.',
    'Use context after the user selects or measures something in the viewer. Prefer this tool for new interactive visualizations.',
    'Use action "operations" to list operations or action "help" with an operation name to obtain its input schema. Both work before opening a viewer.',
    'Use action examples to list packaged starters. Pass a starter exampleId to open and run it in one workbench. For example, inspect a live viewer with {"action":"run","operation":"structure.get_state"}. The operation name can also be passed as action, or by itself in operation.',
    'For revision-guarded operations, read structure.get_state after viewerReady is true. Use only successful live results when reporting plugin measurements or exports.',
  ].join(' '),
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', description: 'open, viewers, status, wait, context, operations, help, run, or examples. Also accepts a structure.* operation name as a shortcut.' },
      source: { type: 'string', description: 'A workspace file, RCSB PDB ID, public HTTPS URL, or inline PDB/mmCIF text.' },
      exampleId: { type: 'string', description: 'Use gfp-1ema for the bundled structure. Use action examples for the three guided workflows.' },
      viewerId: { type: 'string', description: 'DSH viewer ID from open or viewers. Defaults to the active viewer.' },
      placement: { type: 'string', enum: ['inline', 'sidebar'], description: 'Initial location for a newly opened viewer. Defaults to inline.' },
      waitTimeoutMs: { type: 'integer', minimum: 0, maximum: MAX_READY_WAIT_MS, description: 'Maximum time to wait for rendering with action wait. Defaults to 8000 milliseconds.' },
      openIntentId: { type: 'string', description: 'Optional UUID for the open request. Reuse it for retries.' },
      reopen: { type: 'boolean', description: 'Create a separate workbench with a fresh openIntentId.' },
      operation: { type: 'string', description: 'For help, run, or when action is omitted. For example, structure.get_state.' },
      arguments: { type: 'object', additionalProperties: true, description: 'Operation arguments. The workbench supplies sessionId.' },
      params: { type: 'object', additionalProperties: true, description: 'Alias for arguments. Supply only one of these fields.' },
    },
  },
  output: {
    schema: {
      type: 'object',
      required: ['ok', 'action', 'summary'],
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        action: { type: 'string' },
        summary: { type: 'string' },
        scene: { type: 'object', additionalProperties: true },
        data: { type: 'object', additionalProperties: true },
      },
    },
    render: (_args, value) => [{
      type: 'text',
      text: value.data === undefined ? value.summary : `${value.summary}\n${JSON.stringify(value.data)}`,
    }],
    presentationMeta: (_args, value) => ({
      plugin: PLUGIN_ID, ok: value.ok, action: value.action, summary: value.summary, scene: value.scene ?? null,
      waitingForViewer: value.data?.retryable === true,
    }),
  },
}

export function registerWorkbench(ctx, turns) {
  const engines = new Map()
  const previewOpens = new Map()
  const openRequests = new Map()
  const starterRuns = new Map()
  const renderers = new Map()
  const latest = new Map()

  async function resolveRoot(agent, signal) {
    return realpath(await ctx.workingDirectory.ensure(agent, signal))
  }

  function engineFor(directory, root) {
    let engine = engines.get(directory)
    if (!engine) {
      engine = connectWorkbench(root, join(directory, 'engine'))
      engines.set(directory, engine)
      engine.catch(() => engines.delete(directory))
    }
    return engine
  }

  async function readPrivateJson(directory, file) {
    return readFile(join(directory, file), 'utf8').then(JSON.parse, error => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
  }

  async function getRecord(owner, id, root) {
    if (typeof owner !== 'string' || !owner || !workbenchId(id)) throw new Error('Unknown molecular workbench.')
    const directory = join(makeDirectory(owner), id)
    const record = JSON.parse(await readFile(join(directory, 'viewer.json'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') throw new Error('Unknown molecular workbench.')
      throw error
    }))
    if (record.owner !== owner || record.id !== id || (root && record.root !== root)) {
      throw new Error('Unknown molecular workbench.')
    }
    const location = await readPrivateJson(directory, 'placement.json')
    if (location) record.placement = location.placement
    return { record, directory }
  }

  async function activate(record) {
    const current = { id: record.id, title: record.title }
    latest.set(record.owner, current)
    await writePrivateJson(makeDirectory(record.owner), 'latest.json', current)
  }

  function activeRecord(owner) {
    let current = latest.get(owner)
    if (!current) {
      try {
        current = JSON.parse(readFileSync(join(makeDirectory(owner), 'latest.json'), 'utf8'))
        latest.set(owner, current)
      } catch {
        return undefined
      }
    }
    return current
  }

  async function listRecords(owner, root) {
    const ownerDirectory = makeDirectory(owner)
    const files = await readdir(ownerDirectory).catch(error => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    const records = await Promise.all(files.filter(workbenchId).map(id => getRecord(owner, id, root).catch(() => null)))
    return records.filter(Boolean).sort((left, right) => right.record.openedAt - left.record.openedAt)
  }

  async function openWorkbench(owner, root, input, signal, previewAddress) {
    const { path } = input
    const id = randomUUID()
    const directory = join(makeDirectory(owner), id)
    const args = {
      ...(path ? { path } : { exampleId: input.exampleId }),
      openIntentId: input.openIntentId ?? randomUUID(),
    }
    await mkdir(directory, { recursive: true, mode: 0o700 })
    try {
      const engine = await engineFor(directory, root)
      const presentation = await engine.call('structure.open_from_chat', args, signal)
      const sessionId = presentation.structuredContent?.viewerSessionId
      const template = presentation._meta?.['openai/outputTemplate']
      if (presentation.isError || !sessionId || !template) {
        throw new Error(publicResult('open', presentation).summary)
      }
      const record = {
        id, owner, root, openedAt: Date.now(), sessionId, template, presentation, args, previewAddress,
        sourceKey: input.sourceKey, starterId: input.starterId, cardTurn: input.cardTurn,
        title: starters.get(input.starterId)?.title ?? (path ? basename(path) : 'Green fluorescent protein (1EMA)'),
        placement: input.placement ?? 'inline',
      }
      await writePrivateJson(directory, 'viewer.json', record)
      await activate(record)
      return record
    } catch (error) {
      const engine = engines.get(directory)
      engines.delete(directory)
      await (await engine?.catch(() => null))?.close()
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  }

  function requireWorkspaceWrite(agent) {
    const policy = ctx.sandboxPolicy.resolve({ session: agent.session })
    if (policy.mode === 'read-only') throw new Error('The DSH session is read-only. This operation writes a workspace artifact.')
  }

  async function prepareSource(root, args) {
    if (Boolean(args.source) === Boolean(args.exampleId)) {
      throw new Error('Supply one workspace source file or exampleId.')
    }
    if (args.exampleId) {
      return { key: JSON.stringify(['example', args.exampleId]), starter: starters.get(args.exampleId) }
    }

    const imported = importSource(args.source.trim())
    const hasLocalAccessionFile = imported?.name && imported.url &&
      await stat(resolve(root, args.source)).then(info => info.isFile(), () => false)
    if (imported && !hasLocalAccessionFile) {
      const address = imported.url ? new URL(imported.url).href : imported.text
      return { imported, key: createHash('sha256').update(address).digest('hex') }
    }
    const path = await sourcePath(root, args.source)
    const info = await stat(path, { bigint: true })
    const version = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':')
    return { path, modifiedAt: Number(info.ctimeMs), key: JSON.stringify(['file', path, version]) }
  }

  async function createAgentWorkbench(agent, root, args, source, turn, signal) {
    const input = { ...args, path: source.path, sourceKey: source.key, cardTurn: turn }
    if (!source.imported && !source.starter) return openWorkbench(agent.id, root, input, signal)
    requireWorkspaceWrite(agent)
    const prepared = source.starter
      ? await prepareStarter(root, source.starter, signal)
      : await importStructure(root, source.imported, signal)
    try {
      return await openWorkbench(agent.id, root, {
        ...input, path: await sourcePath(root, prepared.path ?? prepared.file), starterId: source.starter?.id,
      }, signal)
    } catch (error) {
      await rm(prepared.directory, { recursive: true, force: true })
      throw error
    }
  }

  function matchesSource(record, source, args) {
    if (record.sourceKey) return record.sourceKey === source.key
    if (source.path) return record.args.path === source.path && source.modifiedAt <= record.openedAt
    return !!args.exampleId && record.args.exampleId === args.exampleId
  }

  function viewerLifecycle(record, state) {
    const renderer = renderers.get(record.id)
    const attached = renderer?.attached === true
    const stale = renderer && (!attached || renderer.previousIncarnation === undefined ||
      (renderer.previousIncarnation !== null && state?.rendererIncarnationId === renderer.previousIncarnation) ||
      (state?.rendererIncarnationId == null && state?.rendered?.observedAtMs < renderer.attachedAt))
    const mounted = !stale && state?.mounted?.status === 'mounted' && state.mounted.hydrated === true
    const renderState = stale ? 'pending' : state?.rendered?.status ?? 'pending'
    const viewerReady = mounted && renderState === 'ready'
    return {
      viewerReady,
      mountState: mounted ? 'mounted' : 'mount-pending',
      renderState,
      surfaceState: viewerReady ? 'ready'
        : renderState === 'error' ? 'render-failed'
          : mounted ? 'rendering'
            : attached ? 'mounting' : 'awaiting-surface',
    }
  }

  async function readViewerStatus(engine, record, signal) {
    const result = await callForViewer(engine, record, 'structure.get_viewer_status', {}, signal)
    if (result.isError || !result.structuredContent) {
      const { summary } = publicResult('status', result)
      // On host restart the durable card is known before its renderer restores the engine session.
      if (!summary.includes('viewer session is not available to this connection')) throw new Error(summary)
      const state = {
        sessionId: record.sessionId, accepted: false, rendererIncarnationId: null,
        mounted: { status: 'pending', hydrated: false, observedAtMs: null },
        rendered: { status: 'pending', renderRevision: null, observedAtMs: null },
        pendingCommands: 0, deliveredCommands: 0, lastFailure: null,
      }
      return { ...state, ...viewerLifecycle(record, state) }
    }
    const state = result.structuredContent
    return { ...state, ...viewerLifecycle(record, state) }
  }

  function pendingViewer(action, record, status) {
    const failed = status.surfaceState === 'render-failed'
    const code = failed ? 'viewer_render_failed'
      : status.mountState === 'mounted' ? 'viewer_render_pending' : 'viewer_mount_pending'
    const summary = failed
      ? 'Rendering failed. Use Retry on the existing workbench, then check its status.'
      : status.surfaceState === 'awaiting-surface'
        ? 'The workbench session is open and needs its DSH card or sidebar visible. Show the existing workbench, then wait for it to render.'
        : 'The existing workbench is loading. Use action "wait" or continue once viewerReady is true.'
    return {
      ok: false, action, summary,
      data: {
        code, retryable: !failed, viewerId: record.id, ...status,
      },
    }
  }

  async function waitForViewer(engine, record, args, signal) {
    const timeout = args.waitTimeoutMs ?? 8000
    if (!Number.isInteger(timeout) || timeout < 0 || timeout > MAX_READY_WAIT_MS) {
      throw new Error(`waitTimeoutMs must be an integer from 0 to ${MAX_READY_WAIT_MS}.`)
    }
    const deadline = performance.now() + timeout
    for (;;) {
      const status = await readViewerStatus(engine, record, signal)
      if (status.viewerReady) {
        return { ok: true, action: args.action, summary: 'The workbench is mounted and rendered.', data: { viewerId: record.id, ...status } }
      }
      const remaining = deadline - performance.now()
      if (status.renderState === 'error' || remaining <= 0) return pendingViewer(args.action, record, status)
      await delay(Math.min(250, remaining), undefined, { signal })
    }
  }

  async function openForAgent(agent, root, args, turn, signal) {
    signal?.throwIfAborted()
    const intent = args.openIntentId?.toLowerCase()
    if (intent !== undefined && !openIntentUuid.test(intent)) throw new Error('openIntentId must be a UUID.')
    if (args.reopen && !intent) throw new Error('Supply a fresh openIntentId UUID when reopen is true.')
    const source = await prepareSource(root, args)
    const lock = JSON.stringify([agent.id, root])
    const waiting = openRequests.get(lock)
    const task = (async () => {
      await waiting?.catch(() => {})
      signal?.throwIfAborted()
      const records = (await listRecords(agent.id, root)).filter(({ record }) => !record.previewAddress)
      const replay = intent && records.find(({ record }) =>
        record.args.openIntentId === intent || record.openIntentAliases?.includes(intent))
      if (replay && !matchesSource(replay.record, source, args)) {
        throw new Error('This openIntentId belongs to another source or file revision. Use a new UUID.')
      }
      const existing = replay || (!args.reopen && records.find(({ record }) => matchesSource(record, source, args)))
      if (existing) {
        const { record, directory } = existing
        const engine = await engineFor(directory, root)
        const live = await readViewerStatus(engine, record, signal)
        const present = !live.viewerReady && record.cardTurn !== turn
        if (intent && record.args.openIntentId !== intent && !record.openIntentAliases?.includes(intent)) {
          record.openIntentAliases = [...(record.openIntentAliases ?? []), intent]
        }
        if (present) {
          record.cardTurn = turn
          record.deliveredAt = Math.max(Date.now(), (record.deliveredAt ?? record.openedAt) + 1)
        }
        record.sourceKey = source.key
        await writePrivateJson(directory, 'viewer.json', record)
        await activate(record)
        return { record, reused: true, present, live }
      }
      const record = await createAgentWorkbench(agent, root, { ...args, openIntentId: intent }, source, turn, signal)
      return { record, reused: false, present: true, live: {
        viewerReady: false, mountState: 'presentation-issued', renderState: 'pending', surfaceState: 'awaiting-surface',
      } }
    })()
    openRequests.set(lock, task)
    try {
      return await task
    } finally {
      if (openRequests.get(lock) === task) openRequests.delete(lock)
    }
  }

  async function starterStatus(directory) {
    return starterRuns.get(directory)?.state ?? await readPrivateJson(directory, 'starter-result.json') ?? { phase: 'pending' }
  }

  async function maybeStartExample(engine, record, directory, live) {
    const existing = await starterStatus(directory)
    if (!live.viewerReady || existing.phase !== 'pending' || starterRuns.has(directory)) return existing
    const starter = starters.get(record.starterId)
    if (!starter) throw new Error('The starter definition is unavailable.')
    const controller = new AbortController()
    const task = { controller, state: { phase: 'running', step: 1, total: starter.orderedToolSequence.length } }
    starterRuns.set(directory, task)
    void runStarter(starter, {
      workspace: dirname(record.args.path), sessionId: record.sessionId, engine, signal: controller.signal,
      progress: step => { task.state = { ...task.state, step: step.order, operation: step.tool } },
    }).then(
      results => { task.state = { phase: 'complete', results } },
      error => { task.state = { phase: 'error', error: errorText(error), step: task.state.step } },
    ).then(() => writePrivateJson(directory, 'starter-result.json', task.state))
      .then(() => starterRuns.delete(directory))
      .catch(error => { task.state = { phase: 'error', error: errorText(error) } })
    return task.state
  }

  async function askAboutSelection(engine, record, question, signal) {
    if (typeof question !== 'string' || !question.trim() || question.length > 1000) {
      throw new Error('Enter a question of up to 1,000 characters.')
    }
    const agent = ctx.agents.get(record.owner)
    if (!agent || await resolveRoot(agent, signal) !== record.root) {
      throw new Error('Open the owning DSH conversation before asking about a selection.')
    }
    const result = await callForViewer(engine, record, 'structure.get_context', {
      sections: ['selection'], maxItems: 16, maxBytes: 8192,
    }, signal)
    const selected = result.structuredContent?.sections?.selection?.selected
    if (result.isError || !selected?.atomCount) throw new Error('Select a residue, chain, or atom in this workbench first.')
    const snapshot = {
      viewerId: record.id, structure: record.title,
      revision: result.structuredContent.revision,
      summary: selected.summary, expression: selected.expression, atomCount: selected.atomCount,
    }
    await activate(record)
    signal?.throwIfAborted()
    agent.followup({
      id: randomUUID(), role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: `${question.trim()}\n\nDSH molecular workbench selection at the time of this question:\n${JSON.stringify(snapshot)}` }],
    })
  }

  async function operationHelp(args, root) {
    const catalog = await engineFor(join(profileDirectory(), 'catalog'), root)
    const operations = [...catalog.tools.values()].filter(item => visibleTo(item, 'model') && !blockedOpen.has(item.name))
    if (args.action === 'operations') {
      return {
        ok: true, action: args.action, summary: 'Molecular workbench operations.',
        data: { operations: operations.map(({ name }) => name) },
      }
    }
    const item = requireOperation(catalog, args.operation)
    const schema = structuredClone(item.inputSchema)
    if (schema.properties) delete schema.properties.sessionId
    if (schema.required) schema.required = schema.required.filter(key => key !== 'sessionId')
    return {
      ok: true, action: args.action, summary: item.description ?? item.name,
      data: { name: item.name, inputSchema: schema },
    }
  }

  function requireOperation(engine, operation) {
    if (blockedOpen.has(operation)) {
      throw new Error('Use action "open" with a source or exampleId to open a molecular structure.')
    }
    const item = engine.tools.get(operation)
    if (!visibleTo(item, 'model')) {
      throw new Error(`Unknown operation ${JSON.stringify(operation)}. Use action "operations" to list supported operations.`)
    }
    return item
  }

  async function execute(args, exec) {
    const agent = exec.agent
    if (!agent) throw new Error('Open the molecular workbench from a DSH conversation.')
    const owner = agent.id
    const turn = turns.get(agent.session)
    const root = await resolveRoot(agent, exec.signal)
    if (args.action === 'operations' || args.action === 'help') return operationHelp(args, root)
    if (args.action === 'examples') return {
      ok: true, action: args.action, summary: 'Molecular workbench starter examples.',
      data: { examples: [...starters.values()].map(({ id, title, prompt }) => ({ id, title, prompt })) },
    }
    if (args.action === 'open') {
      const { record, reused, present, live } = await openForAgent(agent, root, args, turn, exec.signal)
      return {
        ok: true,
        action: args.action,
        summary: `${reused ? 'Reusing' : 'Opening'} ${record.title} in the Molecular Structure Workbench. ${live.viewerReady
          ? 'The viewer is ready.' : 'The card has been issued. Use action "wait" for this viewerId before scene operations.'}`,
        data: {
          viewerId: record.id, title: record.title, placement: record.placement, reused,
          sessionReady: live.accepted !== false, viewerReady: live.viewerReady, surfaceState: live.surfaceState,
          viewerOpen: {
            disposition: reused ? 'reused' : 'created', intentId: args.openIntentId ?? record.args.openIntentId,
            mountState: live.mountState, renderState: live.renderState,
          },
          ...(record.starterId ? { starterId: record.starterId } : {}),
        },
        ...(present ? { scene: scene(record, turn) } : {}),
      }
    }

    const listViewers = args.action === 'viewers' || args.operation === 'structure.list_viewers'
    const records = args.viewerId !== undefined && !listViewers
      ? [await getRecord(owner, args.viewerId, root)]
      : await listRecords(owner, root)
    if (listViewers) {
      return {
        ok: true, action: args.action, summary: 'Molecular workbenches in this DSH conversation.',
        data: { viewers: records.map(({ record }) => ({
          viewerId: record.id, title: record.title, placement: record.placement, openedAt: record.openedAt,
        })) },
      }
    }
    const active = activeRecord(owner)
    const current = records.find(item => item.record.id === active?.id) ?? records[0]
    if (!current) throw new Error('Open a molecular workbench first.')
    const engine = await engineFor(current.directory, root)
    const { record, directory } = current
    if (args.action === 'wait') return waitForViewer(engine, record, args, exec.signal)
    const { operation } = args
    requireOperation(engine, operation)
    if (operation === 'structure.get_viewer_status') {
      const status = await readViewerStatus(engine, record, exec.signal)
      return {
        ok: true, action: args.action,
        summary: status.viewerReady ? 'The workbench is mounted and rendered.'
          : pendingViewer(args.action, record, status).summary,
        data: { viewerId: record.id, ...status, ...(record.starterId ? { starter: await starterStatus(directory) } : {}) },
      }
    }
    const input = args.arguments ?? (args.action === 'context'
      ? { sections: ['overview', 'selection', 'annotations', 'results'] }
      : {})
    if (publishingOperations.has(operation) || (operation === 'structure.project' && input.action === 'save')) {
      requireWorkspaceWrite(agent)
    }
    if (!rendererIndependent.has(operation)) {
      const status = await readViewerStatus(engine, record, exec.signal)
      if (!status.viewerReady) return pendingViewer(args.action, record, status)
    }
    const result = await runForViewer(engine, record, directory, operation, input, exec.signal)
    const reply = publicResult(args.action, result)
    if (reply.ok && operation === 'structure.get_state' && !Number.isInteger(reply.data?.state?.sceneRevision)) {
      return {
        ok: false, action: args.action,
        summary: 'The renderer did not return a scene revision. Check the existing workbench status before issuing scene changes.',
        data: { code: 'viewer_state_unavailable', viewerId: record.id },
      }
    }
    if (reply.ok && record.starterId && operation === 'structure.get_context') {
      reply.data = { ...reply.data, starter: await starterStatus(directory) }
    }
    return reply
  }

  async function openPreview(input, signal) {
    const agent = typeof input.sessionId === 'string' && ctx.agents.get(input.sessionId)
    if (!agent || typeof input.address !== 'string') throw new Error('Open the file from a DSH conversation.')
    const address = new URL(input.address)
    const prefix = `/session/${encodeURIComponent(agent.id)}/`
    if (address.protocol !== 'dsh-resource:' || address.hostname !== 'file' || !address.pathname.startsWith(prefix)) {
      throw new Error('This file address does not belong to the current DSH conversation.')
    }
    const source = address.pathname.slice(prefix.length).split('/').map(decodeURIComponent).join('/')
    const root = await resolveRoot(agent, signal)
    const path = await sourcePath(root, source)
    const identity = `${agent.id}\0${path}`
    let pending = previewOpens.get(identity)
    if (!pending) {
      pending = (async () => {
        const { version } = await ctx.workspaceFiles.stat({ sessionId: agent.id, workspaceRoot: root }, path, signal)
        const previewAddress = `${path}\0${version}`
        const previous = (await listRecords(agent.id, root)).find(item => item.record.previewAddress === previewAddress)
        const record = previous?.record ?? await openWorkbench(agent.id, root, { path, placement: 'sidebar' }, undefined, previewAddress)
        if (previous) await activate(record)
        return { scene: scene(record), version }
      })()
      previewOpens.set(identity, pending)
      void pending.finally(() => previewOpens.delete(identity)).catch(() => {})
    }
    return pending
  }

  ctx.tools.register({
    ...tool,
    execute: async (value, exec) => {
      let action = 'invalid_input'
      try {
        const args = normalizeToolCall(value)
        action = args.action
        return await execute(args, exec)
      } catch (error) {
        return {
          ok: false, action, summary: errorText(error),
          ...(error.code === 'outside_workspace' ? { data: { code: error.code } } : {}),
        }
      }
    },
  })
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'molecular-workbench:live-context',
    order: 8501,
    text: context => {
      if (!context.agent) return ''
      const current = activeRecord(context.agent.id)
      const instructions = 'For molecular_workbench, call action "wait" with the returned viewerId after an open reports viewerReady=false. Use scene operations only when viewerReady=true. If wait returns pending, let the user show the existing DSH card and resume when ready. Keep the same viewerId when adding or comparing structures.'
      return current ? `${instructions} The active workbench is ${JSON.stringify(current.title)} (viewerId ${current.id}). Use action=context for questions about the current selection or measurements.` : instructions
    },
  }))

  ctx.effect(() => {
    const disposeResources = ctx.webServer.register({
      kind: 'prefix',
      path: WORKBENCH_ROUTE,
      resource: async (request, peer) => {
        try {
          const rejection = peer ? undefined : ctx.connection.requestRejection(request)
          if (rejection !== undefined) return json({ error: 'Open the workbench in an authenticated DSH session.' }, rejection)
          const parts = new URL(request.url).pathname.slice(WORKBENCH_ROUTE.length + 1).split('/')
          if (parts.length !== 3) return json({ error: 'Unknown molecular workbench route.' }, 404)
          const [session, id, action] = parts
          const { record, directory } = await getRecord(decodeURIComponent(session), id)
          if (action === 'location' && request.method === 'GET') return json({ placement: record.placement })
          if (action === 'setup' && request.method === 'GET') {
            const { path, ...publicArgs } = record.args
            return json({ args: publicArgs, result: record.presentation, lastDistance: (await readLastDistance(directory))?.measurement,
              examples: [...starters.values()].map(({ id, title }) => ({ id, title })) })
          }
          if (action === 'frame' && request.method === 'GET') {
            const engine = await engineFor(directory, record.root)
            const resources = await engine.request('resources/read', { uri: record.template }, request.signal)
            return new Response(resources.contents[0].text, {
              headers: {
                'content-type': 'text/html; charset=utf-8',
                'cache-control': 'no-store',
                'content-security-policy': CSP,
                'referrer-policy': 'no-referrer',
                'x-content-type-options': 'nosniff',
              },
            })
          }
          return json({ error: 'Unknown molecular workbench route.' }, 404)
        } catch (error) {
          return json({ error: errorText(error) }, 400)
        }
      },
    })
    const disposeImport = ctx.webServer.register({
      kind: 'exact',
      path: `${WORKBENCH_ROUTE}/import`,
      handler: async (request, response) => {
        const abort = new AbortController()
        response.once('close', () => abort.abort())
        async function upload() {
          const rejection = ctx.connection.requestRejection(request)
          if (rejection !== undefined) return json({ error: 'Open an authenticated DSH conversation.' }, rejection)
          if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405)
          if (request.headers['content-type'] !== 'application/octet-stream') return json({ error: 'Upload a structure file.' }, 415)
          const { searchParams } = new URL(request.url, 'http://localhost')
          const agent = ctx.agents.get(searchParams.get('sessionId'))
          if (!agent) return json({ error: 'Open the owning DSH conversation before importing files.' }, 404)
          requireWorkspaceWrite(agent)
          const root = await resolveRoot(agent, abort.signal)
          const name = (searchParams.get('name') ?? '').replace(/[^a-z0-9._-]/gi, '_').slice(-150)
          if (!STRUCTURE_EXTENSIONS.some(ext => name.toLowerCase().endsWith(`.${ext}`))) {
            return json({ error: 'Choose a supported molecular structure file.' }, 400)
          }
          if (Number(request.headers['content-length']) > MAX_STRUCTURE_BYTES) {
            return json({ error: 'Structure file exceeds the 40 MiB limit.' }, 413)
          }
          const chunks = []
          let size = 0
          for await (const chunk of request) {
            size += chunk.length
            if (size > MAX_STRUCTURE_BYTES) return json({ error: 'Structure file exceeds the 40 MiB limit.' }, 413)
            chunks.push(chunk)
          }
          if (size === 0) return json({ error: 'The structure file is empty.' }, 400)
          const { file } = await stageStructure(root, name, Buffer.concat(chunks, size), abort.signal)
          return json({ source: relative(root, file) })
        }
        const result = await upload().catch(error => json({ error: errorText(error) }, 400))
        if (!abort.signal.aborted) {
          response.writeHead(result.status, Object.fromEntries(result.headers))
          response.end(await result.text())
        }
      },
    })
    const disposeApi = ctx.webServer.register({
      kind: 'exact',
      path: `${WORKBENCH_ROUTE}/api`,
      handler: async (request, response) => {
        const abort = new AbortController()
        response.once('close', () => abort.abort())
        async function run() {
          const rejection = ctx.connection.requestRejection(request)
          if (rejection !== undefined) return json({ error: 'Open the workbench in an authenticated DSH session.' }, rejection)
          if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405)
          const { action, sessionId, viewerId, address, method, params, picks, question, placement, exampleId, token } = await parseBody(request)
          if (action === 'preview') return json(await openPreview({ sessionId, address }, abort.signal))
          const { record, directory } = await getRecord(sessionId, viewerId)
          if (action === 'activate') {
            if (activeRecord(sessionId)?.id !== viewerId) await activate(record)
            return json({ ok: true })
          }
          if (action === 'placement') {
            if (placement !== 'inline' && placement !== 'sidebar') throw new Error('Unknown workbench placement.')
            await writePrivateJson(directory, 'placement.json', { placement })
            return json({ ok: true })
          }
          if (action === 'detach-renderer') {
            const renderer = renderers.get(record.id)
            if (renderer?.token === token) renderer.attached = false
            return json({ ok: true })
          }
          const engine = await engineFor(directory, record.root)
          if (action === 'attach-renderer') {
            if (typeof token !== 'string' || !openIntentUuid.test(token)) throw new Error('Invalid renderer ID.')
            const renderer = { token, attached: true, attachedAt: Date.now(), previousIncarnation: undefined }
            renderers.set(record.id, renderer)
            const state = await readViewerStatus(engine, record, abort.signal)
            renderer.previousIncarnation = state.rendererIncarnationId ?? null
            return json({ ok: true })
          }
          if (action === 'status') {
            const state = await readViewerStatus(engine, record, abort.signal)
            const starter = record.starterId ? await maybeStartExample(engine, record, directory, state) : undefined
            const publicStarter = starter?.phase === 'complete' ? {
              phase: 'complete', results: starter.results.map(({ tool, summary }) => ({ tool, summary })),
            } : starter
            const { viewerReady, mountState, renderState, surfaceState } = state
            return json({ state, viewerReady, mountState, renderState, surfaceState, starter: publicStarter })
          }
          if (action === 'launch-example') {
            const starter = starters.get(exampleId)
            const agent = ctx.agents.get(record.owner)
            if (!starter || !agent || await resolveRoot(agent, abort.signal) !== record.root) {
              throw new Error('Open the owning DSH conversation before starting a packaged example.')
            }
            abort.signal.throwIfAborted()
            agent.followup({ id: randomUUID(), role: 'user', source: { kind: 'user' },
              content: [{ type: 'text', text: `${starter.prompt}\n\nRun the packaged DSH starter with molecular_workbench action "open" and exampleId "${starter.id}". The workbench runs the example after mounting.` }] })
            return json({ ok: true })
          }
          if (action === 'ask-selection') {
            await askAboutSelection(engine, record, question, abort.signal)
            return json({ ok: true })
          }
          if (action === 'selected-residue') return json({ residue: await selectedResidue(engine, record, abort.signal) })
          if (action === 'residue-distance') {
            if (!Array.isArray(picks) || picks.length !== 2 || !picks[0]?.objectId || picks[0].objectId !== picks[1]?.objectId) {
              throw new Error('Choose two residues from the same loaded structure.')
            }
            const [first, second] = picks
            if (first.id === second.id) throw new Error('Choose two distinct residues.')
            if (activeRecord(sessionId)?.id !== viewerId) await activate(record)
            const result = await runForViewer(engine, record, directory, 'structure.control_viewer', {
              action: 'measure_residue_distance', objectId: first.objectId,
              chain: first.chain, residue: first.residueNumber, insertionCode: first.insertionCode, instanceId: first.instanceId,
              chainB: second.chain, residueB: second.residueNumber, insertionCodeB: second.insertionCode, instanceIdB: second.instanceId,
            }, abort.signal)
            const measured = publicResult('residue-distance', result)
            return measured.ok ? json(measured) : json({ error: measured.summary }, 400)
          }
          if (action !== 'rpc') return json({ error: 'Unknown molecular workbench operation.' }, 400)
          if (method === 'tools/call' && visibleTo(engine.tools.get(params?.name), 'app') && !blockedOpen.has(params.name)) {
            return json({ result: await engine.request(method, params, abort.signal) })
          }
          if (method === 'resources/read' && typeof params?.uri === 'string') {
            return json({ result: await engine.request(method, params, abort.signal) })
          }
          return json({ error: 'Unknown molecular workbench renderer operation.' }, 400)
        }
        const result = await run().catch(error => json({ error: errorText(error) }, 400))
        if (!abort.signal.aborted) {
          response.writeHead(result.status, Object.fromEntries(result.headers))
          response.end(await result.text())
        }
      },
    })
    return () => {
      disposeApi()
      disposeImport()
      disposeResources()
      for (const task of starterRuns.values()) task.controller.abort()
      for (const engine of engines.values()) void engine.then(item => item.close()).catch(() => {})
      engines.clear()
    }
  })
}
