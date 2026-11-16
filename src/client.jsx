/**
 * Molecular Structure Viewer — browser half.
 *
 * Renders the opened structure in the turn that produced it. The viewer
 * reads the active scene from the Host so the agent and browser share it.
 *
 * @module dsh-molecular-viewer/client
 */
import React from 'react'
import { createPortal } from 'react-dom'
import $3Dmol from '3dmol/build/3Dmol-min.js'
import { distanceText, EMPTY_MEASUREMENT, measurementRecord, pickMeasurementResidue } from './measurement.js'
import { residueKey } from './residue.js'
import { cifResidueFields, indexResidues } from './structure-residues.js'
import { sceneDefinition, TOOL_NAME, VIEWER_ID } from './transcript.js'
import { registerWorkbenchClient, WorkbenchCard, WORKBENCH_STYLE } from './workbench-client.jsx'
import { WORKBENCH_TOOL } from './workbench-contract.js'

const { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } = React
const h = React.createElement
const zh = String(navigator.language || '').toLowerCase().startsWith('zh')

const TEXT = zh ? {
  title: '分子结构查看器',
  loading: '正在载入结构…',
  loadError: '无法载入结构',
  retry: '重试',
  style: '表示方式',
  color: '配色',
  spin: '旋转',
  stopSpin: '停止旋转',
  reset: '重置视角',
  expand: '放大',
  fullscreen: '全屏查看',
  collapse: '还原',
  download: '下载 PNG',
  close: '隐藏查看器',
  open: '在查看器中打开',
  noStructure: '尚无结构',
  viewerHint: '三维查看器显示在回复下方',
  preview: '历史结构',
  picked: '已选残基',
  clickedAtom: '点选原子',
  clearSelection: '清除选择',
  atomCount: '已载入原子数',
  authorNumber: '作者编号',
  labelNumber: '标签编号',
  unassignedNumber: '未注明编号',
  blankChain: '空链 ID',
  labelChain: '标签链',
  model: '模型',
  pickError: '无法读取所选残基',
  measure: '测距',
  chain: '链',
  distance: '最近重原子距离',
  syncingMeasurement: '正在同步测量…',
  firstResidue: '点击第一个残基上的任意原子。',
  secondResidue: '点击第二个残基上的任意原子。',
  clearMeasurement: '清除测量',
  measureErrors: {
    sameResidue: '请选择另一个残基。',
    noHeavyAtoms: '该残基没有可用于测量的重原子。',
    differentModels: '请选择同一模型中的两个残基。',
    noDistance: '无法从这两个残基的坐标计算距离。',
  },
  chains: '链',
  residues: '残基',
  atoms: '原子',
  ligands: '配体',
  waters: '水分子已隐藏',
  dismiss: '关闭',
  offline: '与 Host 的连接已中断，正在重试。',
  updateError: '无法更新查看器',
  noAtoms: '未能解析有效的原子坐标。',
  annotations: '标注',
  focus: '焦点',
  toolPending: '正在准备分子结构…',
  toolRunning: '正在更新查看器…',
  toolFailed: '分子查看器操作失败',
  styles: { cartoon: '卡通', 'cartoon-sticks': '卡通 + 棍状', sticks: '棍状', spheres: '球状', line: '线框' },
  colors: { chain: '按链', secondary: '按二级结构', element: '按元素', residue: '按残基', bfactor: '按 B-factor', uniform: '单色' },
} : {
  title: 'Molecular viewer',
  loading: 'Loading structure…',
  loadError: 'Could not load structure',
  retry: 'Retry',
  style: 'Representation',
  color: 'Color',
  spin: 'Spin',
  stopSpin: 'Stop',
  reset: 'Reset view',
  expand: 'Expand',
  fullscreen: 'Full-screen viewer',
  collapse: 'Collapse',
  download: 'Download PNG',
  close: 'Hide viewer',
  open: 'Open in viewer',
  noStructure: 'No structure yet',
  viewerHint: 'The 3D viewer appears below the reply',
  preview: 'Previous structure',
  picked: 'Selected residue',
  clickedAtom: 'Clicked atom',
  clearSelection: 'Clear selection',
  atomCount: 'Loaded atoms',
  authorNumber: 'Author numbering',
  labelNumber: 'Label numbering',
  unassignedNumber: 'Unassigned number',
  blankChain: 'Blank chain ID',
  labelChain: 'Label chain',
  model: 'Model',
  pickError: 'Could not read the selected residue',
  measure: 'Measure',
  chain: 'Chain',
  distance: 'Closest heavy-atom distance',
  syncingMeasurement: 'Syncing measurement…',
  firstResidue: 'Click an atom in the first residue.',
  secondResidue: 'Click an atom in a second residue.',
  clearMeasurement: 'Clear measurement',
  measureErrors: {
    sameResidue: 'Choose a different residue.',
    noHeavyAtoms: 'This residue has no heavy atoms to measure.',
    differentModels: 'Choose two residues in the same model.',
    noDistance: 'The distance could not be calculated from these coordinates.',
  },
  chains: 'chains',
  residues: 'residues',
  atoms: 'atoms',
  ligands: 'ligands',
  waters: 'waters hidden',
  dismiss: 'Dismiss',
  offline: 'Host connection lost. Reconnecting…',
  updateError: 'Could not update the viewer',
  noAtoms: 'No valid atom coordinates were parsed.',
  annotations: 'Annotations',
  focus: 'Focus',
  toolPending: 'Preparing molecular structure…',
  toolRunning: 'Updating viewer…',
  toolFailed: 'Molecular viewer action failed',
  styles: { cartoon: 'Cartoon', 'cartoon-sticks': 'Cartoon + sticks', sticks: 'Sticks', spheres: 'Spheres', line: 'Lines' },
  colors: { chain: 'Chain', secondary: 'Secondary structure', element: 'Element', residue: 'Residue', bfactor: 'B-factor', uniform: 'Single color' },
}

const WATER = ['HOH', 'WAT', 'DOD', 'H2O', 'TIP', 'TIP3', 'SOL']
const IONS = [
  'NA', 'K', 'CL', 'MG', 'CA', 'ZN', 'FE', 'MN', 'CU', 'CO', 'NI', 'CD', 'HG',
  'SO4', 'PO4', 'NO3', 'NH4', 'IOD', 'BR',
]
const NOT_WATER = { not: { resn: WATER } }
const LIGANDS = { hetflag: true, not: { resn: [...WATER, ...IONS] } }
const BACKBONE_ATOMS = new Set(['CA', 'P', "O3'", 'O3*'])
const PICK_COLOR = '#22d3ee'
const ENDPOINT_COLORS = ['#fbbf24', PICK_COLOR]

const STYLE_OPTIONS = ['cartoon', 'cartoon-sticks', 'sticks', 'spheres', 'line']
const COLOR_OPTIONS = ['chain', 'secondary', 'element', 'residue', 'bfactor', 'uniform']

function colorScheme(color, colorHex, bRange) {
  if (color === 'uniform') return { color: colorHex || '#5b8def' }
  if (color === 'bfactor') {
    if (!bRange || bRange[0] === bRange[1]) return { color: '#f8fafc' }
    return { colorscheme: { prop: 'b', gradient: 'rwb', min: bRange[0], max: bRange[1] } }
  }
  const scheme = {
    chain: 'chain',
    secondary: 'ssPyMol',
    element: 'Jmol',
    residue: 'amino',
  }[color] || 'chain'
  return { colorscheme: scheme }
}

function styleSpec(style, color, colorHex, bRange) {
  const colorPart = colorScheme(color, colorHex, bRange)
  if (style === 'cartoon') return { cartoon: { ...colorPart, thickness: 0.35 } }
  if (style === 'cartoon-sticks') return { cartoon: { ...colorPart, thickness: 0.28 }, stick: { ...colorPart, radius: 0.11 } }
  if (style === 'sticks') return { stick: { ...colorPart, radius: 0.14, showNonBonded: true } }
  if (style === 'spheres') return { sphere: { ...colorPart, scale: 0.62 } }
  return { line: { ...colorPart, linewidth: 1.2 } }
}

function selectionOf(input) {
  if (!input || typeof input !== 'object') return null
  const out = {}
  if (typeof input.chain === 'string' && input.chain) out.chain = input.chain
  if (typeof input.resn === 'string' && input.resn) {
    const names = input.resn.split(/[\s,]+/).filter(Boolean)
    out.resn = names.length > 1 ? names : names[0]
  }
  if (Array.isArray(input.resn) && input.resn.length > 0) out.resn = input.resn
  if (typeof input.resi === 'string' && input.resi) {
    const residues = input.resi.split(',').map(item => item.trim()).filter(Boolean)
    if (residues.length > 0) out.resi = residues.length === 1 ? residues[0] : residues
  }
  else if (typeof input.resi === 'number') out.resi = String(input.resi)
  return Object.keys(out).length > 0 ? out : null
}

const STYLE_TEXT = `
.mv-root, .mv-modal-root { --mv-viewport: #0b1220; --mv-grid: rgba(148, 163, 184, 0.18); }
.mv-inline { display: flex; flex-direction: column; width: 100%; min-width: 0; border: 1px solid var(--dsw-alias-border-l2, rgba(148,163,184,.3)); border-radius: 14px; overflow: hidden; background: var(--dsw-alias-bg-module-platform, #fff); }
.mv-transcript { display: grid; gap: 6px; min-width: 0; }
.mv-panel-host, .mv-panel { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; }
.mv-inline:not([data-expanded]) .mv-head { border-bottom: 0; }
.mv-head { display: flex; flex: none; align-items: center; gap: 10px; padding: 9px 12px; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(148,163,184,.22)); background: var(--dsw-alias-bg-module-platform, #fff); }
.mv-head-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.mv-title { font-size: 13px; font-weight: 650; letter-spacing: -.01em; color: var(--dsw-alias-label-primary, #0f172a); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mv-sub { font-size: 11px; color: var(--dsw-alias-label-tertiary, #64748b); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mv-badge { flex: none; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; line-height: 16px; padding: 0 6px; border-radius: 6px; background: var(--dsw-alias-interactive-bg-hover, #f1f5f9); color: var(--dsw-alias-label-secondary, #475569); }
.mv-icon { width: 26px; height: 26px; flex: none; border-radius: 8px; display: grid; place-items: center; background: linear-gradient(135deg, rgba(91,141,239,.16), rgba(168,121,232,.16)); color: #6f8fe8; }
.mv-icon svg { width: 17px; height: 17px; display: block; }
.mv-viewport { position: relative; height: clamp(240px, 45vh, 380px); min-height: 0; background: #0b1220; overflow: hidden; }
.mv-viewport[data-measuring] canvas { cursor: crosshair; }
.mv-canvas { position: absolute; inset: 0; }
.mv-canvas canvas { display: block; }
.mv-overlay-top { position: absolute; inset: 8px 10px auto 10px; display: flex; gap: 6px; align-items: center; pointer-events: none; }
.mv-overlay-top > * { pointer-events: auto; }
.mv-chip { font-size: 10px; line-height: 20px; padding: 0 7px; border-radius: 6px; color: rgba(226,232,240,.78); background: rgba(15,23,42,.6); border: 1px solid rgba(148,163,184,.22); backdrop-filter: blur(6px); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.mv-loading { position: absolute; inset: 0; display: grid; place-items: center; gap: 8px; color: #cbd5e1; font-size: 12px; background: rgba(11,18,32,.55); z-index: 2; }
.mv-error { position: absolute; inset: 0; display: grid; place-items: center; padding: 24px; color: #fecaca; font-size: 12px; text-align: center; background: rgba(11,18,32,.82); z-index: 3; }
.mv-error button { margin-top: 10px; }
.mv-controls { display: flex; flex: none; align-items: center; gap: 6px; padding: 7px 9px; background: var(--dsw-alias-bg-module-platform, #fff); border-top: 1px solid var(--dsw-alias-border-l2, rgba(148,163,184,.22)); overflow-x: auto; scrollbar-width: none; }
.mv-controls::-webkit-scrollbar { display: none; }
.mv-field { display: inline-flex; align-items: center; gap: 4px; flex: none; }
.mv-field > span { display: none; }
.mv-select { appearance: none; height: 26px; padding: 0 22px 0 8px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l2, rgba(148,163,184,.35)); background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-secondary, #334155); font: inherit; font-size: 11px; cursor: pointer; background-image: linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%); background-position: calc(100% - 11px) 11px, calc(100% - 7px) 11px; background-size: 4px 4px, 4px 4px; background-repeat: no-repeat; }
.mv-btn { flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 26px; padding: 0 8px; border-radius: 7px; border: 1px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary, #475569); font: inherit; font-size: 11px; cursor: pointer; white-space: nowrap; }
.mv-btn:hover { background: var(--dsw-alias-interactive-bg-hover, #f1f5f9); }
.mv-btn.mv-on { background: rgba(91,141,239,.13); color: var(--dsw-alias-state-business-primary, #3b6fe0); border-color: rgba(91,141,239,.22); }
.mv-btn.mv-icon-only { width: 26px; padding: 0; }
.mv-btn svg { width: 13px; height: 13px; display: block; }
.mv-spacer { flex: 1; }
.mv-residue { padding: 9px 12px; border-top: 1px solid var(--dsw-alias-border-l2, rgba(148,163,184,.22)); color: var(--dsw-alias-label-primary, #0f172a); font-size: 11px; }
.mv-residue-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 5px 10px; }
.mv-residue-name { display: inline-flex; align-items: center; gap: 7px; overflow-wrap: anywhere; }
.mv-residue-name::before { content: ''; flex: none; width: 8px; height: 8px; border-radius: 50%; background: ${PICK_COLOR}; }
.mv-residue-facts { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 4px 0 0; }
.mv-residue-facts > div { display: flex; gap: 5px; }
.mv-residue-facts dt { color: var(--dsw-alias-label-tertiary, #64748b); }
.mv-residue-facts dd { margin: 0; overflow-wrap: anywhere; }
.mv-measure { padding: 9px 12px; border-top: 1px solid var(--dsw-alias-border-l2, rgba(148,163,184,.22)); color: var(--dsw-alias-label-primary, #0f172a); font-size: 11px; }
.mv-measure-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 9px; }
.mv-distance { color: var(--dsw-alias-label-primary, #0f172a); font: 650 14px ui-monospace, Menlo, monospace; }
.mv-endpoints { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 5px 0 0; padding: 0; list-style: none; }
.mv-endpoints li { display: inline-flex; align-items: baseline; gap: 5px; overflow-wrap: anywhere; }
.mv-endpoint-key { width: 16px; line-height: 16px; flex: none; border-radius: 4px; text-align: center; color: #0b1220; font-weight: 650; }
.mv-measure p { margin: 5px 0 0; }
.mv-legend { display: flex; gap: 5px; align-items: center; flex-wrap: wrap; padding: 0 10px 7px; background: var(--dsw-alias-bg-module-platform, #fff); }
.mv-chain { display: inline-flex; align-items: center; gap: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 9px; color: var(--dsw-alias-label-tertiary, #64748b); }
.mv-chain i { width: 7px; height: 7px; border-radius: 2px; display: block; }
.mv-empty { display: flex; align-items: center; gap: 8px; padding: 12px; color: var(--dsw-alias-label-tertiary, #64748b); font-size: 12px; }
.mv-modal-root { position: fixed; inset: 0; z-index: 80; display: grid; place-items: center; padding: 24px; background: rgba(2,6,23,.62); backdrop-filter: blur(4px); }
.mv-modal { width: min(1120px, 96vw); max-height: 92vh; border-radius: 16px; overflow: auto; background: var(--dsw-alias-bg-module-platform, #fff); border: 1px solid var(--dsw-alias-border-l2, rgba(148,163,184,.3)); box-shadow: 0 24px 70px rgba(2,6,23,.4); display: flex; flex-direction: column; }
.mv-modal .mv-viewport { height: min(62vh, 720px); }
.mv-modal-head { display: flex; align-items: center; gap: 10px; padding: 11px 14px; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(148,163,184,.22)); }
.mv-card { border: 1px solid var(--dsw-alias-border-l2, rgba(148,163,184,.3)); border-radius: 12px; padding: 10px 12px; margin: 6px 0; display: flex; align-items: center; gap: 10px; background: var(--dsw-alias-bg-module-platform, #fff); }
.mv-card-main { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
.mv-card-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary, #0f172a); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mv-card-sub { font-size: 11px; color: var(--dsw-alias-label-tertiary, #64748b); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mv-card-error { border-color: rgba(239,68,68,.35); background: rgba(239,68,68,.04); }
.mv-card-error .mv-card-title { color: var(--dsw-alias-state-error-primary, #dc2626); }
.mv-primary { height: 27px; padding: 0 10px; border-radius: 7px; border: 1px solid rgba(91,141,239,.3); background: rgba(91,141,239,.1); color: var(--dsw-alias-state-business-primary, #315fd0); font: inherit; font-size: 11px; cursor: pointer; flex: none; }
.mv-primary:hover { background: rgba(91,141,239,.17); }
.mv-skeleton { height: 42px; border-radius: 12px; margin: 6px 0; background: linear-gradient(90deg, rgba(148,163,184,.09), rgba(148,163,184,.16), rgba(148,163,184,.09)); background-size: 200% 100%; animation: mv-shimmer 1.6s linear infinite; }
@keyframes mv-shimmer { to { background-position: -200% 0; } }
@media (max-width: 640px) {
  .mv-viewport { height: 220px; }
  .mv-modal-root { padding: 8px; }
}
`

function Icon({ name, size = 16 }) {
  const paths = {
    atom: h(React.Fragment, null,
      h('circle', { cx: 8, cy: 8, r: 2 }),
      h('ellipse', { cx: 8, cy: 8, rx: 6.4, ry: 2.8, transform: 'rotate(30 8 8)' }),
      h('ellipse', { cx: 8, cy: 8, rx: 6.4, ry: 2.8, transform: 'rotate(-30 8 8)' })),
    spin: h(React.Fragment, null,
      h('path', { d: 'M12.5 3.5a6.5 6.5 0 1 0 1.8 4.5' }),
      h('path', { d: 'M14 1v4h-4' })),
    reset: h(React.Fragment, null,
      h('path', { d: 'M3 8a5 5 0 1 0 1.6-3.7' }),
      h('path', { d: 'M2 1.5v4h4' }),
      h('circle', { cx: 8, cy: 8, r: 1.3 })),
    expand: h('path', { d: 'M6 2H2v4M10 2h4v4M14 10v4h-4M2 10v4h4' }),
    collapse: h('path', { d: 'M2 6h4V2M14 6h-4V2M10 14v-4h4M6 14v-4H2' }),
    download: h(React.Fragment, null,
      h('path', { d: 'M8 2v8' }),
      h('path', { d: 'M5 7l3 3 3-3' }),
      h('path', { d: 'M2.5 13.5h11' })),
    close: h('path', { d: 'M3 3l10 10M13 3L3 13' }),
    chevron: h('path', { d: 'M3 6l5 5 5-5' }),
  }
  return h('svg', {
    viewBox: '0 0 16 16',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: name === 'atom' ? 1.2 : 1.5,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
  }, paths[name] || paths.atom)
}

function readModel(model, cifRows) {
  const atoms = model.selectedAtoms({})
  if (!atoms.length) throw new Error(TEXT.noAtoms)
  let min = Infinity
  let max = -Infinity
  let hasBackbone = false
  for (const atom of atoms) {
    if (!Number.isFinite(atom.x) || !Number.isFinite(atom.y) || !Number.isFinite(atom.z)) {
      throw new Error(TEXT.noAtoms)
    }
    if (Number.isFinite(atom.b)) {
      min = Math.min(min, atom.b)
      max = Math.max(max, atom.b)
    }
    if (!atom.hetflag && BACKBONE_ATOMS.has(atom.atom)) hasBackbone = true
  }
  return { model, hasBackbone, bRange: Number.isFinite(min) ? [min, max] : null, residues: indexResidues(atoms, cifRows) }
}

function drawDistance(viewer, measurement, residues) {
  const [a, b] = measurement.endpoints.map(({ residue, atom }) =>
    residues.atomsFor(residue).find(candidate => candidate.index === atom.index))
  if (!a || !b) return null
  const distance = measurement.distanceAngstrom
  const start = { x: a.x, y: a.y, z: a.z }
  const end = { x: b.x, y: b.y, z: b.z }
  const dashLength = Math.max(0.35, distance / 50)
  const line = distance > 0 ? viewer.addCylinder({
    start, end, color: '#f8fafc', radius: 0.10,
    dashed: distance > 0.6, dashLength, gapLength: dashLength / 2,
  }) : null
  const label = viewer.addLabel(distanceText(distance), {
    position: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 },
    fontSize: 12, fontColor: '#f8fafc', backgroundColor: '#0b1220',
    backgroundOpacity: 0.85, inFront: true,
  }, undefined, true)
  return { line, label }
}

function SceneViewer({ scene, measurement, resetSignal, active, onPicked, onPickError, exportViewerRef }) {
  const hostRef = useRef(null)
  const pick = useRef(onPicked)
  const pickError = useRef(onPickError)
  const [viewer, setViewer] = useState(null)
  const [loaded, setLoaded] = useState(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [initAttempt, setInitAttempt] = useState(0)
  const rendered = useRef({})
  const labelHandles = useRef([])
  const selectionModels = useRef([])
  const distanceVisual = useRef(null)
  const url = scene.url
  const modelKey = `${url}:${scene.format}`
  const current = loaded?.key === modelKey ? loaded : null

  function clearLabels(instance) {
    for (const label of labelHandles.current) instance.removeLabel(label)
    labelHandles.current = []
  }

  function clearDistance(instance) {
    if (!distanceVisual.current) return
    const { line, label } = distanceVisual.current
    if (line) instance.removeShape(line)
    instance.removeLabel(label)
    distanceVisual.current = null
  }

  useLayoutEffect(() => {
    pick.current = onPicked
    pickError.current = onPickError
  }, [onPicked, onPickError])

  useEffect(() => {
    const host = hostRef.current
    let instance
    try {
      instance = $3Dmol.createViewer(host, {
        backgroundColor: '#0b1220',
        antialias: true,
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      host.replaceChildren()
      return
    }
    host.querySelector('canvas')?.setAttribute('aria-label', TEXT.title)
    setViewer(instance)
    return () => {
      instance.spin(false)
      clearLabels(instance)
      clearDistance(instance)
      instance.clear()
      selectionModels.current = []
      exportViewerRef.current = null
      host.replaceChildren()
    }
  }, [exportViewerRef, initAttempt])

  useEffect(() => {
    if (!viewer) return
    const controller = new AbortController()
    setLoaded(null)
    setError('')
    exportViewerRef.current = null
    rendered.current = {}
    viewer.spin(false)
    clearLabels(viewer)
    clearDistance(viewer)
    viewer.removeAllModels()
    selectionModels.current = []
    viewer.render()
    void (async () => {
      try {
        if (!/^\/dsh-molecular-viewer\/structures\/[A-Za-z0-9_-]+\.(?:pdb|cif)$/.test(url)) {
          throw new Error('Invalid structure address.')
        }
        const response = await fetch(url, { cache: 'force-cache', signal: controller.signal })
        if (!response.ok) throw new Error(`Structure request failed (HTTP ${response.status}).`)
        const text = await response.text()
        if (controller.signal.aborted) return
        const model = viewer.addModel(text, scene.format === 'cif' ? 'cif' : 'pdb', { keepH: true })
        const facts = readModel(model, scene.format === 'cif' ? cifResidueFields(text) : undefined)
        model.setClickable(NOT_WATER, true, atom => {
          try {
            const residue = facts.residues.describe(atom)
            pick.current(residue, facts.residues.atomsFor(residue))
          } catch (cause) {
            pickError.current(cause instanceof Error ? cause.message : String(cause))
          }
        })
        setLoaded({ key: modelKey, ...facts })
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }
    })()
    return () => controller.abort()
  }, [viewer, modelKey, url, scene.format, attempt, exportViewerRef])

  useEffect(() => {
    if (!viewer || !current || error) return
    const previous = rendered.current
    const style = scene.style.startsWith('cartoon') && !(scene.stats?.polymer ?? current.hasBackbone)
      ? 'sticks'
      : scene.style
    const highlights = scene.highlights ?? []
    const labels = scene.labels ?? []
    const appearance = JSON.stringify([style, scene.color, scene.colorHex, highlights])
    const annotations = JSON.stringify(labels)
    const generation = scene.generation ?? scene.id
    const focus = selectionOf(scene.focus?.selection)
    const focusKey = JSON.stringify([focus, scene.focus?.revision])
    const spin = Boolean(scene.spin && active)
    const selected = scene.selectedResidue
    const picks = measurement
      ? measurement.endpoints.map(({ residue }, index) => ({ residue, color: ENDPOINT_COLORS[index] }))
      : selected ? [{ residue: selected, color: PICK_COLOR }] : []
    const selectionKey = picks.length
      ? JSON.stringify([style, picks.map(({ residue, color }) => [residueKey(residue), color])])
      : ''
    const result = measurement?.result ?? null
    const measurementKey = result ? JSON.stringify(result) : ''
    const model = current.model.getID()
    try {
      let draw = false
      if (appearance !== previous.appearance) {
        current.model.setStyle({ resn: WATER }, {})
        current.model.setStyle(NOT_WATER, styleSpec(style, scene.color, scene.colorHex, current.bRange))
        if (style.startsWith('cartoon')) {
          current.model.setStyle(LIGANDS, { stick: { colorscheme: 'Jmol', radius: 0.18, showNonBonded: true } }, true)
        }
        for (const item of highlights) {
          const selection = selectionOf(item.selection)
          if (!selection) continue
          current.model.setStyle(selection, {
            stick: { color: item.colorHex || '#f59e0b', radius: 0.24, showNonBonded: true },
            ...(style.startsWith('cartoon') ? { cartoon: { color: item.colorHex || '#f59e0b' } } : {}),
          }, true)
        }
        draw = true
      }
      if (annotations !== previous.annotations) {
        clearLabels(viewer)
        for (const item of labels) {
          const selection = selectionOf(item.selection)
          if (!selection || !current.model.selectedAtoms(selection).length) continue
          labelHandles.current.push(viewer.addLabel(item.text, {
            fontSize: 11,
            fontColor: '#f8fafc',
            backgroundColor: '#111827',
            backgroundOpacity: 0.78,
            borderThickness: 1,
            borderColor: item.colorHex || '#f59e0b',
            inFront: true,
            showBackground: true,
          }, { ...selection, model }, true))
        }
        draw = true
      }
      if (selectionKey !== (previous.selectionKey ?? '')) {
        for (const overlay of selectionModels.current) viewer.removeModel(overlay)
        selectionModels.current = []
        for (const { residue, color } of picks) {
          const atoms = current.residues.atomsFor(residue)
          if (!atoms.length) continue
          const overlay = viewer.addModel()
          overlay.addAtoms(atoms.map(atom => ({ ...atom, clickable: false, hoverable: false })))
          overlay.setStyle({}, {
            stick: { color, radius: 0.27, showNonBonded: true },
            sphere: { color, scale: style === 'spheres' ? 0.76 : 0.32 },
          })
          selectionModels.current.push(overlay)
        }
        draw = true
      }
      if (measurementKey !== (previous.measurementKey ?? '')) {
        clearDistance(viewer)
        if (result) distanceVisual.current = drawDistance(viewer, result, current.residues)
        draw = true
      }
      const newScene = generation !== previous.generation
      if (newScene || resetSignal !== previous.resetSignal) {
        viewer.zoomTo(newScene && focus && current.model.selectedAtoms(focus).length ? { ...focus, model } : { model })
        draw = true
      } else if (focusKey !== previous.focusKey && (focus || previous.focus)) {
        if (!focus || current.model.selectedAtoms(focus).length) viewer.zoomTo({ ...focus, model })
        draw = true
      }
      if (spin !== previous.spin) viewer.spin(spin ? 'y' : false, 0.7, true)
      if (draw) viewer.render()
      exportViewerRef.current = viewer
      rendered.current = { appearance, annotations, focusKey, focus, generation, resetSignal, selectionKey, spin, measurementKey }
    } catch (cause) {
      exportViewerRef.current = null
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [scene, measurement, current, viewer, active, error, resetSignal, exportViewerRef])

  return h('div', { className: 'mv-viewport', 'data-measuring': measurement ? '' : undefined },
    h('div', { ref: hostRef, className: 'mv-canvas' }),
    h('div', { className: 'mv-overlay-top' },
      scene.pdbId ? h('span', { className: 'mv-chip' }, scene.pdbId) : null,
      scene.stats?.atoms ? h('span', { className: 'mv-chip' }, `${scene.stats.atoms.toLocaleString()} ${TEXT.atoms}`) : null,
      scene.stats?.chains ? h('span', { className: 'mv-chip' }, `${scene.stats.chains} ${TEXT.chains}`) : null,
      scene.stats?.residues ? h('span', { className: 'mv-chip' }, `${scene.stats.residues.toLocaleString()} ${TEXT.residues}`) : null),
    !current && !error ? h('div', { className: 'mv-loading', role: 'status' }, TEXT.loading) : null,
    error ? h('div', { className: 'mv-error', role: 'alert' },
      h('div', null,
        h('div', null, TEXT.loadError),
        h('div', { style: { opacity: 0.72, marginTop: 4 } }, error),
        h('button', {
          type: 'button',
          className: 'mv-primary',
          onClick: () => {
            setError('')
            if (viewer) setAttempt(value => value + 1)
            else setInitAttempt(value => value + 1)
          },
        }, TEXT.retry))) : null)
}

async function fetchState(sessionId, signal) {
  const response = await fetch(`/dsh-molecular-viewer/api/state?sessionId=${encodeURIComponent(sessionId)}`, {
    cache: 'no-store',
    signal,
  })
  if (!response.ok) throw new Error(`Viewer state request failed (HTTP ${response.status}).`)
  const data = await response.json()
  if (!data.ok) throw new Error(data.error || 'Viewer state is unavailable.')
  return data.scene
}

async function patchState(sessionId, generation, patch, signal) {
  const response = await fetch('/dsh-molecular-viewer/api/state', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, generation, ...patch }),
    signal,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || !data.ok) throw new Error(data.error || `Viewer state update failed (HTTP ${response.status}).`)
  return data.scene
}

const emptyView = { scene: null, offline: false, error: '', pending: false }
const sessionViews = new Map()

function publish(entry, changes) {
  if (Object.entries(changes).every(([key, value]) => entry.view[key] === value)) return
  entry.view = { ...entry.view, ...changes }
  for (const listener of entry.listeners) listener()
}

async function pollScene(sessionId, entry) {
  const { signal } = entry.controller
  const mutations = entry.mutations
  try {
    if (entry.view.pending) return
    const next = await fetchState(sessionId, signal)
    if (signal.aborted || mutations !== entry.mutations) return
    const current = entry.view.scene
    const unchanged = next?.generation === current?.generation && next?.revision === current?.revision
    publish(entry, { scene: unchanged ? current : next, offline: false })
  } catch {
    if (!signal.aborted && mutations === entry.mutations) publish(entry, { offline: true })
  } finally {
    if (!signal.aborted) {
      const delay = document.hidden ? 12000 : entry.view.scene?.visible ? 2200 : 5000
      entry.timer = window.setTimeout(() => void pollScene(sessionId, entry), delay)
    }
  }
}

function subscribeToScene(sessionId, listener) {
  let entry = sessionViews.get(sessionId)
  const fresh = !entry
  if (!entry) {
    entry = { view: emptyView, listeners: new Set(), controller: new AbortController(), mutations: 0 }
    sessionViews.set(sessionId, entry)
  }
  entry.listeners.add(listener)
  if (fresh) void pollScene(sessionId, entry)
  return () => {
    entry.listeners.delete(listener)
    if (entry.listeners.size > 0) return
    entry.controller.abort()
    window.clearTimeout(entry.timer)
    sessionViews.delete(sessionId)
  }
}

async function updateScene(sessionId, generation, patch) {
  const entry = sessionViews.get(sessionId)
  if (!entry || entry.view.scene?.generation !== generation) return
  const { signal } = entry.controller
  entry.queuedPatch = { ...entry.queuedPatch, ...patch }
  const drafts = {}
  if (Object.hasOwn(patch, 'selectedResidue')) drafts.selectionDraft = patch.selectedResidue
  if (Object.hasOwn(patch, 'lastMeasurement')) drafts.measurementDraft = patch.lastMeasurement
  publish(entry, drafts)
  if (entry.view.pending) return

  entry.mutations += 1
  publish(entry, { pending: true, error: '' })
  try {
    while (entry.queuedPatch && !signal.aborted) {
      const nextPatch = entry.queuedPatch
      entry.queuedPatch = null
      const next = await patchState(sessionId, generation, nextPatch, signal)
      if (!signal.aborted) publish(entry, { scene: next, offline: false })
    }
  } catch (cause) {
    if (!signal.aborted) publish(entry, { error: cause.message || String(cause) })
  } finally {
    entry.queuedPatch = null
    if (!signal.aborted) publish(entry, { pending: false, selectionDraft: undefined, measurementDraft: undefined })
  }
}

function useActiveScene(sessionId) {
  const subscribe = useCallback(listener => subscribeToScene(sessionId, listener), [sessionId])
  const getSnapshot = useCallback(() => sessionViews.get(sessionId)?.view ?? emptyView, [sessionId])
  return useSyncExternalStore(subscribe, getSnapshot)
}

function ModalFrame({ scene, onClose, bodyRef, children }) {
  const closeRef = useRef(null)
  useEffect(() => {
    const previous = document.activeElement
    closeRef.current?.focus()
    const onKey = event => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [onClose])

  return createPortal(h('div', {
    className: 'mv-modal-root',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': TEXT.title,
    onMouseDown: event => { if (event.target === event.currentTarget) onClose() },
  },
  h('div', { className: 'mv-modal' },
    h('div', { className: 'mv-modal-head' },
      h(SceneHeading, { scene }),
      h('button', { type: 'button', ref: closeRef, className: 'mv-btn mv-icon-only', onClick: onClose, title: TEXT.dismiss },
        h(Icon, { name: 'close' }))),
    h('div', { ref: bodyRef }, children))),
  document.body)
}

function SceneHeading({ scene }) {
  return h(React.Fragment, null,
    h('div', { className: 'mv-icon' }, h(Icon, { name: 'atom', size: 17 })),
    h('div', { className: 'mv-head-main' },
      h('div', { className: 'mv-title' }, scene.title || TEXT.title),
      h('div', { className: 'mv-sub' }, scene.summary || TEXT.viewerHint)),
    scene.pdbId ? h('span', { className: 'mv-badge' }, scene.pdbId) : null)
}

function ResidueDetails({ residue, clear }) {
  const position = residue.number === null ? '' : ` ${residue.number}${residue.insertionCode}`
  const numbering = residue.number === null ? TEXT.unassignedNumber
    : residue.numbering === 'label' ? TEXT.labelNumber : TEXT.authorNumber
  const clicked = [residue.atomName, residue.element ? `(${residue.element})` : ''].filter(Boolean).join(' ')
  const facts = [
    [TEXT.chains, residue.chain || TEXT.blankChain],
    [TEXT.residues, numbering],
    [TEXT.atomCount, residue.atomCount],
  ]
  if (residue.labelChain && residue.labelChain !== residue.chain) facts.push([TEXT.labelChain, residue.labelChain])
  if (residue.modelNumber !== null) facts.push([TEXT.model, residue.modelNumber])
  if (clicked) facts.push([TEXT.clickedAtom, clicked])
  if (residue.bFactor !== null) facts.push(['B-factor', `${residue.bFactor.toLocaleString(undefined, { maximumFractionDigits: 2 })} Å²`])
  return h('section', { className: 'mv-residue', 'aria-label': TEXT.picked },
    h('div', { className: 'mv-residue-head' },
      h('strong', { className: 'mv-residue-name', 'aria-live': 'polite' }, `${TEXT.picked} · ${residue.name}${position}`),
      h('button', { type: 'button', className: 'mv-btn', onClick: clear }, TEXT.clearSelection)),
    h('dl', { className: 'mv-residue-facts' },
      facts.map(([label, value]) => h('div', { key: label }, h('dt', null, label), h('dd', null, value)))))
}

function measurementEndpointText(residue, atom) {
  const number = residue.number === null ? TEXT.unassignedNumber : `${residue.number}${residue.insertionCode}`
  const chain = residue.chain ? `${TEXT.chain} ${residue.chain}` : TEXT.blankChain
  const fields = [chain, `${residue.name} ${number}`]
  if (residue.labelChain && residue.labelChain !== residue.chain) fields.push(`${TEXT.labelChain} ${residue.labelChain}`)
  if (atom) {
    fields.push(`${atom.name}${atom.altLocation ? ` (${atom.altLocation})` : ''}`)
  }
  return fields.join(' · ')
}

function MeasurementDetails({ measurement, syncing, clear }) {
  const { endpoints, result, error } = measurement
  const hint = endpoints.length === 0 ? TEXT.firstResidue : TEXT.secondResidue
  return h('section', { className: 'mv-measure', 'aria-label': TEXT.distance },
    h('div', { className: 'mv-measure-head' },
      h('strong', null, TEXT.distance),
      result ? h('output', { className: 'mv-distance', 'aria-live': 'polite' }, distanceText(result.distanceAngstrom)) : null,
      syncing ? h('span', { className: 'mv-sub', role: 'status' }, TEXT.syncingMeasurement) : null,
      h('span', { className: 'mv-spacer' }),
      endpoints.length || error ? h('button', { type: 'button', className: 'mv-btn', onClick: clear }, TEXT.clearMeasurement) : null),
    endpoints.length ? h('ol', { className: 'mv-endpoints' }, endpoints.map(({ residue, atom }, index) =>
      h('li', { key: residueKey(residue) },
        h('span', { className: 'mv-endpoint-key', style: { backgroundColor: ENDPOINT_COLORS[index] } }, index === 0 ? 'A' : 'B'),
        measurementEndpointText(residue, atom)))) : null,
    error ? h('p', { role: 'alert' }, TEXT.measureErrors[error])
      : !result ? h('p', { role: 'status' }, hint) : null)
}

function MoleculePanel({ scene, update, pending, syncingMeasurement, offline, error, active, children }) {
  const [resetSignal, setResetSignal] = useState(0)
  const [pickError, setPickError] = useState('')
  const [pngError, setPngError] = useState('')
  const [measuring, setMeasuring] = useState(false)
  const [pendingMeasurement, setPendingMeasurement] = useState(EMPTY_MEASUREMENT)
  const exportViewerRef = useRef(null)
  const options = scene.stats?.polymer === false ? STYLE_OPTIONS.filter(value => !value.startsWith('cartoon')) : STYLE_OPTIONS
  const result = pendingMeasurement.endpoints.length === 0 ? scene.lastMeasurement : null
  const measurement = measuring ? {
    endpoints: result?.endpoints ?? pendingMeasurement.endpoints,
    result,
    error: pendingMeasurement.error,
  } : null

  function selectResidue(selectedResidue) {
    setPickError('')
    update({ selectedResidue })
  }

  function pickResidue(residue, atoms) {
    if (!measuring) {
      selectResidue(residue)
      return
    }
    setPickError('')
    const next = pickMeasurementResidue(pendingMeasurement, residue, atoms)
    if (next.pair) {
      update({ lastMeasurement: measurementRecord(next) })
      setPendingMeasurement(EMPTY_MEASUREMENT)
    } else {
      setPendingMeasurement(next)
    }
  }

  function toggleMeasurement() {
    setPickError('')
    setPendingMeasurement(EMPTY_MEASUREMENT)
    setMeasuring(previous => !previous)
  }

  function clearMeasurement() {
    setPendingMeasurement(EMPTY_MEASUREMENT)
    if (scene.lastMeasurement) update({ lastMeasurement: null })
  }

  function download() {
    const viewer = exportViewerRef.current
    if (!viewer) return
    setPngError('')
    try {
      const link = document.createElement('a')
      link.href = viewer.pngURI()
      link.download = `${scene.pdbId || 'structure'}.png`
      link.click()
    } catch (cause) {
      setPngError(cause.message || String(cause))
    }
  }

  return h('div', { className: 'mv-panel' },
    h(SceneViewer, { scene, measurement, resetSignal, active, onPicked: pickResidue, onPickError: setPickError, exportViewerRef }),
    h('div', { className: 'mv-controls' },
      h('button', {
        type: 'button', className: `mv-btn ${measuring ? 'mv-on' : ''}`,
        'aria-pressed': measuring, onClick: toggleMeasurement,
      }, TEXT.measure),
      h('select', {
        className: 'mv-select',
        value: scene.style,
        disabled: pending,
        onChange: event => update({ style: event.target.value }),
        'aria-label': TEXT.style,
        title: TEXT.style,
      }, options.map(value => h('option', { key: value, value }, TEXT.styles[value]))),
      h('select', {
        className: 'mv-select',
        value: scene.color,
        disabled: pending,
        onChange: event => update({ color: event.target.value }),
        'aria-label': TEXT.color,
        title: TEXT.color,
      }, COLOR_OPTIONS.map(value => h('option', { key: value, value }, TEXT.colors[value]))),
      h('button', {
        type: 'button',
        className: `mv-btn ${scene.spin ? 'mv-on' : ''}`,
        disabled: pending,
        onClick: () => update({ spin: !scene.spin }),
        title: scene.spin ? TEXT.stopSpin : TEXT.spin,
      }, h(Icon, { name: 'spin' }), scene.spin ? TEXT.stopSpin : TEXT.spin),
      h('button', {
        type: 'button', className: 'mv-btn mv-icon-only', title: TEXT.reset,
        onClick: () => setResetSignal(value => value + 1),
      }, h(Icon, { name: 'reset' })),
      h('span', { className: 'mv-spacer' }),
      children,
      h('button', { type: 'button', className: 'mv-btn mv-icon-only', onClick: download, title: TEXT.download },
        h(Icon, { name: 'download' }))),
    measurement ? h(MeasurementDetails, { measurement, syncing: syncingMeasurement, clear: clearMeasurement })
      : scene.selectedResidue ? h(ResidueDetails, { residue: scene.selectedResidue, clear: () => selectResidue(null) }) : null,
    pickError ? h('div', { className: 'mv-empty', role: 'alert' }, `${TEXT.pickError}: ${pickError}`) : null,
    offline ? h('div', { className: 'mv-empty', role: 'status' }, TEXT.offline) : null,
    error || pngError ? h('div', { className: 'mv-empty', role: 'alert' }, `${TEXT.updateError}: ${error || pngError}`) : null)
}

function InlinePanel({ scene, update, pending, syncingMeasurement, offline, error, visible, bodyId }) {
  const [modal, setModal] = useState(false)
  const [panel] = useState(() => {
    const element = document.createElement('div')
    element.className = 'mv-panel-host'
    return element
  })
  const inlineBody = useRef(null)
  const modalBody = useRef(null)
  const modalOpen = modal && visible
  const closeModal = useCallback(() => setModal(false), [])

  useLayoutEffect(() => {
    const destination = modalOpen ? modalBody.current : inlineBody.current
    destination?.append(panel)
  }, [modalOpen, panel])

  useEffect(() => {
    if (!visible) closeModal()
  }, [visible, closeModal])

  return h(React.Fragment, null,
    h('div', { id: bodyId, ref: inlineBody, hidden: !visible || modalOpen }),
    modalOpen ? h(ModalFrame, { scene, bodyRef: modalBody, onClose: closeModal }) : null,
    createPortal(h(MoleculePanel, { scene, update, pending, syncingMeasurement, offline, error, active: visible },
      !modalOpen ? h('button', {
        type: 'button', className: 'mv-btn mv-icon-only', onClick: () => setModal(true), title: TEXT.fullscreen,
      }, h(Icon, { name: 'expand' })) : null), panel))
}

function TranscriptCard({ snapshot, sessionId }) {
  const view = useActiveScene(sessionId)
  const [collapsed, setCollapsed] = useState(false)
  const [preview, setPreview] = useState(null)
  const [wasVisible, setWasVisible] = useState(false)
  const bodyId = useId()
  const live = Boolean(snapshot.generation && view.scene?.generation === snapshot.generation)
  const scene = live && (view.selectionDraft !== undefined || view.measurementDraft !== undefined)
    ? {
      ...view.scene,
      selectedResidue: view.selectionDraft === undefined ? view.scene.selectedResidue : view.selectionDraft,
      lastMeasurement: view.measurementDraft === undefined ? view.scene.lastMeasurement : view.measurementDraft,
    }
    : live ? view.scene : preview ?? snapshot
  const visible = live ? scene.visible && !collapsed : Boolean(preview)
  const hasPanel = visible || (live && wasVisible)
  const update = live
    ? patch => void updateScene(sessionId, snapshot.generation, patch)
    : patch => setPreview(previous => ({ ...previous, ...patch }))

  useEffect(() => {
    if (visible) setWasVisible(true)
  }, [visible])

  function toggle() {
    if (!live) {
      setPreview(previous => previous ? null : snapshot)
    } else if (!scene.visible) {
      setCollapsed(false)
      update({ visible: true })
    } else {
      setCollapsed(previous => !previous)
    }
  }

  return h('section', { className: 'mv-inline', 'aria-label': TEXT.title, 'data-expanded': visible ? '' : undefined },
    h('div', { className: 'mv-head' },
      h(SceneHeading, { scene }),
      h('button', {
        type: 'button', className: 'mv-primary', disabled: live && view.pending, onClick: toggle,
        'aria-expanded': visible, 'aria-controls': hasPanel ? bodyId : undefined,
        title: live ? undefined : TEXT.preview,
      }, visible ? TEXT.collapse : TEXT.open)),
    !visible && live && view.error ? h('div', { className: 'mv-empty', role: 'alert' }, view.error) : null,
    hasPanel ? h(InlinePanel, {
      scene, update, visible, bodyId,
      pending: live && view.pending, offline: live && view.offline, error: live ? view.error : '',
      syncingMeasurement: live && view.measurementDraft !== undefined,
    }) : null)
}

function TranscriptViewer({ turn, sessionId, openResource, closeResource }) {
  const source = turn.data.source(VIEWER_ID)
  const snapshots = useSyncExternalStore(source.subscribe, source.getSnapshot)
  return snapshots && sessionId ? h('div', { className: 'mv-transcript' },
    snapshots.map((snapshot, index) => h(snapshot.kind === 'workbench' ? WorkbenchCard : TranscriptCard, {
      key: snapshot.generation ?? `${snapshot.id}:${index}`, snapshot, sessionId, openResource, closeResource,
    }))) : null
}

function ToolCard(props) {
  const block = props.block
  const meta = block?.meta
  const scene = meta?.scene

  if (props.phase === 'preparing' || props.phase === 'start') {
    return h('div', { className: 'mv-skeleton', title: TEXT.toolPending })
  }
  const failed = block?.isError === true || meta?.ok === false
  const content = Array.isArray(block?.content)
    ? block.content.filter(part => part?.type === 'text').map(part => part.text).join('\n')
    : ''
  return h('div', { className: failed ? 'mv-card mv-card-error' : 'mv-card' },
    h('div', { className: 'mv-icon' }, h(Icon, { name: 'atom' })),
    h('div', { className: 'mv-card-main' },
      h('div', { className: 'mv-card-title' }, failed ? TEXT.toolFailed : scene?.title || TEXT.title),
      h('div', { className: 'mv-card-sub' }, meta?.error || meta?.summary || scene?.summary || content || TEXT.viewerHint)))
}

function injectStyles() {
  const style = document.createElement('style')
  style.dataset.dshPlugin = 'dsh-molecular-viewer'
  style.textContent = STYLE_TEXT + WORKBENCH_STYLE
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
    id: VIEWER_ID,
    inject: sessionId => ({
      sessionId,
      openResource: address => ctx.sidebarRight.openResourceIn(sessionId, address),
      closeResource: address => {
        const tab = ctx.sidebarRight.openTabs.getSnapshot().find(item => item.sessionId === sessionId && item.contentId === address)
        if (tab) ctx.sidebarRight.closeIn(sessionId, tab.tabId)
      },
    }),
  }, TranscriptViewer))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: TOOL_NAME,
  }, ToolCard))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: WORKBENCH_TOOL,
  }, ToolCard))
}
