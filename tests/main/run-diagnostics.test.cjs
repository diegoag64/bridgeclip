const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { buildSync } = require('esbuild')
const built = buildSync({ entryPoints: [path.join(__dirname, '../../src/shared/run-diagnostics.ts')], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
const mod = { exports: {} }; new Function('module', 'exports', built)(mod, mod.exports)
const { parseRunDiagnostics } = mod.exports
const row = { stage: 'planning', model: 'example/model', requests: 1, active: 0, failed: 0, input_tokens: 100, output_tokens: 20, cost_usd: .03, elapsed_ms: 2000, unknown_usage: 0, unknown_cost: 0 }
test('diagnostics validate the subprocess boundary and strip private fields', () => {
  assert.deepEqual(parseRunDiagnostics({ models: [{ ...row, prompt: 'private' }], raw_response: 'private' }), { models: [row] })
  for (const change of [{ model: 'https://host?key=secret' }, { input_tokens: Infinity }, { cost_usd: -1 }, { requests: 1.2 }, { active: 2 }, { stage: 'unknown' }, { unknown_cost: 2 }]) assert.equal(parseRunDiagnostics({ models: [{ ...row, ...change }] }), undefined)
  assert.equal(parseRunDiagnostics({ models: [row, row] }), undefined)
  assert.equal(parseRunDiagnostics({ models: Array(65).fill(row) }), undefined)
  assert.equal(parseRunDiagnostics({ models: [], preparation: { candidate: 101 } }), undefined)
})
