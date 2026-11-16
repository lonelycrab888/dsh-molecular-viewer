/**
 * Molecular Structure Viewer — Host half.
 *
 * The Host resolves structures (RCSB PDB, local PDB/mmCIF, URL, or inline PDB),
 * caches them for the browser, and owns the per-session viewer scene that both
 * the agent (through the `molecular_viewer` tool) and the conversation UI
 * (through the state endpoint) read and mutate.
 *
 * @module dsh-molecular-viewer
 */

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { downloadStructure, MAX_STRUCTURE_BYTES, readStructureText } from './download.js'
import { lastMeasurementText, normalizeMeasurement } from './measurement.js'
import { normalizePickedResidue, pickedResidueText } from './residue.js'
import { registerWorkbench } from './workbench.js'

const TOOL_NAME = 'molecular_viewer'
const ROUTE_ROOT = '/dsh-molecular-viewer'
const STRUCTURE_PREFIX = `${ROUTE_ROOT}/structures`
const STATE_PATH = `${ROUTE_ROOT}/api/state`

const STYLES = ['cartoon', 'cartoon-sticks', 'sticks', 'spheres', 'line']
const COLORS = ['chain', 'secondary', 'element', 'residue', 'bfactor', 'uniform']
const ACTIONS = ['open', 'style', 'color', 'highlight', 'focus', 'label', 'spin', 'reset', 'status', 'close']

const DEFAULT_ACCENT = '#f59e0b'
const DEFAULT_UNIFORM = '#5b8def'

const WATER = new Set(['HOH', 'WAT', 'DOD', 'H2O', 'TIP', 'TIP3', 'SOL'])
const IONS = new Set([
  'NA', 'K', 'CL', 'MG', 'CA', 'ZN', 'FE', 'MN', 'CU', 'CO', 'NI', 'CD', 'HG',
  'SO4', 'PO4', 'NO3', 'NH4', 'IOD', 'BR',
])
const NUCLEIC = new Set([
  'A', 'C', 'G', 'U', 'I', 'DA', 'DC', 'DG', 'DT', 'DU', 'DI',
  'ADE', 'CYT', 'GUA', 'THY', 'URA',
])
const POLYMER_HET = new Set(['MSE', 'SEC', 'PYL', 'CSO', 'CME', 'MLY', 'SEP', 'TPO', 'PTR'])

/** Per-session active scene. Scenes are cheap; structures live on disk. */
const scenes = new Map()
const pendingOpens = new Map()
const hostInstance = randomUUID()

/** First entry per session is the scene both callers mutate. */
function getScene(sessionId) {
  return scenes.get(sessionId)
}

function requireScene(sessionId) {
  const scene = getScene(sessionId)
  if (!scene) throw new Error('No active structure. Call action "open" first.')
  return scene
}

function touch(scene, action) {
  scene.revision += 1
  scene.updatedAt = Date.now()
  scene.action = action
  return scene
}

function cacheDirectory() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'cache', 'dsh-molecular-viewer')
}

function structurePath(fileName) {
  if (!/^[A-Za-z0-9_-]+\.(pdb|cif)$/.test(fileName)) throw new Error('Invalid structure file name.')
  return join(cacheDirectory(), fileName)
}

function structureUrl(fileName) {
  return `${STRUCTURE_PREFIX}/${fileName}`
}

function isWater(resn) {
  return WATER.has(resn)
}

function isPolymerResidue(record, resn) {
  return record === 'ATOM' || POLYMER_HET.has(resn)
}

function formatCount(value) {
  return new Intl.NumberFormat('en-US').format(value)
}

function cleanTitle(value) {
  return String(value ?? '').replace(/\s+/g, ' ').replace(/[;\s]+$/, '').trim()
}

function normalizeHex(value, fallback) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : fallback
}

function selectionOf(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
  const output = {}
  if (typeof input.chain === 'string' && input.chain.trim() !== '') output.chain = input.chain.trim()
  if (typeof input.resn === 'string' && input.resn.trim() !== '') {
    const names = input.resn.split(/[\s,]+/).map(value => value.trim()).filter(Boolean)
    if (names.length === 0) return null
    output.resn = names.length === 1 ? names[0] : names
  }
  if (typeof input.resi === 'string' && input.resi.trim() !== '') output.resi = input.resi.trim()
  else if (typeof input.resi === 'number' && Number.isFinite(input.resi)) output.resi = String(input.resi)
  return Object.keys(output).length === 0 ? null : output
}

function selectionText(selection) {
  const parts = []
  if (selection.chain !== undefined) parts.push(`chain ${selection.chain || '—'}`)
  if (selection.resn !== undefined) parts.push(Array.isArray(selection.resn) ? selection.resn.join(', ') : selection.resn)
  if (selection.resi !== undefined) parts.push(`resi ${selection.resi}`)
  return parts.join(' ')
}

function selectionKey(selection) {
  return JSON.stringify(selection, Object.keys(selection).sort())
}

function sceneStyleLabel(style) {
  return ({ cartoon: 'cartoon', 'cartoon-sticks': 'cartoon + sticks', sticks: 'sticks', spheres: 'spheres', line: 'lines' })[style] ?? style
}

function sceneColorLabel(color) {
  return ({ chain: 'chain', secondary: 'secondary structure', element: 'element', residue: 'residue', bfactor: 'B-factor', uniform: 'single color' })[color] ?? color
}

function defaultDisplay(stats) {
  if (stats.polymer === false) return { style: 'sticks', color: 'element' }
  return {
    style: 'cartoon',
    color: stats.chains?.length === 1 ? 'secondary' : 'chain',
  }
}

/**
 * Parse the first model of a PDB file into compact, model-facing facts.
 * Coordinates are deliberately not copied: the browser parses the cached file.
 */
function parsePdb(text, fallback = {}) {
  const chains = new Map()
  const ligands = new Map()
  let atoms = 0
  let waters = 0
  let sourceId = ''
  let classification = ''
  let title = ''
  let resolution = ''
  let modelCount = 0
  let proteinResidues = 0
  let nucleicResidues = 0
  const seenResidues = new Set()

  const addChain = (id) => {
    let chain = chains.get(id)
    if (!chain) {
      chain = { id, atoms: 0, residues: new Set(), polymerResidues: new Set() }
      chains.set(id, chain)
    }
    return chain
  }

  for (const line of text.split(/\r?\n/)) {
    const record = line.slice(0, 6).trim()
    if (record === 'HEADER') {
      classification = cleanTitle(line.slice(10, 50))
      sourceId = cleanTitle(line.slice(62, 66))
      continue
    }
    if (record === 'TITLE') {
      title += ` ${line.slice(10).trim()}`
      continue
    }
    if (record === 'REMARK' && line.slice(7, 10) === '  2' && /RESOLUTION\.\s+([\d.]+)\s+ANGSTROM/i.test(line)) {
      resolution = line.match(/RESOLUTION\.\s+([\d.]+)\s+ANGSTROM/i)[1]
      continue
    }
    if (record === 'MODEL') {
      modelCount += 1
      if (modelCount > 1) break
      continue
    }
    if (record === 'ENDMDL') {
      if (modelCount >= 1) break
      continue
    }
    if (record !== 'ATOM' && record !== 'HETATM') continue

    // Alternate locations: keep the first (blank or A) conformer only.
    const altLoc = line[16] ?? ' '
    if (altLoc !== ' ' && altLoc !== 'A') continue

    const resn = line.slice(17, 20).trim()
    const chainId = line.slice(21, 22)
    const resi = line.slice(22, 26).trim()
    const icode = line[26] ?? ' '
    if (!resn || !resi || ![line.slice(30, 38), line.slice(38, 46), line.slice(46, 54)]
      .every(value => value.trim() && Number.isFinite(Number(value)))) continue

    atoms += 1
    const chain = addChain(chainId)
    chain.atoms += 1
    const key = `${chainId}|${resn}|${resi}|${icode}`
    if (record === 'HETATM' && !isWater(resn) && !isPolymerResidue(record, resn)) {
      let ligand = ligands.get(key)
      if (!ligand) {
        ligand = { resn, chain: chainId.trim(), resi, icode: icode.trim(), atoms: 0, ion: IONS.has(resn) }
        ligands.set(key, ligand)
      }
      ligand.atoms += 1
    }
    if (seenResidues.has(key)) continue
    seenResidues.add(key)

    if (isWater(resn)) {
      waters += 1
      continue
    }

    chain.residues.add(key)
    if (isPolymerResidue(record, resn)) chain.polymerResidues.add(key)
    if (NUCLEIC.has(resn)) nucleicResidues += 1
    else if (record === 'ATOM' || POLYMER_HET.has(resn)) proteinResidues += 1
  }
  if (!atoms) throw new Error('The PDB contains no usable atom coordinates in its first model.')

  const chainList = [...chains.values()]
    .map(chain => ({
      id: chain.id,
      atoms: chain.atoms,
      residues: chain.residues.size,
      polymerResidues: chain.polymerResidues.size,
    }))
    .filter(chain => chain.atoms > 0)
    .sort((a, b) => a.id.localeCompare(b.id))

  const residueCount = chainList.reduce((sum, chain) => sum + chain.residues, 0)
  const polymerCount = chainList.reduce((sum, chain) => sum + chain.polymerResidues, 0)
  const ligandList = [...ligands.values()].filter(ligand => !ligand.ion)
    .sort((a, b) => b.atoms - a.atoms || a.resn.localeCompare(b.resn))
  const nucleic = nucleicResidues >= 3
  const protein = proteinResidues >= 5
  const kind = protein && nucleic ? 'Protein–nucleic acid complex'
    : protein ? 'Protein'
      : nucleic ? 'Nucleic acid'
        : polymerCount > 0 ? 'Polymer' : 'Small molecule'

  const summaryParts = [
    `${kind} · ${formatCount(atoms)} atoms · ${formatCount(residueCount)} residues · ${chainList.length || 1} chain${(chainList.length || 1) === 1 ? '' : 's'}`,
  ]
  const namedLigands = ligandList.slice(0, 4)
  if (namedLigands.length > 0) {
    summaryParts.push(`ligands ${namedLigands.map(ligand => `${ligand.resn}${ligand.chain ? `:${ligand.chain}` : ''}`).join(', ')}`)
  }
  if (waters > 0) summaryParts.push(`${formatCount(waters)} waters hidden`)

  return {
    title: cleanTitle(title) || fallback.title || '',
    pdbId: sourceId || fallback.pdbId || '',
    classification,
    resolution,
    atoms,
    residues: residueCount,
    chains: chainList,
    ligands: ligandList,
    waters,
    polymer: polymerCount > 0,
    protein,
    nucleic,
    kind,
    summary: summaryParts.join(' · '),
  }
}

/** Minimal mmCIF facts; 3Dmol parses the file itself at view time. */
function parseCif(text, fallback = {}) {
  const titleMatch = text.match(/^_struct\.title[ \t]*(?:\r?\n;([\s\S]*?)\r?\n;|\s+('[^']*'|"[^"]*"|[^\s;]+))/m)
  const title = cleanTitle(titleMatch?.[1] ?? titleMatch?.[2]?.replace(/^['"]|['"]$/g, '')) || fallback.title || ''
  const idMatch = text.match(/_entry\.id\s+(\S+)/)
  return {
    title,
    pdbId: cleanTitle(idMatch?.[1] ?? fallback.pdbId ?? ''),
    classification: '',
    resolution: '',
    atoms: null,
    residues: null,
    chains: null,
    ligands: null,
    waters: null,
    polymer: null,
    protein: null,
    nucleic: null,
    kind: 'Structure',
    summary: 'mmCIF structure · atom-level statistics unavailable in this version',
  }
}

function sniffFormat(text, fileName = '') {
  if (/^[ \t]*data_\S+/mi.test(text)) return 'cif'
  if (/^(?:ATOM  |HETATM)/m.test(text)) return 'pdb'
  const extension = extname(fileName).toLowerCase()
  if (extension === '.cif' || extension === '.mmcif') return 'cif'
  return 'pdb'
}

function parseStructure(text, format, fallback) {
  if (format === 'pdb') return parsePdb(text, fallback)
  const hasDataBlock = /^[ \t]*data_(?!global\s)\S+/mi.test(text)
  const hasCoordinates = ['cartn', 'fract'].some(type =>
    ['x', 'y', 'z'].every(axis => new RegExp(`^\\s*_atom_site[._]${type}_${axis}\\b`, 'im').test(text)))
  if (!hasDataBlock || !hasCoordinates) throw new Error('The mmCIF is missing its atom coordinates or data block.')
  return parseCif(text, fallback)
}

async function readStructureFile(filePath) {
  const handle = await open(filePath, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('The structure path must be a regular file.')
    if (info.size > MAX_STRUCTURE_BYTES) throw new Error('Structure file exceeds the 40 MiB limit.')
    return await readStructureText(handle.createReadStream(), info.size)
  } finally {
    await handle.close()
  }
}

async function fetchRcsb(pdbId, exec) {
  const id = pdbId.toUpperCase()
  let lastError
  for (const format of ['pdb', 'cif']) {
    const url = `https://files.rcsb.org/download/${id}.${format}`
    try {
      const { text } = await downloadStructure(url, exec?.signal, `RCSB PDB ${id}`)
      const parsed = parseStructure(text, format, { pdbId: id })
      return { text, format, parsed, kind: 'pdb', label: `PDB ${id}`, pdbId: id }
    } catch (error) {
      lastError = error
      if (exec?.signal?.aborted) throw error
    }
  }
  throw new Error(`Could not download PDB ${id} from RCSB. ${lastError?.message ?? ''}`.trim())
}

async function resolveLocalPath(source, ctx, exec) {
  let candidate = source
  if (candidate === '~' || candidate.startsWith('~/')) candidate = join(homedir(), candidate.slice(1))
  if (!isAbsolute(candidate)) {
    let cwd = process.cwd()
    try {
      if (ctx?.workingDirectory && exec?.agent) cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
    } catch {
      exec?.signal?.throwIfAborted()
      throw new Error('Could not resolve the session working directory. Supply an absolute structure path.')
    }
    candidate = resolve(cwd, candidate)
  }
  return (await stat(candidate).catch(() => null))?.isFile() ? candidate : null
}

async function resolveSource(source, ctx, exec) {
  if (typeof source !== 'string' || source.trim() === '') {
    throw new Error('The "source" argument is required for action "open": use a 4-character RCSB PDB ID, a local .pdb/.cif path, a URL, or inline PDB text.')
  }
  const raw = source.trim()

  if (/^data_\S+/i.test(raw) || /^(?:ATOM  |HETATM|HEADER|TITLE )/m.test(raw)) {
    if (Buffer.byteLength(raw) > MAX_STRUCTURE_BYTES) throw new Error('Structure file exceeds the 40 MiB limit.')
    const format = sniffFormat(raw)
    return { text: raw, format, kind: 'inline', label: format === 'cif' ? 'inline mmCIF' : 'inline PDB', pdbId: '' }
  }

  if (/^https?:\/\//i.test(raw)) {
    const { text, url } = await downloadStructure(raw, exec?.signal, 'Structure URL')
    const format = sniffFormat(text, url.pathname)
    return { text, format, kind: 'url', label: `${url.host}${url.pathname}`, pdbId: '' }
  }

  if (/^(?:pdb:)?[0-9][A-Za-z0-9]{3}$/i.test(raw)) return fetchRcsb(raw.replace(/^pdb:/i, ''), exec)
  const localPath = await resolveLocalPath(raw, ctx, exec)
  if (localPath) {
    const text = await readStructureFile(localPath)
    const format = sniffFormat(text, localPath)
    return { text, format, kind: 'file', label: basename(localPath), pdbId: '' }
  }

  const bare = raw.replace(/^pdb:/i, '').replace(/\.(pdb|cif|mmcif)$/i, '')
  if (/^[0-9][A-Za-z0-9]{3}$/.test(bare)) return fetchRcsb(bare, exec)

  throw new Error('Cannot resolve the structure source. Use a 4-character RCSB PDB ID, an existing .pdb/.cif file, an HTTPS URL, or inline PDB/mmCIF text.')
}

async function storeStructure(text, format) {
  await mkdir(cacheDirectory(), { recursive: true, mode: 0o700 })
  const digest = createHash('sha1').update(text).digest('hex').slice(0, 20)
  const fileName = `${digest}.${format === 'cif' ? 'cif' : 'pdb'}`
  const target = structurePath(fileName)
  if (!(await access(target).then(() => true, () => false))) {
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await rename(temporary, target)
    } finally {
      await rm(temporary, { force: true })
    }
  }
  return { id: digest, fileName, url: structureUrl(fileName) }
}

function makeScene(source, display, stored, overrides, revision) {
  return {
    id: stored.id,
    url: stored.url,
    format: source.format,
    title: (cleanTitle(overrides.title) || source.parsed.title || source.label).slice(0, 240),
    pdbId: source.parsed.pdbId || source.pdbId || '',
    source: { kind: source.kind, label: source.label },
    summary: source.parsed.summary,
    stats: {
      atoms: source.parsed.atoms,
      residues: source.parsed.residues,
      chains: source.parsed.chains?.length ?? null,
      ligands: source.parsed.ligands?.length ?? null,
      waters: source.parsed.waters,
      polymer: source.parsed.polymer,
      protein: source.parsed.protein,
      nucleic: source.parsed.nucleic,
    },
    style: overrides.style ?? display.style,
    color: overrides.color ?? display.color,
    colorHex: normalizeHex(overrides.colorHex, DEFAULT_UNIFORM),
    spin: overrides.spin === true,
    highlights: [],
    labels: [],
    focus: null,
    selectedResidue: null,
    lastMeasurement: null,
    visible: true,
    revision,
    generation: `${hostInstance}:${revision}`,
    updatedAt: Date.now(),
    action: 'open',
  }
}

function sceneSummary(scene) {
  const parts = [
    `${scene.title}${scene.pdbId ? ` (PDB ${scene.pdbId})` : ''}.`,
    scene.summary + '.',
    `Viewer: ${sceneStyleLabel(scene.style)}, colored by ${sceneColorLabel(scene.color)}${scene.spin ? ', spinning' : ''}.`,
  ]
  if (scene.focus) parts.push(`Focused on ${scene.focus.text}.`)
  if (scene.selectedResidue) parts.push(`User-selected residue: ${pickedResidueText(scene.selectedResidue)}.`)
  if (scene.lastMeasurement) parts.push(lastMeasurementText(scene.lastMeasurement))
  if (scene.highlights.length > 0) parts.push(`Highlights: ${scene.highlights.map(item => item.text).join('; ')}.`)
  if (scene.labels.length > 0) parts.push(`Labels: ${scene.labels.map(item => item.text).join('; ')}.`)
  return parts.join(' ')
}

function scenePrompt(scene) {
  const parts = [
    scene.visible
      ? 'There is an active molecular structure viewer in this conversation.'
      : 'The molecular structure viewer in this conversation is currently hidden.',
    `Scene settings: ${sceneStyleLabel(scene.style)}, colored by ${sceneColorLabel(scene.color)}${scene.spin ? ', spinning' : ''}.`,
  ]
  if (scene.selectedResidue) parts.push(`User-selected residue: ${pickedResidueText(scene.selectedResidue)}.`)
  if (scene.lastMeasurement) parts.push(lastMeasurementText(scene.lastMeasurement))
  parts.push('Call molecular_viewer with action "status" for structure metadata, the current selection, and the last completed distance measurement.')
  return parts.join(' ')
}

function applyViewPatch(sessionId, patch) {
  const scene = getScene(sessionId)
  if (!scene) return null
  const picked = Object.hasOwn(patch, 'selectedResidue') ? normalizePickedResidue(patch.selectedResidue) : undefined
  const measurement = Object.hasOwn(patch, 'lastMeasurement') ? normalizeMeasurement(patch.lastMeasurement) : undefined
  let changed = false
  if (STYLES.includes(patch.style) && patch.style !== scene.style) {
    checkStyle(patch.style, scene.stats)
    scene.style = patch.style
    changed = true
  }
  if (COLORS.includes(patch.color) && patch.color !== scene.color) {
    scene.color = patch.color
    changed = true
  }
  const colorHex = normalizeHex(patch.colorHex, scene.colorHex)
  if (colorHex !== scene.colorHex) {
    scene.colorHex = colorHex
    changed = true
  }
  if (typeof patch.spin === 'boolean' && patch.spin !== scene.spin) {
    scene.spin = patch.spin
    changed = true
  }
  if (typeof patch.visible === 'boolean' && patch.visible !== scene.visible) {
    scene.visible = patch.visible
    changed = true
  }
  if (picked !== undefined && JSON.stringify(picked) !== JSON.stringify(scene.selectedResidue)) {
    scene.selectedResidue = picked
    changed = true
  }
  if (measurement !== undefined && JSON.stringify(measurement) !== JSON.stringify(scene.lastMeasurement)) {
    scene.lastMeasurement = measurement
    changed = true
  }
  if (!changed) return scene
  return touch(scene, 'view')
}

function openScene(sessionId, source, overrides) {
  const display = defaultDisplay(source.parsed)
  const scene = makeScene(source, display, source.stored, overrides, (getScene(sessionId)?.revision ?? 0) + 1)
  scenes.set(sessionId, scene)
  return scene
}

function checkStyle(style, stats) {
  if (!STYLES.includes(style)) throw new Error(`Style must be one of: ${STYLES.join(', ')}.`)
  if (stats.polymer === false && style.startsWith('cartoon')) {
    throw new Error('Cartoon representation needs a polymer. Use "sticks", "spheres", or "line" for a small molecule.')
  }
}

function checkLabelLimit(scene, label) {
  if (label && scene.labels.length >= 16) throw new Error('At most 16 labels can be shown at once. Reset or open the structure again.')
}

function actionError(action, message) {
  return { ok: false, action, summary: `Molecular viewer error: ${message}`, error: message }
}

async function runAction(args, exec, pluginCtx) {
  const sessionId = exec?.agent?.id
  if (!sessionId) throw new Error('The molecular viewer needs an active DSH session.')
  const action = args.action

  if (action === 'open') {
    if (args.color !== undefined && !COLORS.includes(args.color)) throw new Error(`Color must be one of: ${COLORS.join(', ')}.`)
    const token = Symbol()
    pendingOpens.set(sessionId, token)
    try {
      const source = await resolveSource(args.source, pluginCtx, exec)
      const parsed = source.parsed ?? parseStructure(source.text, source.format, { pdbId: source.pdbId })
      if (args.style !== undefined) checkStyle(args.style, parsed)
      exec.signal?.throwIfAborted()
      const stored = await storeStructure(source.text, source.format)
      exec.signal?.throwIfAborted()
      if (pendingOpens.get(sessionId) !== token) throw new Error('A newer open request superseded this one.')
      const scene = openScene(sessionId, { ...source, parsed, stored }, args)
      return { ok: true, action, summary: `Prepared ${sceneSummary(scene)}`, scene }
    } finally {
      if (pendingOpens.get(sessionId) === token) pendingOpens.delete(sessionId)
    }
  }

  if (action === 'status') {
    const scene = getScene(sessionId)
    if (!scene) return actionError(action, 'No active structure. Call action "open" first.')
    const summary = scene.visible ? sceneSummary(scene) : `The molecular viewer is hidden. ${sceneSummary(scene)}`
    return { ok: true, action, summary, scene }
  }

  const scene = requireScene(sessionId)

  if (action === 'close') {
    scene.visible = false
    touch(scene, action)
    return { ok: true, action, summary: `Hid the molecular viewer for ${scene.title}. The structure remains loaded.`, scene }
  }

  if (action === 'style') {
    checkStyle(args.style, scene.stats)
    scene.style = args.style
    touch(scene, action)
    return { ok: true, action, summary: `Changed representation to ${sceneStyleLabel(scene.style)}. ${sceneSummary(scene)}`, scene }
  }

  if (action === 'color') {
    if (!COLORS.includes(args.color)) throw new Error(`Color must be one of: ${COLORS.join(', ')}.`)
    scene.color = args.color
    if (args.color === 'uniform') scene.colorHex = normalizeHex(args.colorHex, scene.colorHex || DEFAULT_UNIFORM)
    touch(scene, action)
    return { ok: true, action, summary: `Colored by ${sceneColorLabel(scene.color)}. ${sceneSummary(scene)}`, scene }
  }

  if (action === 'highlight') {
    const selection = selectionOf(args.selection)
    if (!selection) throw new Error('Highlight needs a selection with chain, resn, and/or resi (for example {"chain":"A","resi":"45-60"}).')
    const key = selectionKey(selection)
    if (scene.highlights.some(item => item.key === key)) throw new Error(`That selection is already highlighted: ${selectionText(selection)}.`)
    if (scene.highlights.length >= 12) throw new Error('At most 12 highlights can be shown at once. Reset or open the structure again.')
    const label = typeof args.label === 'string' ? cleanTitle(args.label).slice(0, 120) : ''
    checkLabelLimit(scene, label)
    const text = `${selectionText(selection)}${label ? ` — ${label}` : ''}`
    scene.highlights.push({
      key,
      selection,
      colorHex: normalizeHex(args.colorHex, DEFAULT_ACCENT),
      text,
      label,
    })
    if (label) scene.labels.push({ selection, text: label, selectionText: selectionText(selection) })
    touch(scene, action)
    return { ok: true, action, summary: `Highlighted ${text}. ${sceneSummary(scene)}`, scene }
  }

  if (action === 'focus') {
    const selection = selectionOf(args.selection)
    if (!selection) throw new Error('Focus needs a selection with chain, resn, and/or resi (for example {"chain":"A","resi":"45-60"}).')
    const label = typeof args.label === 'string' ? cleanTitle(args.label).slice(0, 120) : ''
    checkLabelLimit(scene, label)
    scene.focus = { selection, revision: scene.revision + 1, text: `${selectionText(selection)}${label ? ` — ${label}` : ''}` }
    if (label) scene.labels.push({ selection, text: label, selectionText: selectionText(selection) })
    touch(scene, action)
    return { ok: true, action, summary: `Focused the camera on ${scene.focus.text}. ${sceneSummary(scene)}`, scene }
  }

  if (action === 'label') {
    const selection = selectionOf(args.selection)
    if (!selection) throw new Error('Label needs a selection with chain, resn, and/or resi.')
    const text = cleanTitle(args.label).slice(0, 120)
    if (!text) throw new Error('Label needs non-empty "label" text.')
    checkLabelLimit(scene, text)
    scene.labels.push({ selection, text, selectionText: selectionText(selection) })
    touch(scene, action)
    return { ok: true, action, summary: `Labeled ${selectionText(selection)} as "${text}". ${sceneSummary(scene)}`, scene }
  }

  if (action === 'spin') {
    if (typeof args.spin !== 'boolean') throw new Error('Spin needs a boolean "spin" argument.')
    scene.spin = args.spin
    touch(scene, action)
    return { ok: true, action, summary: `${args.spin ? 'Started' : 'Stopped'} spinning the structure. ${sceneSummary(scene)}`, scene }
  }

  if (action === 'reset') {
    scene.highlights = []
    scene.labels = []
    scene.focus = null
    scene.selectedResidue = null
    scene.lastMeasurement = null
    scene.spin = false
    touch(scene, action)
    return { ok: true, action, summary: `Reset highlights, labels, focus, residue selection, measurement, and spinning. ${sceneSummary(scene)}`, scene }
  }

  throw new Error(`Unknown action "${action}".`)
}

const tool = {
  name: TOOL_NAME,
  description: [
    'Control an existing lightweight viewer created with molecular_viewer. Prefer molecular_workbench for new visualizations and advanced structural analysis. Open and control a live 3D molecular structure viewer in the conversation. The user sees the same viewer, so this is for showing and annotating a structure rather than returning coordinates.',
    'Open with a 4-character RCSB PDB ID (for example "1CRN" or "5LF3"), a local .pdb/.cif path, a public HTTPS URL, or inline PDB/mmCIF text. Then use actions to style, color, highlight, focus, label, spin, reset, hide, or inspect the active scene.',
    'Use chain/resn/resi selections for binding sites and subunits; never invent residue numbers. Call action "status" for the current selection, focus, or last completed distance measurement. Structural facts not present in the returned summary should be read from the structure file or another scientific tool.',
  ].join(' '),
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        required: true,
        enum: ACTIONS,
        description: 'open a structure, then style/color/highlight/focus/label/spin/reset it, read status, or close the viewer.',
      },
      source: {
        type: 'string',
        description: 'For action "open": RCSB PDB ID (4 characters), local .pdb/.cif path, public HTTPS URL, or inline PDB/mmCIF text.',
      },
      title: {
        type: 'string',
        description: 'Optional title override for the opened scene.',
      },
      style: {
        type: 'string',
        enum: STYLES,
        description: 'Representation. Cartoon includes ligand sticks; "cartoon-sticks" adds protein sticks.',
      },
      color: {
        type: 'string',
        enum: COLORS,
        description: 'Color scheme. "secondary" uses secondary structure, "chain" colors subunits.',
      },
      colorHex: {
        type: 'string',
        description: 'Hex color for uniform coloring or highlights, for example "#f59e0b".',
      },
      selection: {
        type: 'object',
        additionalProperties: false,
        description: 'Selection for highlight/focus/label: chain, resn, and/or resi. resi may be a range like "45-60".',
        properties: {
          chain: { type: 'string', description: 'Chain identifier, for example "A".' },
          resn: { type: 'string', description: 'Residue name, for example "BTZ" or "GLU"; comma-separate multiple names.' },
          resi: { type: 'string', description: 'Residue number or range, for example "45" or "45-60".' },
        },
      },
      label: {
        type: 'string',
        description: 'Short annotation text for highlight/focus/label, for example "β5 catalytic site".',
      },
      spin: {
        type: 'boolean',
        description: 'For action "spin": true starts slow rotation, false stops it.',
      },
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['ok', 'action', 'summary'],
      properties: {
        ok: { type: 'boolean' },
        action: { type: 'string' },
        summary: { type: 'string' },
        error: { type: 'string' },
        scene: {
          type: 'object',
          additionalProperties: true,
          required: ['id', 'url', 'title', 'style', 'color', 'visible', 'revision'],
          properties: {
            id: { type: 'string' },
            url: { type: 'string' },
            format: { type: 'string' },
            title: { type: 'string' },
            pdbId: { type: 'string' },
            summary: { type: 'string' },
            style: { type: 'string' },
            color: { type: 'string' },
            colorHex: { type: 'string' },
            spin: { type: 'boolean' },
            visible: { type: 'boolean' },
            lastMeasurement: {
              oneOf: [
                { type: 'null' },
                {
                  type: 'object',
                  required: ['endpoints', 'distanceAngstrom'],
                  properties: { endpoints: { type: 'array' }, distanceAngstrom: { type: 'number' } },
                },
              ],
            },
            revision: { type: 'number' },
            highlights: { type: 'array' },
            labels: { type: 'array' },
            stats: { type: 'object' },
          },
        },
      },
    },
    render: (_args, value) => [{
      type: 'text',
      text: value.summary,
    }],
    presentationMeta: (_args, value) => ({
      plugin: 'dsh-molecular-viewer',
      ok: value.ok,
      action: value.action,
      summary: value.summary,
      error: value.error ?? null,
      scene: value.scene ?? null,
    }),
  },
}

function sendJson(response, value, status = 200) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

function readJsonBody(request, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const length = Number(request.headers['content-length'] ?? '0')
    if (length > limit) {
      reject(new Error('Request body is too large.'))
      request.resume()
      return
    }
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('Request body is too large.'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text.trim()) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('Request body is not valid JSON.'))
      }
    })
    request.on('error', reject)
  })
}

function registerRoutes(ctx) {
  ctx.effect(() => {
    const disposeStructures = ctx.webServer.register({
      kind: 'prefix',
      path: STRUCTURE_PREFIX,
      resource: async (request, peer) => {
        try {
          const rejection = peer ? undefined : ctx.connection.requestRejection(request)
          if (rejection !== undefined) return new Response(null, { status: rejection })
          const pathname = new URL(request.url).pathname
          const fileName = decodeURIComponent(pathname.slice(STRUCTURE_PREFIX.length + 1))
          const path = structurePath(fileName)
          if (!(await stat(path)).isFile()) return new Response(null, { status: 404 })
          return new Response(request.method === 'HEAD' ? null : Readable.toWeb(createReadStream(path)), {
            headers: {
              'content-type': fileName.endsWith('.cif') ? 'chemical/x-cif; charset=utf-8' : 'chemical/x-pdb; charset=utf-8',
              'cache-control': 'private, max-age=31536000, immutable',
              'x-content-type-options': 'nosniff',
              'cross-origin-resource-policy': 'same-origin',
            },
          })
        } catch {
          return new Response('Structure not found', { status: 404 })
        }
      },
    })

    const disposeState = ctx.webServer.register({
      kind: 'exact',
      path: STATE_PATH,
      handler: (request, response) => {
        void (async () => {
          try {
            const rejection = ctx.connection.requestRejection(request)
            if (rejection !== undefined) return sendJson(response, { ok: false, error: 'Open the viewer from an authenticated DSH session.' }, rejection)
            if (request.method === 'GET') {
              const sessionId = new URL(request.url, 'http://localhost').searchParams.get('sessionId')
              if (!sessionId) return sendJson(response, { ok: false, error: 'sessionId is required.' }, 400)
              return sendJson(response, { ok: true, scene: getScene(sessionId) ?? null })
            }
            if (request.method !== 'POST') return sendJson(response, { ok: false, error: 'Use GET or POST.' }, 405)
            if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
              return sendJson(response, { ok: false, error: 'Use application/json.' }, 415)
            }
            const body = await readJsonBody(request)
            if (typeof body?.sessionId !== 'string' || !body.sessionId) return sendJson(response, { ok: false, error: 'sessionId is required.' }, 400)
            const current = getScene(body.sessionId)
            if (current && (body.generation !== undefined || Object.hasOwn(body, 'selectedResidue') ||
              Object.hasOwn(body, 'lastMeasurement')) &&
              body.generation !== current.generation) {
              return sendJson(response, { ok: false, error: 'The active structure changed.' }, 409)
            }
            const scene = applyViewPatch(body.sessionId, body)
            if (!scene) return sendJson(response, { ok: false, error: 'No active structure for this session.' }, 404)
            return sendJson(response, { ok: true, scene })
          } catch (error) {
            if (!response.headersSent) sendJson(response, { ok: false, error: error instanceof Error ? error.message : String(error) }, 400)
            else response.end()
          }
        })()
      },
    })

    return () => {
      disposeState()
      disposeStructures()
    }
  })
}

/**
 * Host plugin entry.
 * @type {import('@deepseek-ai/dsh-agent').Plugin}
 */
export const inject = ['tools', 'webServer', 'connection', 'systemPrompt', 'workingDirectory', 'agents', 'workspaceFiles', 'sandboxPolicy']

export function apply(ctx) {
  const turns = new WeakMap()
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') turns.set(session, event.data.turn)
    if (event.type === 'turn/end') turns.delete(session)
  }, { global: true })

  ctx.tools.register({
    ...tool,
    execute: async (args, exec) => {
      try {
        const turn = turns.get(exec.agent?.session)
        const result = structuredClone(await runAction(args, exec, ctx))
        if (result.ok && result.action === 'open' && turn !== undefined) result.scene.turn = turn
        return result
      } catch (error) {
        return actionError(args.action, error instanceof Error ? error.message : String(error))
      }
    },
  })

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'molecular-viewer:active-scene',
    order: 8500,
    text: (context) => {
      const agent = context.agent
      if (!agent) return ''
      const scene = getScene(agent.id)
      return scene?.visible || scene?.lastMeasurement ? scenePrompt(scene) : ''
    },
  }))

  registerRoutes(ctx)
  registerWorkbench(ctx, turns)
}
