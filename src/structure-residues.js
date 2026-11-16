import { normalizePickedResidue, residueKey } from './residue.js'

const CIF_COLUMNS = ['auth_seq_id', 'label_seq_id', 'pdbx_pdb_ins_code', 'pdbx_pdb_model_num']

function cifValue(token) {
  if (token === undefined || token === '.' || token === '?') return ''
  return /^[\"']/.test(token) ? token.slice(1, -1) : token
}

// 3Dmol's CIF parser uses the zero-based _atom_site row as atom.serial,
// but omits insertion codes and the deposited model number.
export function cifResidueFields(text) {
  const tokenPattern = /^;[\s\S]*?^;[^\r\n]*|#[^\r\n]*|'[^\r\n]*?'(?=\s|$)|"[^\r\n]*?"(?=\s|$)|\S+/gm
  function next() {
    let token
    do {
      token = tokenPattern.exec(text)?.[0]
    } while (token?.startsWith('#'))
    return token
  }

  let token = next()
  while (token !== undefined) {
    if (token.toLowerCase() !== 'loop_') {
      token = next()
      continue
    }
    const headers = []
    while ((token = next())?.startsWith('_')) headers.push(token.toLowerCase())
    if (!headers.some(header => /^_atom_site[._](?:cartn_x|fract_x)$/.test(header))) continue
    const columns = CIF_COLUMNS.map(name => headers.findIndex(header =>
      header === `_atom_site.${name}` || header === `_atom_site_${name}`))
    const rows = []
    while (token !== undefined && !/^(?:_|loop_$|data_|stop_$|save_)/i.test(token)) {
      const row = []
      for (let column = 0; column < headers.length; column += 1) {
        if (token === undefined) return rows
        const field = columns.indexOf(column)
        if (field !== -1) row[field] = cifValue(token)
        token = next()
      }
      rows.push(row)
    }
    return rows
  }
  return []
}

function residueNumber(value) {
  const number = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value
  return Number.isSafeInteger(number) ? number : null
}

function identityFor(atom, cifFields) {
  const [authNumber, labelNumber, insertionCode, modelNumber] = cifFields ?? []
  const author = residueNumber(cifFields ? authNumber : atom.resi)
  const label = residueNumber(labelNumber)
  return {
    chain: cifValue(atom.chain?.trim()) || cifValue(atom.lchain?.trim()),
    labelChain: cifValue(atom.lchain?.trim()),
    numbering: author !== null || !cifFields ? 'author' : 'label',
    number: author ?? label,
    insertionCode: insertionCode ?? atom.icode?.trim() ?? '',
    name: cifValue(atom.resn?.trim()) || 'UNK',
    modelNumber: residueNumber(modelNumber) > 0 ? residueNumber(modelNumber) : null,
    atomIndex: atom.index,
  }
}

export function indexResidues(atoms, cifRows = []) {
  const groups = new Map()
  for (const atom of atoms) {
    const key = residueKey(identityFor(atom, cifRows[atom.serial]))
    const group = groups.get(key)
    if (group) group.push(atom)
    else groups.set(key, [atom])
  }
  return {
    atomsFor: selection => groups.get(residueKey(selection)) ?? [],
    describe: atom => {
      const identity = identityFor(atom, cifRows[atom.serial])
      return normalizePickedResidue({
        ...identity,
        atomName: atom.atom?.trim() ?? '',
        element: atom.elem?.trim() ?? '',
        atomCount: groups.get(residueKey(identity)).length,
        bFactor: atom.b,
      })
    },
  }
}
