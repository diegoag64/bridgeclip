const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { buildSync } = require('esbuild')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

function load(entry) {
  const code = buildSync({ entryPoints: [path.resolve(__dirname, '../../', entry)], bundle: true, jsx: 'automatic',
    platform: 'node', format: 'cjs', packages: 'external', write: false }).outputFiles[0].text
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', code)(mod, mod.exports, require)
  return mod.exports
}
const { inspectJsonValue, inspectJsonText } = load('src/renderer/lib/inspect-json.ts')
const { JsonViewer } = load('src/renderer/components/ui/JsonViewer.tsx')

test('saved structured responses unwrap fences and repeated encoding without coercing prose', () => {
  const expected = { clips: [1, 2], enabled: true, empty: null }
  const json = JSON.stringify(expected)
  for (const value of [json, `\n\`\`\`json\n${json}\n\`\`\`\n`, `\`\`\`\r\n${json}\r\n\`\`\``, JSON.stringify(json), JSON.stringify(JSON.stringify(json))]) {
    assert.deepEqual(inspectJsonValue(value), { value: expected, encoded: true })
  }
  for (const value of ['A regular description', 'null', 'true', '42', '"A quoted sentence"', '{"clips": [', '{bad}', '```js\nalert(1)\n```']) {
    assert.deepEqual(inspectJsonValue(value), { value, encoded: false })
  }
  assert.deepEqual(inspectJsonValue(expected), { value: expected, encoded: false })
})

test('planner messages expose embedded JSON while preserving surrounding transcript and escaped delimiters', () => {
  const context = { title: 'A [reaction] to {braces}', quote: 'He said "yes". \\ End.' }
  const text = 'PRE-TRANSCRIPTION SOURCE CONTEXT (background, not evidence):\n' + JSON.stringify(context) +
    '\nTranscript: [0:01] words remain as written.\nOther data: [1,2]\nAn incomplete response: {"clips": ['
  const parts = inspectJsonText(text)
  assert.deepEqual(parts.filter(p => p.kind === 'json').map(p => p.value), [context, [1, 2]])
  assert.equal(parts.map(p => p.text).join(''), text)
  assert.match(parts.at(-1).text, /An incomplete response/)
  const plain = 'Use {video_title} as a hint, not evidence. [No data]'
  assert.deepEqual(inspectJsonText(plain), [{ kind: 'text', text: plain }])
})

test('large diagnostic messages are bounded without losing the remaining original text', () => {
  const text = Array.from({ length: 100 }, (_, i) => `Context ${i}: {"id":${i}}`).join('\n')
  const parts = inspectJsonText(text)
  assert.equal(parts.filter(p => p.kind === 'json').length, 30)
  assert.equal(parts.map(p => p.text).join(''), text)
  assert.match(parts.at(-1).text, /Context 99/)
  let encoded = '{"ok":true}'
  for (let i = 0; i < 10; i++) encoded = JSON.stringify(encoded)
  assert.deepEqual(inspectJsonValue(encoded), { value: encoded, encoded: false })
})

test('formatted diagnostics escape HTML and keep saved content unchanged', () => {
  const saved = { payload: 'Context:\n{"markup":"<img src=x onerror=alert(1)>"}\nEnd.', literal: '<script>alert(1)</script>' }
  const original = JSON.stringify(saved)
  const html = renderToStaticMarkup(React.createElement(JsonViewer, { value: saved }))
  assert.doesNotMatch(html, /<script>|<img/)
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /Collapse JSON/)
  assert.match(html, /End\./)
  assert.equal(JSON.stringify(saved), original)
})
