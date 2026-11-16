export const WORKBENCH_TOOL = 'molecular_workbench'
export const WORKBENCH_ROUTE = '/dsh-molecular-viewer/workbench'
export const WORKBENCH_TAB = 'dsh-molecular-workbench'
export const WORKBENCH_PREVIEW = 'dsh-molecular-viewer/molstar'

export const STRUCTURE_EXTENSIONS = [
  'pdb', 'cif', 'mmcif', 'mol', 'sdf', 'mol2', 'pqr', 'pdbqt', 'gro', 'xyz',
  'pdb.gz', 'cif.gz', 'mmcif.gz', 'pdb.bgz', 'cif.bgz', 'mmcif.bgz', 'pdb.bgzf', 'cif.bgzf', 'mmcif.bgzf',
]

export const BINARY_STRUCTURE_EXTENSIONS = STRUCTURE_EXTENSIONS.filter(extension => extension.includes('.'))

export function workbenchId(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
}
