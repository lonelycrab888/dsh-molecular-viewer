import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const exampleDirectory = new URL('../vendor/structure-viewer/examples/', import.meta.url)
const contract = JSON.parse(readFileSync(new URL('starter-examples.json', exampleDirectory), 'utf8'))
export const starters = new Map(contract.examples.map(example => [example.id, example]))

export async function prepareStarter(root, starter, signal) {
  const inputs = await Promise.all(starter.sources.map(async source => {
    const bytes = await readFile(new URL(`${source.accession}.pdb`, exampleDirectory), { signal })
    const digest = createHash('sha256').update(bytes).digest('hex')
    const atomCount = bytes.toString('ascii').match(/^(?:ATOM  |HETATM)/gm)?.length ?? 0
    if (digest !== source.sha256 || bytes.length !== source.byteLength || atomCount !== source.atomCount) {
      throw new Error(`Bundled source drift for ${source.accession} (expected PDB revision ${source.revision.date}).`)
    }
    return { name: `${source.accession}.pdb`, bytes }
  }))
  const base = join(root, 'structure-viewer-examples')
  await mkdir(base, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  if (!(await lstat(base)).isDirectory() || await realpath(base) !== base) {
    throw new Error('The examples directory must be inside the local workspace.')
  }
  const directory = await mkdtemp(join(base, `${starter.id}-`))
  try {
    for (const input of inputs) {
      await writeFile(join(directory, input.name), input.bytes, { flag: 'wx', mode: 0o600, signal })
    }
    if (starter.id === 'gfp-publication-image') await mkdir(join(directory, 'structure-viewer'), { mode: 0o700 })
    return { directory, path: join(directory, inputs[0].name) }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

function bind(value, bindings) {
  if (typeof value === 'string' && value.startsWith('$')) {
    if (Object.hasOwn(bindings, value)) return bindings[value]
    if (value.startsWith('$WORKSPACE/')) return join(bindings.$WORKSPACE, value.slice(11))
    throw new Error(`Missing starter result binding ${value}.`)
  }
  if (Array.isArray(value)) return value.map(item => bind(item, bindings))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bind(item, bindings)]))
  }
  return value
}

export async function runStarter(starter, { workspace, sessionId, engine, signal, progress }) {
  const bindings = { $WORKSPACE: workspace, $VIEWER_SESSION_ID: sessionId }
  const completed = []
  for (const step of starter.orderedToolSequence.slice(1)) {
    signal?.throwIfAborted()
    await progress(step)
    const result = await engine.call(step.tool, bind(step.request, bindings), signal)
    const summary = result.content?.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? ''
    const data = result.structuredContent
    if (result.isError || data?.applied === false || (step.tool === 'structure.render_image' && data?.status !== 'completed')) {
      throw new Error(summary || `Starter failed in ${step.tool}.`)
    }
    for (const [field, name] of Object.entries(step.resultBindings ?? {})) {
      const resolved = field.split('.').reduce((record, key) => record?.[key], result)
      if (resolved !== undefined) bindings[name] = resolved
    }
    if (step.tool === 'structure.analyze' || step.tool === 'structure.align_structures' || step.tool === 'structure.render_image') {
      const state = data?.state
      completed.push({
        tool: step.tool, summary,
        data: state?.analysis ?? state?.alignment ?? data?.result ?? {},
      })
    }
  }
  return completed
}
