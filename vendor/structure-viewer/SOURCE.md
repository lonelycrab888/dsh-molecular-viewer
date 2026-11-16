# Molecular Structure Viewer 0.1.96

Runtime files from the OpenAI Codex Molecular Structure Viewer plugin, version 0.1.96.
The OpenAI-authored runtime is distributed under the accompanying MIT license.
Bundled dependencies are covered by the accompanying third-party notices and
[supplemental license materials](licenses/README.md).
The bundled 1EMA structure is from RCSB PDB and is distributed under CC0 1.0.
The DSH adapter lives outside this directory. The build script
`scripts/patch-structure-viewer.mjs` patches `dist/server.mjs` to support
atomic batches of show actions and add provenance to saved exports and renders.
It patches `dist/views/viewer.bundle` to identify DSH and the upstream runtime in
PDB, mmCIF, and BinaryCIF coordinate exports.
