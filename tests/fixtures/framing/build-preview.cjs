// Build a temporary, deterministic browser fixture for manual visual checks.
// Run from the repo root: node tests/fixtures/framing/build-preview.cjs /tmp/framing-preview
const { build } = require('esbuild')
const fs = require('node:fs')
const path = require('node:path')
const destination = path.resolve(process.argv[2] || '/tmp/bridgeclip-framing-preview')
fs.mkdirSync(destination, { recursive: true })
fs.cpSync(path.resolve(__dirname, '../../../src/renderer/assets/fonts'), path.join(destination, 'assets/fonts'), { recursive: true })
const trace = JSON.parse(fs.readFileSync(process.argv[3] || path.join(__dirname, 'trace.json'), 'utf8'))
async function main() {
await build({
  stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client';
    import { FramingInspector } from './src/renderer/components/FramingInspector';
    import { EditorialWeights } from './src/renderer/components/EditorialReview';
    import { defaultWeights } from './src/shared/editorial';
    const trace = ${JSON.stringify(trace)};
    let mode = 'available';
    window.api = { framing: { inspect: async () => mode === 'legacy' ? { status: 'unavailable', trace: null, sourcePath: null, clipPath: '/clip.mp4', message: 'No framing trace was recorded. Generate again with capture enabled.' } : { status: mode, trace, sourcePath: mode === 'limited' ? null : '/source.mp4', clipPath: '/clip.mp4', message: mode === 'limited' ? 'Source preview missing; recorded decisions remain available.' : null } } };
    // Use the actual component and local-file URL builder, with a fixture-only URL shim.
    window.bridgeclip = window.api;
    function Fixture() {
      const [open, setOpen] = React.useState(false);
      const [weights, setWeights] = React.useState(defaultWeights);
      return <div className="p-8 space-x-4"><span>Deterministic framing fixture</span>{trace.editorial && <EditorialWeights value={weights} onChange={setWeights} />}{['available','limited','legacy'].map(m => <button key={m} onClick={() => {mode=m;setOpen(true)}}>{m}</button>)}{open && <FramingInspector outputDir="/fixture" clip={{clip_index:0}} onClose={() => setOpen(false)} />}</div>
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);`, loader: 'tsx', resolveDir: path.resolve(__dirname, '../../..') },
  bundle: true, jsx: 'automatic', outfile: path.join(destination, 'app.js'), define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{ name: 'fixture-media-url', setup(build) { build.onLoad({ filter: /renderer\/lib\/utils\.ts$/ }, args => ({ contents: fs.readFileSync(args.path,'utf8').replace(/export function localFileUrl[\s\S]*?\n}/, 'export function localFileUrl(path: string): string { return path }'), loader: 'ts' })) } }]
})
fs.writeFileSync(path.join(destination, 'index.html'), '<!doctype html><html class="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Framing inspector fixture</title><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>')
console.log(destination)

}
main().catch(error => { console.error(error); process.exitCode = 1 })
