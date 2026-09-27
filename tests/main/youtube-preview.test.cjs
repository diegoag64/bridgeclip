const assert = require('node:assert/strict')
const { test } = require('node:test')
const { buildSync } = require('esbuild')
const path = require('node:path')

const bundle = buildSync({
  entryPoints: [path.resolve(__dirname, '../../src/main/youtube-preview.ts')],
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', external: ['./tools'], write: false
}).outputFiles[0].text
const url = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
function load(fetch = () => { throw new Error('Unexpected fetch') }, extract = () => { throw new Error('Unexpected extraction') }) {
  const module = { exports: {} }
  const mockedRequire = (id) => {
    if (id === './tools') return { resolveBinary: () => '/bundled/yt-dlp' }
    if (id === 'child_process') {
      const execFile = () => {}
      execFile[require('node:util').promisify.custom] = async (_binary, args, options) => ({ stdout: await extract(args, options) })
      return { execFile }
    }
    return require(id)
  }
  new Function('module', 'exports', 'require', 'fetch', bundle)(module, module.exports, mockedRequire, fetch)
  return module.exports
}

test('YouTube preview validates and canonicalizes input before accessing public metadata', async () => {
  const calls = []
  const api = load(async (endpoint, options) => { calls.push({ endpoint, options }); return Response.json({ title: 'A film', author_name: 'Blender' }) })
  for (const input of ['http://localhost/video', 'https://youtube.com.evil.test/watch?v=aqz-KE-bpKQ', 'https://user:pass@youtube.com/watch?v=aqz-KE-bpKQ', 'https://youtube.com:8443/watch?v=aqz-KE-bpKQ', 'https://youtube.com/watch?v=bad', null]) await assert.rejects(api.getYouTubePreview(input), /valid YouTube/)
  await assert.rejects(api.getYouTubePreview(url, 'yes'), /valid YouTube/)
  assert.equal(calls.length, 0)
  const [one, two] = await Promise.all([api.getYouTubePreview('https://youtu.be/aqz-KE-bpKQ?t=30'), api.getYouTubePreview(url)])
  assert.deepEqual(one, two)
  assert.equal(one.channel, 'Blender')
  assert.equal(one.durationSeconds, null)
  await api.getYouTubePreview(url)
  assert.equal(calls.length, 1)
  assert.equal(new URL(calls[0].endpoint).searchParams.get('url'), url)
  assert.equal(calls[0].options.redirect, 'error')
  assert.ok(calls[0].options.signal instanceof AbortSignal)
  assert.deepEqual(calls[0].options.headers, { Accept: 'application/json' })
})

test('optional details use bounded metadata-only extraction and retain real duration, views and date', async () => {
  const calls = []
  const api = load(undefined, (args, options) => {
    calls.push({ args, options })
    return JSON.stringify({ title: 'A film', channel: 'Blender', duration: 634, view_count: 1200000, upload_date: '20260927', is_live: false })
  })
  const [one, two] = await Promise.all([api.getYouTubePreview(url, true), api.getYouTubePreview(url, true)])
  assert.deepEqual(one, { title: 'A film', channel: 'Blender', durationSeconds: 634, viewCount: 1200000, uploadedOn: '2026-09-27' })
  assert.deepEqual(one, two)
  assert.equal(calls.length, 1)
  for (const flag of ['--ignore-config', '--skip-download', '--no-playlist', '--no-cache-dir']) assert.ok(calls[0].args.includes(flag))
  assert.deepEqual(calls[0].args.slice(-2), ['--', url])
  assert.equal(calls[0].options.timeout, 20000)
  assert.equal(calls[0].options.maxBuffer, 65536)
})

test('missing or malformed optional metadata stays absent rather than becoming invented values', () => {
  const { parseYouTubePreview } = load()
  const parsed = parseYouTubePreview({ title: 'Video', channel: null, duration: '100', view_count: -1, upload_date: '20260231' }, true)
  assert.deepEqual(parsed, { title: 'Video', channel: null, durationSeconds: null, viewCount: null, uploadedOn: null })
  assert.equal(parseYouTubePreview({ title: 'Live', duration: 100, is_live: true }, true).durationSeconds, null)
  assert.equal(parseYouTubePreview({ title: 'Video', view_count: 0 }, true).viewCount, 0)
  for (const value of [null, [], {}, { title: 12 }]) assert.throws(() => parseYouTubePreview(value, false))
})

test('failed and oversized metadata requests are safe to retry and never expose provider output', async () => {
  let fail = true
  const api = load(async () => fail ? new Response('private response', { status: 403 }) : Response.json({ title: 'Recovered' }))
  await assert.rejects(api.getYouTubePreview(url), /Could not load YouTube details/)
  fail = false
  assert.equal((await api.getYouTubePreview(url)).title, 'Recovered')
  for (const body of ['not json', 'x'.repeat(65537)]) {
    await assert.rejects(load(async () => new Response(body)).getYouTubePreview(url), /Could not load YouTube details/)
  }
})
