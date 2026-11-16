import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import './patch-structure-viewer.mjs'

const bundles = await Promise.all([
  build({
    entryPoints: ['src/index.js'],
    outfile: 'lib/index.js',
    bundle: true,
    packages: 'external',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    legalComments: 'none',
    write: false,
  }),
  build({
    entryPoints: ['src/client.jsx'],
    outfile: 'lib/client.cjs',
    bundle: true,
    external: ['react', 'react/jsx-runtime', 'react-dom'],
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    minify: true,
    legalComments: 'none',
    write: false,
    banner: {
      js: 'window.__ModuleLoader__.load({id:"dsh-molecular-viewer",factory:(require)=>{var module={exports:{}};var exports=module.exports;',
    },
    footer: { js: 'return module.exports;}});' },
  }),
])

await mkdir('lib', { recursive: true })
await Promise.all(bundles.flatMap(bundle => bundle.outputFiles.map(file => writeFile(file.path, file.contents))))
console.log('Built lib/index.js and lib/client.cjs')
