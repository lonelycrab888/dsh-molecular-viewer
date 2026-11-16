export function residueKey(residue) {
  return JSON.stringify([
    residue.chain, residue.labelChain, residue.numbering, residue.number, residue.insertionCode,
    residue.name, residue.modelNumber, residue.number === null ? residue.atomIndex : null,
  ])
}

function token(value, limit, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > limit || (!allowEmpty && !value) || /[^!-~]/.test(value)) {
    throw new Error('Invalid residue selection.')
  }
  return value
}

function integer(value, minimum = Number.MIN_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error('Invalid residue selection.')
  return value
}

export function normalizePickedResidue(value) {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    (value.numbering !== 'author' && value.numbering !== 'label')) {
    throw new Error('Invalid residue selection.')
  }
  return {
    chain: token(value.chain, 32, true),
    labelChain: token(value.labelChain, 32, true),
    numbering: value.numbering,
    number: value.number === null ? null : integer(value.number),
    insertionCode: token(value.insertionCode, 4, true),
    name: token(value.name, 16),
    modelNumber: value.modelNumber === null ? null : integer(value.modelNumber, 1),
    atomIndex: integer(value.atomIndex, 0),
    atomName: token(value.atomName, 24, true),
    element: token(value.element, 4, true),
    atomCount: integer(value.atomCount, 1),
    bFactor: Number.isFinite(value.bFactor) ? value.bFactor : null,
  }
}

export function residueIdentityText(residue) {
  const position = residue.number === null ? 'unassigned residue number' : `${residue.number}${residue.insertionCode}`
  const chain = residue.chain === '' ? 'blank chain ID' : `chain ${JSON.stringify(residue.chain)}`
  const labelChain = residue.labelChain && residue.labelChain !== residue.chain
    ? `, label chain ${JSON.stringify(residue.labelChain)}`
    : ''
  const model = residue.modelNumber === null ? '' : `, model ${residue.modelNumber}`
  return `${chain}${labelChain}, ${JSON.stringify(residue.name)} ${position} (${residue.numbering} numbering)${model}`
}

export function pickedResidueText(residue) {
  const atom = residue.atomName ? `, clicked atom ${JSON.stringify(residue.atomName)}` : ''
  return residueIdentityText(residue) + atom
}
