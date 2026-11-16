# Molecular Structure Viewer

Open, inspect, compare, and analyze molecular structures from a DeepSeek Harness conversation, right sidebar, or workspace-file preview. The workbench uses the Mol* runtime from Codex Molecular Structure Viewer 0.1.96. WebGL rendering runs in the local browser. The DSH Host brokers workspace-file access and saves published artifacts.

## Inline 3D viewer

Ask the agent to open a PDB or mmCIF file in the molecular workbench, or click a recognized structure in the workspace file browser. The workbench also accepts RCSB PDB IDs, public HTTPS structure files, inline PDB/mmCIF text, and a bundled GFP example.

- Pick atoms, residues, chains, or sequences, create named selections, and inspect their exact identities. Turn on **Closest heavy-atom distance** and click two residues in the same loaded structure to measure their nearest non-hydrogen atoms. The agent can read the result when asked about the user's last measurement. The Measurements inspector provides atom-based distance, angle, and dihedral measurements and geometry guides.
- Load and align named objects, operate on assemblies and models, derive structures, and query atoms and residues. Inspect contacts, clashes, hydrogen bonds, RMSD, SASA, buried area, density, trajectories, validation and quality annotations, assembly symmetry, and public motif matches.
- Edit representations, lighting, clipping, camera, ribbons, annotations, and animation. Use scene snapshots, undo and redo, and source-checked project save and restore. Export images, MP4, scenes, selected coordinates, split-model archives, visible geometry, and analysis CSV with provenance.

## Agent tools

| `molecular_workbench` action | Behavior |
| --- | --- |
| `open` | Open a workspace file or imported source, or use `exampleId: "gfp-1ema"`. Set `placement: "sidebar"` to open in the DSH sidebar. |
| `context` | Read the active selection, annotations, measurements, and analysis summaries. |
| `status` / `viewers` | Read renderer and recovery status or list the current conversation's workbenches. |
| `operations` / `help` | Find an operation and read its exact input schema. |
| `run` | Run a typed `structure.*` operation. Use `structure.get_state` to obtain the current scene revision before revision-guarded changes. |

To inspect a live scene, call `molecular_workbench` with `{"action":"run","operation":"structure.get_state"}`. Passing the operation name as `action`, or passing only `operation`, also works. Use `operations` or `help` before opening a viewer to look up available operations.

Compare structures by opening one viewer, then running `structure.add_structure` and `structure.align_structures` in that same viewer. Pass `viewerId` when targeting a particular card. The original `molecular_viewer` tool still supports existing lightweight 3Dmol scenes and scripts.

For `structure.molecular_action`, use a single typed action or an array of 1 to
32 `show` actions in `arguments.action`. A batch adds all requested
representations as one undoable change. If any target is invalid, the whole
batch fails. Omit `arguments.expectedRevision` to use the live scene revision,
or pass a revision to reject changes made since your read.

## Data and recovery

The Host confines workbench file operations to the current DSH workspace. Use a writable workspace to import an accession, HTTPS download, or inline coordinates. The imported copy is recorded in `.dsh-molecular-sources/` so the scene can reopen. Local files can be opened in read-only conversations. Exports are separate workspace files. Source files remain intact. Saved export and render sidecars identify DSH Molecular Viewer and the upstream OpenAI Codex Molecular Structure Viewer 0.1.96 runtime. Coordinate exports also carry the attribution in their own metadata.

The workbench keeps private recovery checkpoints in the local DSH cache. Reopening a card validates the source and dependencies. Save a structure project for long-term, portable recovery. Public density and annotations require their associated sources. Video encoding and performance depend on the browser and local hardware.

## Install

Install into the Web profile of DSH 0.2.2-rc.3 and reload the DSH interface.

```sh
dsh plugin --profile web add /path/to/dsh-molecular-viewer-0.2.2.tgz
```

## Development and licensing

Run `npm ci`, `npm run check`, and `npm run build` to build the Host and browser bundles. The Mol* runtime is pinned under [vendor/structure-viewer](vendor/structure-viewer/SOURCE.md), with its accompanying MIT license and third-party notices. The [supplemental notices](vendor/structure-viewer/licenses/README.md) include instructions for obtaining the Mediabunny 1.44.2 source code and the full react-remove-scroll-bar MIT notice. For the lightweight viewer's 3Dmol.js dependency, see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
