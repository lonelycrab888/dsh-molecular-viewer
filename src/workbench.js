import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { downloadStructureBytes, MAX_STRUCTURE_BYTES } from './download.js'
import { connectWorkbench } from './workbench-engine.js'
import { STRUCTURE_EXTENSIONS, WORKBENCH_ROUTE, WORKBENCH_TOOL, workbenchId } from './workbench-contract.js'

const workbenchActions = new Set(['open', 'viewers', 'status', 'context', 'operations', 'help', 'run'])
const shorthandOperations = new Map([
  ['status', 'structure.get_viewer_status'],
  ['context', 'structure.get_context'],
])
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
  if (!containsPath(root, file)) throw new Error('Choose a structure inside this DSH workspace.')
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
    'Open once and reuse the returned viewerId for comparison, scientific analysis and rendering.',
    'Use context after the user selects or measures something in the viewer. Prefer this tool for new interactive visualizations.',
    'Use action "operations" to list operations or action "help" with an operation name to obtain its input schema. Both work before opening a viewer.',
    'For example, inspect a live viewer with {"action":"run","operation":"structure.get_state"}. The operation name can also be passed as action, or by itself in operation.',
    'For revision-guarded operations, read structure.get_state first. Pass a DSH viewerId only when targeting a specific viewer.',
  ].join(' '),
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', description: 'open, viewers, status, context, operations, help, or run. Also accepts a structure.* operation name as a shortcut.' },
      source: { type: 'string', description: 'A workspace file, RCSB PDB ID, public HTTPS URL, or inline PDB/mmCIF text.' },
      exampleId: { type: 'string', description: 'Use gfp-1ema for the bundled demonstration.' },
      viewerId: { type: 'string', description: 'DSH viewer ID from open or viewers. Defaults to the active viewer.' },
      placement: { type: 'string', enum: ['inline', 'sidebar'], description: 'For open. Defaults to inline.' },
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
      plugin: 'dsh-molecular-viewer', ok: value.ok, action: value.action, summary: value.summary, scene: value.scene ?? null,
    }),
  },
}

export function registerWorkbench(ctx, turns) {
  const engines = new Map()
  const previewOpens = new Map()
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
    if (Boolean(input.source) === Boolean(input.exampleId)) {
      throw new Error('Supply one workspace source file or exampleId.')
    }
    const path = input.source && await sourcePath(root, input.source)
    const id = randomUUID()
    const directory = join(makeDirectory(owner), id)
    const args = {
      ...(path ? { path } : { exampleId: input.exampleId }),
      openIntentId: randomUUID(),
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
        title: path ? basename(path) : 'Green fluorescent protein (1EMA)',
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

  async function openForAgent(agent, root, args, signal) {
    const imported = typeof args.source === 'string' ? importSource(args.source.trim()) : undefined
    if (!imported || args.exampleId) return openWorkbench(agent.id, root, args, signal)
    if (!imported.text && !isAbsolute(args.source) && await stat(resolve(root, args.source)).then(info => info.isFile(), () => false)) {
      return openWorkbench(agent.id, root, args, signal)
    }
    requireWorkspaceWrite(agent)
    const { file, directory } = await importStructure(root, imported, signal)
    try {
      return await openWorkbench(agent.id, root, { ...args, source: file }, signal)
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
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
    const root = await resolveRoot(agent, exec.signal)
    if (args.action === 'operations' || args.action === 'help') return operationHelp(args, root)
    if (args.action === 'open') {
      const record = await openForAgent(agent, root, args, exec.signal)
      return {
        ok: true,
        action: args.action,
        summary: `Opened ${record.title} in the Molecular Structure Workbench.`,
        data: { viewerId: record.id, title: record.title, placement: record.placement },
        scene: scene(record, turns.get(agent.session)),
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
    const { operation } = args
    requireOperation(engine, operation)
    const input = args.arguments ?? (args.action === 'context'
      ? { sections: ['overview', 'selection', 'annotations', 'results'] }
      : {})
    if (publishingOperations.has(operation) || (operation === 'structure.project' && input.action === 'save')) {
      requireWorkspaceWrite(agent)
    }
    return publicResult(args.action, await runForViewer(engine, current.record, current.directory, operation, input, exec.signal))
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
        const record = previous?.record ?? await openWorkbench(agent.id, root, { source: path, placement: 'sidebar' }, undefined, previewAddress)
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
        return { ok: false, action, summary: errorText(error) }
      }
    },
  })
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'molecular-workbench:live-context',
    order: 8501,
    text: context => {
      if (!context.agent) return ''
      const current = activeRecord(context.agent.id)
      if (!current) return ''
      return `A live Mol* Molecular Structure Workbench is available in this DSH conversation. For questions about the user's current selection or measurements, call molecular_workbench with action=context. The active workbench is ${JSON.stringify(current.title)} (viewerId ${current.id}).`
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
          const engine = await engineFor(directory, record.root)
          if (action === 'setup' && request.method === 'GET') {
            const { path, ...publicArgs } = record.args
            return json({ args: publicArgs, result: record.presentation, lastDistance: (await readLastDistance(directory))?.measurement })
          }
          if (action === 'frame' && request.method === 'GET') {
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
          const { action, sessionId, viewerId, address, method, params, picks } = await parseBody(request)
          if (action === 'preview') return json(await openPreview({ sessionId, address }, abort.signal))
          const { record, directory } = await getRecord(sessionId, viewerId)
          if (action === 'activate') {
            if (activeRecord(sessionId)?.id !== viewerId) await activate(record)
            return json({ ok: true })
          }
          const engine = await engineFor(directory, record.root)
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
      disposeResources()
      for (const engine of engines.values()) void engine.then(item => item.close()).catch(() => {})
      engines.clear()
    }
  })
}
