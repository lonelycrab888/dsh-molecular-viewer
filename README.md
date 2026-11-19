# Molecular Structure Viewer

[简体中文](README.zh.md)

Open, inspect, compare, and analyze molecular structures from a DeepSeek Harness conversation, right sidebar, or workspace-file preview. The workbench uses the Mol* runtime from Codex Molecular Structure Viewer 0.1.96. WebGL rendering runs in the local browser. The DSH Host brokers workspace-file access and saves published artifacts.

## Inline 3D viewer

Ask the agent to open a PDB or mmCIF file in the molecular workbench, or click a recognized structure in the workspace file browser. The workbench also accepts RCSB PDB IDs, public HTTPS structure files, inline PDB/mmCIF text, and three bundled starter workflows.

- Pick atoms, residues, chains, or sequences, create named selections, and inspect their exact identities. Turn on **Closest heavy-atom distance** and click two residues in the same loaded structure to measure their nearest non-hydrogen atoms. The agent can read the result when asked about the user's last measurement. The Measurements inspector provides atom-based distance, angle, and dihedral measurements and geometry guides.
- Use **Ask about this preview selection** in a file preview or **Ask about selection** on a chat workbench. The form shows the captured file and selection. The question carries the originating viewer ID, scene and geometry revisions, and the selection captured when the form opened.
- Use **Open viewer** to move the workbench into the DSH right sidebar and **Return to chat** to restore it inline. The workbench keeps its ID and restores the saved scene after the renderer mounts. The toolbar shows when rendering is ready.
- Load and align named objects, operate on assemblies and models, derive structures, and query atoms and residues. Inspect contacts, clashes, hydrogen bonds, RMSD, SASA, buried area, density, trajectories, validation and quality annotations, assembly symmetry, and public motif matches.
- Edit representations, lighting, clipping, camera, ribbons, annotations, and animation. Use scene snapshots, undo and redo, and source-checked project save and restore. Export images, MP4, scenes, selected coordinates, split-model archives, visible geometry, and analysis CSV with provenance.

## Agent tools

| `molecular_workbench` action | Behavior |
| --- | --- |
| `open` | Open a workspace file, imported source, or bundled `exampleId`. Set `placement: "sidebar"` for a new sidebar workbench. |
| `examples` | List the three packaged starter workflows, IDs, and prompts. |
| `context` | Read the active selection, annotations, measurements, and analysis summaries. |
| `status` / `viewers` | Read renderer and recovery status or list the current conversation's workbenches. |
| `guide` | Read guidance on operation choice, exact selections, residue SASA, pagination, and scene revisions. For a worked example use `{"action":"guide","topic":"sasa"}`. |
| `wait` | Wait for the existing viewer to mount and render. Defaults to 8 seconds, with a 15-second maximum. |
| `operations` / `help` | Find an operation and read its exact input schema. |
| `run` | Run a typed `structure.*` operation. Use `structure.get_state` to obtain the current scene revision before revision-guarded changes. |

To inspect a live scene, call `molecular_workbench` with `{"action":"run","operation":"structure.get_state"}`. Passing the operation name as `action`, or passing only `operation`, also works. Use `operations`, `help`, or `guide` before opening a viewer. For residue SASA, use the complete molecular environment as the first selection and the residues to report as the second selection.

Opening the same unchanged source in the same DSH conversation and workspace reuses the existing viewer ID across turns. Pass a stable `openIntentId` UUID when retrying a request. Use `reopen: true` with a fresh `openIntentId` to create a separate workbench deliberately. Repeat that UUID to retry the same creation.

The DSH card appears as soon as the opening tool returns, including for calls made from `run_code`. `open` reports session creation and rendering readiness separately. If `viewerReady` is false, call `wait` with the returned `viewerId` and continue once it reports true. If the viewer still needs a visible DSH surface, show the existing card or sidebar and use the same ID. A scene command sent before readiness returns a lifecycle code without entering the renderer queue. `status` reports `surfaceState`, `mountState`, and `renderState` without sending a scene command.

Compare structures by opening one viewer, then running `structure.add_structure` and `structure.align_structures` in that same viewer. Pass `viewerId` when targeting a particular card.

For `structure.molecular_action`, use a single typed action or an array of 1 to
32 `show` actions in `arguments.action`. A batch adds all requested
representations as one undoable change. If any target is invalid, the whole
batch fails. Omit `arguments.expectedRevision` to use the live scene revision,
or pass a revision to reject changes made since your read.

## Starter examples

In a writable DSH conversation, select **Starter examples** in the workbench toolbar or ask the agent to open a starter by its ID. The example uses pinned PDB files from the package and runs after the workbench renders.

| Example ID | Result |
| --- | --- |
| `mdm2-p53-interface` | 1YCR chain interface, contact count, buried surface area, and styled interface. |
| `adenylate-kinase-open-closed` | 4AKE and 1AKE alignment with matched residue count, RMSD, TM-scores, and the superposed structures. |
| `gfp-publication-image` | Annotated 1EMA GFP chromophore, 1600 × 1200 PNG and a render provenance sidecar. |

Inputs and any exported files are in the workspace under `structure-viewer-examples/`. The `gfp-1ema` ID opens the basic GFP structure.

## Data and recovery

The Host confines workbench file operations to the current DSH workspace. Use **Import structures** beside the DSH composer to select local structure files from another folder. It copies the selected files into the workspace and shows their relative paths for `open` and `structure.add_structure`. Each input can be up to 40 MiB. Use a writable workspace to import an accession, HTTPS download, or inline coordinates. The imported copy is recorded in `.dsh-molecular-sources/` so the scene can reopen. Local files can be opened in read-only conversations. Exports are separate workspace files. Source files remain intact. Saved export and render sidecars identify DSH Molecular Viewer and the upstream OpenAI Codex Molecular Structure Viewer 0.1.96 runtime. Coordinate exports also carry the attribution in their own metadata.

The workbench keeps private recovery checkpoints in the local DSH cache. Reopening a card validates the source and dependencies. Save a structure project for long-term, portable recovery. Public density and annotations require their associated sources. Video encoding and performance depend on the browser and local hardware.

## Install

Install plugin **v0.2.4** on **DSH v0.2.2-rc.5**. This is the host version declared in the package manifest. The workbench uses DSH's shared connection for commands, viewer resources, and structure uploads in both Desktop and Web. The embedded renderer runs in a sandboxed frame.

Replace `/path/to/` in the commands below with the directory containing the v0.2.4 installation archive. For Desktop, open the updated DSH application once to initialize its profile, then fully quit it before installing.

```sh
dsh plugin --profile desktop add /path/to/dsh-molecular-viewer-0.2.4.tgz
```

Restart Desktop after installation. For the Web interface, install into its own profile.

```sh
dsh plugin --profile web add /path/to/dsh-molecular-viewer-0.2.4.tgz
```

To check the installation, open the `gfp-1ema` starter in a conversation and wait for the 3D structure to render. Move it to the sidebar with **Open viewer**, then select **Return to chat** to check that the scene restores inline. In a writable workspace, **Import structures** can verify local file uploads.

## Development and licensing

Run `npm ci`, `npm run check`, and `npm run build` to build the Host and browser bundles. The Mol* runtime is pinned under [vendor/structure-viewer](vendor/structure-viewer/SOURCE.md), with its accompanying MIT license and third-party notices. The [supplemental notices](vendor/structure-viewer/licenses/README.md) include instructions for obtaining the Mediabunny 1.44.2 source code and the full react-remove-scroll-bar MIT notice.
