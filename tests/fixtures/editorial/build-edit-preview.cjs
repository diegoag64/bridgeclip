// Deterministic browser fixture for the actual transcript dialog. No inference.
const { build } = require('esbuild')
const fs = require('node:fs')
const path = require('node:path')
const destination = path.resolve(process.argv[2] || '/tmp/bridgeclip-edit-preview')
fs.mkdirSync(destination, { recursive: true })
fs.cpSync(path.resolve(__dirname, '../../../src/renderer/assets/fonts'), path.join(destination, 'assets/fonts'), { recursive: true })
const audit = require('./edit-audit.json')
build({ stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client';
  import { EditInspector } from './src/renderer/components/EditInspector';
  import { parseEditAudit } from './src/shared/editorial';
  const audit = parseEditAudit(${JSON.stringify(audit)});
  window.bridgeclip = { edits: { inspect: async () => audit } };
  function Fixture() { const [open, setOpen] = React.useState(true); return <div className="p-8"><button onClick={() => setOpen(true)}>Open saved edit trace</button>{open && <EditInspector outputDir="/fixture" onClose={() => setOpen(false)} />}</div> }
  createRoot(document.getElementById('root')).render(<Fixture />);`, loader: 'tsx', resolveDir: path.resolve(__dirname, '../../..') },
  bundle: true, jsx: 'automatic', outfile: path.join(destination, 'app.js'), define: { 'process.env.NODE_ENV': '"development"' }
}).catch(error => { console.error(error); process.exitCode = 1 })
fs.writeFileSync(path.join(destination, 'index.html'), '<!doctype html><html class="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Transcript and edit fixture</title><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>')
