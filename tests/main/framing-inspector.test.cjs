const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { buildSync } = require('esbuild')
const fixture = require('../fixtures/framing/trace.json')
function load(entry, mocks = {}) {
  const code = buildSync({ entryPoints: [path.resolve(__dirname, '../../', entry)], bundle: true, jsx: 'automatic', platform: 'node', format: 'cjs', packages: 'external', write: false }).outputFiles[0].text
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', code)(mod, mod.exports, (id) => mocks[id] ?? require(id))
  return mod.exports
}
const { parseFramingTrace, sourceToOutput, outputToSource, cropViews } = load('src/shared/framing-trace.ts')
const inspectionModule = () => load('src/main/framing-inspector.ts', { electron: { app: { isPackaged: false } } })
const clone = () => structuredClone(fixture)

test('Python trace maps padded source, removed intervals, output and crop geometry', () => {
  const trace = parseFramingTrace(fixture)
  assert.equal(sourceToOutput(trace, 2000), 0)
  assert.equal(sourceToOutput(trace, 7000), null)
  assert.equal(sourceToOutput(trace, 8499), null)
  assert.equal(sourceToOutput(trace, 8500), 5000)
  assert.equal(outputToSource(trace, 5000), 8500)
  assert.equal(sourceToOutput(trace, 14000), null)
  assert.equal(sourceToOutput(trace, 1999), null)
  for (let t = 0; t < trace.output.duration_ms; t += 33.333) assert.ok(Math.abs(sourceToOutput(trace, outputToSource(trace, t)) - t) < .001)
  const head = trace.rendered_plan[1]
  const views = cropViews(head, 4500)
  assert.ok(Math.abs(views[0][0] - head.views[0].source[0]) < .11)
  const moving = { ...head, crop_path: [[4000, 100, 0], [6000, 200, 0]] }
  assert.equal(cropViews(moving, 5000)[0][0], 150)
  assert.equal(cropViews(moving, 8000)[0][0], 200)
})

test('schema rejects unsupported, non-finite, oversized and inconsistent trace facts', () => {
  for (const edit of [
    t => { t.version = 2 }, t => { t.source.width = Infinity }, t => { t.samples[0].faces[0].score = 2 },
    t => { t.samples[0].faces[0].box = [0, 0, 2, 1] }, t => { t.samples = Array(14402).fill(t.samples[0]) },
    t => { t.samples[1].t_ms = 0 }, t => { t.rendered_plan[1].start_ms++ },
    t => { t.video_pieces[0].output_end_ms++ }, t => { t.decisions[0].tracks[0].samples[0][1] = 31 },
    t => { t.decisions[0].vision.t_ms = 11000 }, t => { t.keeps[0][1] = 999999 },
    t => { t.rendered_plan[0].views[0].source[2] = 32768 }
  ]) { const trace = clone(); edit(trace); assert.throws(() => parseFramingTrace(trace)) }
  const trace = clone()
  trace.raw_provider_response = 'secret'; trace.config.api_key = 'secret'
  trace.decisions[0].vision.reasoning = 'secret'
  assert.ok(!JSON.stringify(parseFramingTrace(trace)).includes('secret'))
})

function library() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'framing-inspect-'))
  const run = path.join(root, 'run')
  fs.mkdirSync(run)
  const clip = path.join(run, 'clip_00.mp4')
  fs.writeFileSync(clip, 'fixture')
  fs.writeFileSync(path.join(run, 'framing-source.mp4'), 'fixture')
  fs.writeFileSync(path.join(run, 'clip_00.framing.json'), JSON.stringify(fixture))
  fs.writeFileSync(path.join(run, 'job_output.json'), JSON.stringify({ job_id: 'run', status: 'completed', source_video_url: 'local.mp4', source_video_title: 'Fixture', source_duration_ms: 16000, total_clips: 1,
    clips: [{ clip_index: 0, s3_url: clip, duration_ms: 10500, start_time_ms: 2300, end_time_ms: 13500, virality_score: .8 }], processing_time_seconds: 1 }))
  return { root, run }
}

test('saved inspection works after module reload; missing preview and legacy clips are explicit', async () => {
  const { root, run } = library()
  try {
    const first = await inspectionModule().inspectFraming(run, 0, root)
    assert.equal(first.status, 'available')
    assert.equal(first.trace.version, 1)
    assert.deepEqual(await inspectionModule().inspectFraming(run, 0, root), first)
    fs.unlinkSync(path.join(run, 'framing-source.mp4'))
    const limited = await inspectionModule().inspectFraming(run, 0, root)
    assert.equal(limited.status, 'limited'); assert.equal(limited.sourcePath, null); assert.ok(limited.trace)
    fs.unlinkSync(path.join(run, 'clip_00.framing.json'))
    const legacy = await inspectionModule().inspectFraming(run, 0, root)
    assert.equal(legacy.status, 'unavailable'); assert.equal(legacy.trace, null)
    assert.match(legacy.message, /does not rerun analysis/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('inspection rejects path escapes, symlink traces, mismatched clips and malformed JSON', async () => {
  const { root, run } = library()
  const { inspectFraming } = inspectionModule()
  try {
    await assert.rejects(inspectFraming('/private/tmp', 0, root))
    await assert.rejects(inspectFraming(run, '../clip', root))
    await assert.rejects(inspectFraming(run, 1, root))
    const tracePath = path.join(run, 'clip_00.framing.json')
    for (const text of ['invalid', JSON.stringify({ ...fixture, clip_index: 1 })]) {
      fs.writeFileSync(tracePath, text)
      assert.equal((await inspectFraming(run, 0, root)).status, 'unavailable')
    }
    fs.unlinkSync(tracePath)
    const external = path.join(root, 'external.json')
    fs.writeFileSync(external, JSON.stringify(fixture)); fs.symlinkSync(external, tracePath)
    assert.equal((await inspectFraming(run, 0, root)).status, 'unavailable')
    fs.unlinkSync(tracePath); fs.writeFileSync(tracePath, JSON.stringify(fixture))
    fs.unlinkSync(path.join(run, 'framing-source.mp4'))
    fs.writeFileSync(path.join(root, 'outside.mp4'), 'outside')
    fs.symlinkSync(path.join(root, 'outside.mp4'), path.join(run, 'framing-source.mp4'))
    assert.equal((await inspectFraming(run, 0, root)).sourcePath, null)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})


test('sample labels never invent detections between observations or across missing samples', () => {
  const { heldSample, RecordedFramingView } = load('src/renderer/components/FramingInspector.tsx')
  const trace = parseFramingTrace(fixture)
  assert.equal(heldSample(trace, 249).t_ms, 0)
  assert.equal(heldSample(trace, 250).t_ms, 250)
  assert.equal(heldSample(trace, -1), null)
  assert.equal(heldSample(trace, 12001), null)
  assert.deepEqual(heldSample(trace, 6250).faces, [])
  const withGap = { ...trace, samples: trace.samples.filter(s => s.t_ms !== 250) }
  assert.equal(heldSample(withGap, 400), null)
  const React = require('react')
  const { renderToStaticMarkup } = require('react-dom/server')
  const html = renderToStaticMarkup(React.createElement(RecordedFramingView, {
    inspection: { status: 'limited', trace, sourcePath: null, clipPath: null, message: 'Missing preview' }
  }))
  assert.match(html, /4 fps sampling/)
  assert.match(html, /Missing preview/)
  assert.match(html, /disabled/)
  assert.match(html, /Source preview unavailable/)
})

test('inset geometry and local padding decisions cross IPC with bounded legacy-compatible fields', () => {
  const raw = clone()
  raw.rendered_plan[0].content_box = [.3, .05, .4, .9]
  raw.samples[0].content_box = [.3, .05, .4, .9]
  raw.decisions[0].vision = { status: 'content_region' }
  raw.boundaries.push({ t_ms: 1250, kind: 'content', accepted: true })
  const trace = parseFramingTrace(raw)
  assert.deepEqual(trace.rendered_plan[0].content_box, [.3, .05, .4, .9])
  assert.deepEqual(trace.samples[0].content_box, [.3, .05, .4, .9])
  assert.equal(trace.decisions[0].vision.status, 'content_region')
  assert.equal(trace.boundaries.at(-1).kind, 'content')
  const { RecordedFramingView } = load('src/renderer/components/FramingInspector.tsx')
  const html = require('react-dom/server').renderToStaticMarkup(require('react').createElement(RecordedFramingView, {
    inspection: { status: 'limited', trace, sourcePath: null, clipPath: null, message: 'Missing preview' }
  }))
  assert.match(html, /Inset video/)
  assert.match(html, /Local padding detection/)
  delete raw.rendered_plan[0].content_box
  assert.equal(parseFramingTrace(raw).rendered_plan[0].content_box, null)
  raw.samples[0].content_box = [.3, .05, 2, .9]
  assert.throws(() => parseFramingTrace(raw))
})


test('webcam refinement provenance is bounded and older traces remain readable', () => {
  const raw = clone()
  raw.rendered_plan[0].cam_box_refined = true
  const trace = parseFramingTrace(raw)
  assert.equal(trace.rendered_plan[0].cam_box_refined, true)
  const { RecordedFramingView } = load('src/renderer/components/FramingInspector.tsx')
  const html = require('react-dom/server').renderToStaticMarkup(require('react').createElement(RecordedFramingView, {
    inspection: { status: 'limited', trace, sourcePath: null, clipPath: null, message: 'Missing preview' }
  }))
  assert.match(html, /Refined against source image edges/)
  delete raw.rendered_plan[0].cam_box_refined
  assert.equal(parseFramingTrace(raw).rendered_plan[0].cam_box_refined, false)
  raw.rendered_plan[0].cam_box_refined = 'yes'
  assert.throws(() => parseFramingTrace(raw))
})
