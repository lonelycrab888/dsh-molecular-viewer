import { normalizePickedResidue, residueIdentityText, residueKey } from './residue.js'

const NON_HEAVY_ELEMENTS = new Set(['', 'H', 'D', 'T', 'X', 'XX', 'DU'])
export const EMPTY_MEASUREMENT = { endpoints: [], pair: null, error: null }

function isHeavyElement(element) {
  return typeof element === 'string' && /^[A-Za-z]{1,4}$/.test(element) &&
    !NON_HEAVY_ELEMENTS.has(element.toUpperCase())
}

function heavyAtoms(atoms) {
  return atoms.filter(atom => isHeavyElement(atom.elem?.trim()) &&
    Number.isFinite(atom.x) && Number.isFinite(atom.y) && Number.isFinite(atom.z))
}

function closestPair(first, second) {
  let closestSquared = Infinity
  let atoms
  for (const a of first) {
    for (const b of second) {
      const dx = a.x - b.x
      const dy = a.y - b.y
      const dz = a.z - b.z
      const squared = dx * dx + dy * dy + dz * dz
      if (squared < closestSquared) {
        if (squared === 0) return { atoms: [a, b], distance: 0 }
        closestSquared = squared
        atoms = [a, b]
      }
    }
  }
  return atoms ? { atoms, distance: Math.sqrt(closestSquared) } : null
}

export function pickMeasurementResidue(measurement, residue, atoms) {
  const heavy = heavyAtoms(atoms)
  if (heavy.length === 0) return { ...measurement, error: 'noHeavyAtoms' }

  const endpoint = { residue, heavy }
  if (measurement.endpoints.length !== 1) {
    return { ...EMPTY_MEASUREMENT, endpoints: [endpoint] }
  }

  const [first] = measurement.endpoints
  if (residueKey(first.residue) === residueKey(residue)) return { ...measurement, error: 'sameResidue' }
  if (first.residue.modelNumber !== residue.modelNumber) return { ...measurement, error: 'differentModels' }

  const pair = closestPair(first.heavy, heavy)
  if (!pair) return { ...measurement, error: 'noDistance' }
  return { endpoints: [first, endpoint], pair, error: null }
}

export function distanceText(distance) {
  return `${distance.toFixed(2)} Å`
}

export function measurementRecord(measurement) {
  return normalizeMeasurement({
    distanceAngstrom: measurement.pair.distance,
    endpoints: measurement.endpoints.map(({ residue }, i) => {
      const atom = measurement.pair.atoms[i]
      return {
        residue,
        atom: {
          index: atom.index,
          name: atom.atom?.trim() || atom.elem.trim(),
          element: atom.elem.trim(),
          altLocation: atom.altLoc?.trim() || '',
        },
      }
    }),
  })
}

function readAtom(value) {
  if (!value || !Number.isSafeInteger(value.index) || value.index < 0 ||
    typeof value.name !== 'string' || !/^[!-~]{1,24}$/.test(value.name) ||
    !isHeavyElement(value.element) ||
    typeof value.altLocation !== 'string' || !/^[!-~]{0,4}$/.test(value.altLocation)) {
    throw new Error('Invalid heavy atom in the measurement.')
  }
  return { index: value.index, name: value.name, element: value.element, altLocation: value.altLocation }
}

export function normalizeMeasurement(value) {
  if (value === null) return null
  if (!value || !Array.isArray(value.endpoints) || value.endpoints.length !== 2 ||
    !Number.isFinite(value.distanceAngstrom) || value.distanceAngstrom < 0) {
    throw new Error('Invalid residue distance measurement.')
  }
  const endpoints = value.endpoints.map(endpoint => {
    const residue = normalizePickedResidue(endpoint?.residue)
    if (!residue) throw new Error('A residue is required for each measurement endpoint.')
    return { residue, atom: readAtom(endpoint?.atom) }
  })
  const [first, second] = endpoints
  if (residueKey(first.residue) === residueKey(second.residue) ||
    first.residue.modelNumber !== second.residue.modelNumber || first.atom.index === second.atom.index) {
    throw new Error('A distance measurement needs two distinct residues in the same model.')
  }
  return { endpoints, distanceAngstrom: value.distanceAngstrom }
}

export function lastMeasurementText(measurement) {
  const endpoints = measurement.endpoints.map(({ residue, atom }) => {
    const alt = atom.altLocation ? `, alternate location ${JSON.stringify(atom.altLocation)}` : ''
    return `[${residueIdentityText(residue)}, heavy atom ${JSON.stringify(atom.name)} (${atom.element})${alt}]`
  })
  return `User's last measurement (closest heavy-atom pair): ${endpoints.join(' to ')}, ${distanceText(measurement.distanceAngstrom)}.`
}
