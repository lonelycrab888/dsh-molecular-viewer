export const workbenchGuidance = [
  'Use molecular_workbench for the live DSH structure. Use an explicit viewerId from a user selection handoff or open result. A handoff describes what the user selected at capture time, even if the live selection or active viewer has since changed. If a fresh read is needed, target that viewerId and check the relevant revision. If multiple structures plausibly match, ask which one.',
  'After open, if viewerReady is false, call wait once with its viewerId. If it is still pending, ask the user to show that workbench. Use context with relevant sections for orientation, structure.query for exact atom/residue/chain/object identities, and structure.analyze for computed results. Call help for the exact operation schema. Use guide for worked workflows.',
  'For residue solvent exposure, analyze kind sasa with selections[0] spanning the complete occluding molecular context and selections[1] limited to the requested protein residues. Use options.sasaAggregation=residue. Report absolute SASA in Å², or relative exposure in percent using tien_2013_maximum with a 1.4 Å probe. Keep surrounding atoms in the first selection even for a single-chain question. Check the current SASA budget before claiming a result.',
  'For complete results, continue query and analysis cursors on the same viewer and revision. Report truncation explicitly. Read get_state before edits, pass its sceneRevision as expectedRevision, and advance to the returned appliedRevision. If a revision conflicts or a mutation times out after dispatch, read current state and reconcile before resubmitting.',
].join('\n')

const guides = {
  selection: {
    title: 'Select and inspect exact targets',
    steps: [
      'Use action context with sections such as overview, selection, inventory, annotations, or results for current orientation. A compact response may omit or truncate data.',
      'Use structure.query with expression, level, and the current sceneRevision to enumerate exact identities. Preserve object ID, assembly instance, author chain and residue number, insertion code, and alternate location where relevant. Use typed residue_range, allOf, within, or exact atom_ids instead of ambiguous labels.',
      'For a question sent from a preview, read its attached selection and revisions first. Use that viewerId for any live call. Exact atom_ids in the attachment describe the captured atoms. Treat a changed revision as a new live observation and distinguish it from the original question.',
    ],
  },
  analysis: {
    title: 'Choose a scientific operation',
    steps: [
      'Use structure.measure for distance, angle or dihedral overlays, structure.control_viewer with measure_residue_distance for the closest heavy-atom pair between two residues, and structure.analyze for contacts, clashes, hydrogen bonds, SASA, buried area or RMSD.',
      'Scope interaction partners by object, chain, residue and instance. For buried area the two selections must be atom-disjoint. Keep the two-partner SASA loss and the one-sided interface area distinct. For hydrogen bonds preserve donor/acceptor identities and the returned distance, geometry, assumptions and provenance.',
      'For conformer comparison, add structures into the same viewer with distinct object IDs, list them, then align matching selections. Report the alignment method, matched count and RMSD with the reported scores. Use topic sasa for residue exposure.',
    ],
  },
  sasa: {
    title: 'Measure residue solvent exposure with the full occluding structure',
    steps: [
      'Use residue aggregation. The first selection supplies all occluding atoms in the relevant molecular object or assembly. The second selection reports residues of interest only. Intersect the requested chain with the protein component to exclude waters and other nonprotein output rows while keeping surrounding atoms in the occluder selection.',
      'Use minAreaSquareAngstrom for an absolute threshold and report areaSquareAngstrom in Å². Use minRelativeExposurePercent and relativeSasaReference=tien_2013_maximum for percent exposure with probeRadiusAngstrom=1.4. Both thresholds are strictly greater than the requested value. Relative results can be null for unsupported residue types.',
      'Verify object and chain IDs, the scene revision and scene capabilities.budgets.sasaAtoms before adapting this example. If the full context exceeds the budget, report the limit. A reduced occluder context measures a different structure. Retain probe, samples, selection scope, normalization and result completeness when reporting.',
    ],
    example: {
      action: 'run',
      operation: 'structure.analyze',
      arguments: {
        kind: 'sasa',
        selections: [
          { kind: 'all', objectId: 'primary' },
          { kind: 'allOf', expressions: [
            { kind: 'chain', objectId: 'primary', chain: 'A' },
            { kind: 'component', objectId: 'primary', component: 'protein' },
          ] },
        ],
        options: { sasaAggregation: 'residue', probeRadiusAngstrom: 1.4, sasaSamples: 240 },
      },
    },
  },
  paging: {
    title: 'Finish paginated and revision-bound reads',
    steps: [
      'For query and retained analysis results pass the returned nextCursor to the same operation on the same viewer. Retain the same query expression and level, or analysis kind and scope, and the bound revision. Stop when nextCursor is absent or null. If the cursor expires or the revision conflicts, restart from a fresh scoped read.',
      'For long text, list_documents then read_document using nextOffset and the document expectedRevision through eof. For source bytes use read_source with nextOffsetDecimal and its source revision through eof. Scene, document and source revisions are different types of identity.',
      'Check resultCount, truncation and retainedRowCount where available. If results remain incomplete or expired, report the observed coverage instead of inferring the rest.',
    ],
  },
  revisions: {
    title: 'Apply scene edits safely',
    steps: [
      'Read structure.get_state and use data.state.sceneRevision as arguments.expectedRevision on revision-guarded operations. Advance to data.state.appliedRevision after success. Validate exact object and residue IDs before editing.',
      'Use structure.apply_scene for coordinated styling or camera changes. Use dryRun where supported when targets are uncertain. If a revision conflicts, read state again and decide if the original edit still applies.',
      'After an acknowledged failure or an unknown outcome, check the current scene or job receipt before retrying. In particular, do not repeat a potentially committed mutation or publication blindly.',
    ],
  },
}

export const guideTopics = Object.keys(guides)

export function workbenchGuide(topic) {
  if (topic !== undefined && !Object.hasOwn(guides, topic)) {
    throw new Error(`Choose a workbench guide topic from ${guideTopics.join(', ')}.`)
  }
  const entry = guides[topic]
  return entry ? { topic, ...structuredClone(entry) }
    : { topics: guideTopics.map(key => ({ topic: key, title: guides[key].title })) }
}
