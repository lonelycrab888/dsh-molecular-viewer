# Molecular Structure Viewer 0.1.96

Runtime files from the OpenAI Codex Molecular Structure Viewer plugin, version 0.1.96.
The OpenAI-authored runtime is distributed under the accompanying MIT license.
Bundled dependencies are covered by the accompanying third-party notices and
[supplemental license materials](licenses/README.md).
The upstream starter contract is preserved in [starter-examples.json](examples/starter-examples.json)
under the accompanying MIT license. It records the input revisions, SHA-256
digests, and expected results. The [1YCR](https://www.rcsb.org/structure/1YCR),
[4AKE](https://www.rcsb.org/structure/4AKE), [1AKE](https://www.rcsb.org/structure/1AKE),
and [1EMA](https://www.rcsb.org/structure/1EMA) coordinate files are bundled from
RCSB PDB under CC0 1.0.
The DSH adapter lives outside this directory. The build script
`scripts/patch-structure-viewer.mjs` patches `dist/server.mjs` to support
atomic batches of show actions and add provenance to saved exports and renders.
It patches `dist/views/viewer.bundle` to identify DSH and the upstream runtime in
PDB, mmCIF, and BinaryCIF coordinate exports.
