const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadMain, tempDir, fakeElectron } = require('../zernio/support/load-main.cjs')
const fixture = require('../fixtures/editor/project.json')
const schema = loadMain("export * from './src/shared/clip-editor'")
const clone = () => structuredClone(fixture)

test('editor project validates cuts, geometry and candidate identity; strips extra authority', () => {
  const p = clone(); p.apiKey = 'secret'; p.candidates[0].sourcePath = '/private.mp4'
  const parsed = schema.parseEditorProject(p)
  assert.equal(parsed.candidates[0].review.questions.length, 8)
  assert.ok(!JSON.stringify(parsed).includes('secret'))
  assert.ok(!JSON.stringify(parsed).includes('/private'))
  for (const modify of [
    p => { p.version = 2 }, p => { p.width = Infinity }, p => { p.candidates[0].ranges[0][1] = NaN },
    p => { p.candidates[0].ranges[1][0] = 4000 }, p => { p.candidates[0].scenes[0].crops[0][0] = .9 },
    p => { p.candidates[0].scenes[0].at_ms = 1 }, p => { p.candidates[1].id = p.candidates[0].id },
    p => { p.candidates[0].captions = 'yes' }, p => { p.candidates[0].review.questions[0].probability = 1.5 }
  ]) { const p = clone(); modify(p); assert.throws(() => schema.parseEditorProject(p)) }
})

test('editor progress prioritizes unfinished candidates, then baked ones, over discards', () => {
  for (const [statuses, remaining, initialCandidate] of [
    [['discarded', 'refining', 'ready'], 2, 1],
    [['baked', 'discarded', 'ready', 'refining'], 2, 2],
    [['discarded', 'baked'], 0, 1],
    [['discarded', 'discarded'], 0, 0],
    [[undefined, 'discarded'], 1, 0]
  ]) assert.deepEqual(schema.editorProgress(statuses.map(status => ({ status }))), { remaining, initialCandidate })
})

test('edit signature invalidates Jev after trims, titles or framing, and preserves it for caption settings', () => {
  const c = clone().candidates[0]
  assert.equal(JSON.stringify(JSON.parse(c.review.signature)), schema.editSignature(c))
  const key = schema.editSignature(c)
  c.captions = false; c.video_speed = 1.5
  assert.equal(schema.editSignature(c), key)
  c.ranges[0][0] = 1200
  assert.notEqual(schema.editSignature(c), key)
  assert.equal(schema.sceneAt(c, 9000).layout, 'split')
  assert.ok(schema.defaultCrop(1920, 1080, 9 / 16, 0)[0] === 0)
  assert.equal(schema.editDuration(c), 6800 / 1.5)
})

test('smooth movement preserves legacy projects and eases crops continuously through interrupted layouts', () => {
  const c = clone().candidates[0]
  const original = schema.editSignature(c)
  c.scenes[0].transition_ms = 0
  assert.equal(schema.editSignature(c), original)
  c.scenes = [
    { at_ms: 0, layout: 'fill', crops: [[0, 0, .4, 1]] },
    { at_ms: 2000, layout: 'fill', crops: [[.6, .5, .2, .5]], transition_ms: 1000 },
    { at_ms: 2500, layout: 'fill', crops: [[0, 0, .4, 1]], transition_ms: 1000 }
  ]
  assert.deepEqual(schema.framingAt(c, 2000).crops[0], [0, 0, .4, 1])
  assert.deepEqual(schema.framingAt(c, 2500).crops[0], [.3, .25, .30000000000000004, .75])
  assert.ok(Math.abs(schema.framingAt(c, 3000).crops[0][0] - .15) < 1e-9)
  assert.deepEqual(schema.framingAt(c, 3500).crops[0], [0, 0, .4, 1])
  assert.equal(schema.parseCandidateEdit(c, 12000).scenes[1].transition_ms, 1000)
  const animatedKey = schema.editSignature(c)
  c.scenes[1].transition_ms = 600
  assert.notEqual(schema.editSignature(c), animatedKey)
  for (const duration of [-1, 99, 5001, Infinity, NaN, '600', 600.5, null]) {
    c.scenes[1].transition_ms = duration
    assert.throws(() => schema.parseCandidateEdit(c, 12000))
  }
  c.scenes[1].transition_ms = 600; c.scenes[0].layout = 'fit'
  assert.throws(() => schema.parseCandidateEdit(c, 12000))
  c.scenes = schema.normalizeSceneTransitions(c.scenes)
  assert.equal(c.scenes[1].transition_ms, undefined)
  assert.equal(schema.parseCandidateEdit(c, 12000).scenes[2].transition_ms, 1000)
})

test('timeline edges extend to source limits without crossing other cuts or collapsing a cut', () => {
  const cuts = [[10000, 15000], [18000, 20000]]
  assert.deepEqual(schema.trimRange(cuts, 0, 0, -500, 60000), [[0, 15000], [18000, 20000]])
  assert.deepEqual(schema.trimRange(cuts, 1, 1, 70000, 60000), [[10000, 15000], [18000, 60000]])
  assert.deepEqual(schema.trimRange(cuts, 0, 1, 19000, 60000), [[10000, 18000], [18000, 20000]])
  assert.deepEqual(schema.trimRange(cuts, 1, 0, 0, 60000), [[10000, 15000], [15000, 20000]])
  assert.deepEqual(schema.trimRange(cuts, 0, 1, 0, 60000), [[10000, 10100], [18000, 20000]])
  assert.deepEqual(cuts, [[10000, 15000], [18000, 20000]])
})

test('layout start times move between neighbours without changing crops, motion or the initial layout', () => {
  const c = schema.parseEditorProject(clone()).candidates[0]
  const scenes = [c.scenes[0], { ...c.scenes[0], at_ms: 3000, transition_ms: 700 }, { ...c.scenes[1], at_ms: 8000 }]
  const before = structuredClone(scenes)
  for (const [time, expected] of [[4000.4, 4000], [2500, 2500], [-1000, 1], [9000, 7999]]) {
    const moved = schema.retimeScene(scenes, 1, time, 12000)
    assert.equal(moved[1].at_ms, expected)
    assert.deepEqual({ ...moved[1], at_ms: 3000 }, scenes[1])
    assert.equal(moved[0], scenes[0]); assert.equal(moved[2], scenes[2])
    assert.doesNotThrow(() => schema.parseCandidateEdit({ ...c, scenes: moved }, 12000))
  }
  assert.equal(schema.retimeScene(scenes, 2, 20000, 12000)[2].at_ms, 11999)
  assert.equal(schema.retimeScene(scenes, 2, 0, 12000)[2].at_ms, 3001)
  for (const [index, time] of [[0, 5000], [-1, 2000], [3, 2000], [1, NaN], [1, Infinity], [1, 3000]]) {
    assert.equal(schema.retimeScene(scenes, index, time, 12000), scenes)
  }
  const adjacent = [scenes[0], { ...scenes[1], at_ms: 1 }, { ...scenes[2], at_ms: 2 }]
  assert.equal(schema.retimeScene(adjacent, 1, 1000, 12000), adjacent)
  assert.deepEqual(scenes, before)
  const approved = { ...c, status: 'ready', scenes }
  const moved = schema.refineEdit(approved, { scenes: schema.retimeScene(scenes, 1, 4000, 12000) })
  assert.equal(moved.status, 'refining')
  assert.notEqual(schema.editSignature(moved), schema.editSignature(approved))
})

test('each crop corner resizes proportionally while anchoring its opposite corner', () => {
  const original = [.25, .25, .2, .4], width = 640, height = 360
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`)
  for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
    const sx = corner.endsWith('right') ? 1 : -1, sy = corner.startsWith('bottom') ? 1 : -1
    for (const scale of [.75, 1.4]) {
      const next = schema.resizeCrop(original, corner, sx * original[2] * width * (scale - 1), sy * original[3] * height * (scale - 1), width, height)
      close(next[2], original[2] * scale); close(next[3], original[3] * scale)
      close(next[0] + (sx < 0 ? next[2] : 0), original[0] + (sx < 0 ? original[2] : 0))
      close(next[1] + (sy < 0 ? next[3] : 0), original[1] + (sy < 0 ? original[3] : 0))
    }
    // Vertical-only movement also resizes without stretching the output.
    const vertical = schema.resizeCrop(original, corner, 0, sy * -20, width, height)
    assert.ok(vertical[2] < original[2]); close(vertical[2] / vertical[3], original[2] / original[3])
  }
  assert.deepEqual(original, [.25, .25, .2, .4])
})

test('corner drags stop at source edges and zoom limits without flipping or producing invalid crops', () => {
  for (const [width, height] of [[1920, 1080], [1080, 1920], [1280, 720]]) for (const aspect of [9 / 16, 9 / 8, 16 / 9]) {
    for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
      const original = schema.defaultCrop(width, height, aspect, .4, .6, 2)
      const sx = corner.endsWith('right') ? 1 : -1, sy = corner.startsWith('bottom') ? 1 : -1
      for (const distance of [-100000, -1, 0, 1, 100000]) {
        const next = schema.resizeCrop(original, corner, sx * distance, sy * distance, 640, 360)
        assert.ok(Math.abs(next[2] / next[3] - original[2] / original[3]) < 1e-9)
        assert.ok(next[0] >= 0 && next[1] >= 0 && next[0] + next[2] <= 1 && next[1] + next[3] <= 1)
        const full = schema.defaultCrop(width, height, aspect)
        assert.ok(next[2] >= full[2] / 4 - 1e-10 && next[3] >= full[3] / 4 - 1e-10)
        const c = schema.parseEditorProject(clone()).candidates[0]
        c.scenes = [{ at_ms: 0, layout: 'fill', crops: [next] }]
        assert.doesNotThrow(() => schema.parseCandidateEdit(c, 12000, 4))
      }
    }
  }
  const legacy = [.2, .2, .02, .04]
  assert.deepEqual(schema.resizeCrop(legacy, 'bottom-right', -10000, -10000, 640, 360), legacy)
  assert.deepEqual(schema.resizeCrop(legacy, 'top-left', 100, 100, 0, 360), legacy)
})

test('legacy candidates start refining; caption corrections are bounded and refer to unique source lines', () => {
  const parsed = schema.parseEditorProject(clone())
  assert.equal(parsed.candidates[0].status, 'refining')
  assert.deepEqual(parsed.candidates[0].caption_edits, [])
  const c = parsed.candidates[0]
  c.caption_edits = [{ segment: 2, text: '' }, { segment: 0, text: 'A corrected line.\nCafé 👋' }]
  assert.deepEqual(schema.parseCandidateEdit(c, 12000, 4).caption_edits.map(e => e.segment), [0, 2])
  for (const patch of [
    { status: 'published' }, { status: null }, { caption_edits: null },
    { caption_edits: [{ segment: 4, text: 'outside source' }] },
    { caption_edits: [{ segment: .5, text: 'fractional' }] },
    { caption_edits: [{ segment: 0, text: 'a' }, { segment: 0, text: 'b' }] },
    { caption_edits: [{ segment: 0, text: 'a'.repeat(2001) }] },
    { caption_edits: [{ segment: 0, text: 'bad\u0000text' }] },
    { caption_edits: Array.from({ length: 2001 }, (_, segment) => ({ segment, text: '' })) }
  ]) assert.throws(() => schema.parseCandidateEdit({ ...c, ...patch }, 12000, 4))
})

test('content changes return approved candidates to refining; status changes preserve source review', () => {
  const c = schema.parseEditorProject(clone()).candidates[0]
  const patches = [{ title: 'Changed title' }, { ranges: [[1000, 4000]] }, { scenes: [c.scenes[0]] },
    { captions: false }, { caption_preset: 'minimal' }, { video_speed: 1.5 }, { caption_edits: [{ segment: 1, text: 'Correction' }] }]
  for (const status of ['ready', 'baked']) for (const patch of patches) {
    const next = schema.refineEdit({ ...c, status }, patch)
    assert.equal(next.status, 'refining')
    assert.deepEqual(next.review, c.review)
  }
  assert.equal(schema.refineEdit({ ...c, status: 'ready' }, { title: c.title }).status, 'ready')
  assert.equal(schema.refineEdit(c, { status: 'ready' }).status, 'ready')
  assert.equal(schema.refineEdit(c, { status: 'discarded' }).status, 'discarded')
  assert.equal(schema.editSignature(schema.refineEdit(c, patches.at(-1))), schema.editSignature(c))
})

function setup(overrides = {}) {
  const temp = tempDir('bridgeclip-editor-')
  const library = path.join(temp.dir, 'library'), run = path.join(library, 'review-run')
  fs.mkdirSync(run, { recursive: true })
  for (const file of ['editor-source.mp4', 'editor-preview.mp4']) fs.writeFileSync(path.join(run, file), 'video')
  fs.writeFileSync(path.join(run, 'editor-project.json'), JSON.stringify(fixture))
  fs.writeFileSync(path.join(run, 'job_output.json'), JSON.stringify({ job_id: 'review-run', clips: [], editor_project: true }))
  const mocks = { electron: fakeElectron(temp.dir).electron, ...overrides }
  const source = "export * from './src/main/clip-editor'; export * as settings from './src/main/settings-store'"
  const main = loadMain(source, mocks)
  main.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3' })
  return { ...temp, run, library, main, reload: () => loadMain(source, mocks) }
}

test('editor saves only editable fields, survives reload and refuses stale revisions', async () => {
  const f = setup()
  try {
    const opened = await f.main.openEditor(f.run)
    const edits = opened.project.candidates
    edits[0].title = 'A deliberate title'
    edits[0].status = 'ready'
    edits[0].caption_edits = [{ segment: 1, text: 'The correction happened.' }]
    edits[0].scenes.splice(1, 0, { ...structuredClone(edits[0].scenes[0]), at_ms: 3000, transition_ms: 600 })
    edits[0].review = null; edits[0].exports = [999]
    const saved = await f.main.saveEditor(f.run, 0, edits)
    assert.equal(saved.project.revision, 1)
    assert.equal(saved.project.candidates[0].title, 'A deliberate title')
    assert.ok(saved.project.candidates[0].review)
    assert.deepEqual(saved.project.candidates[0].exports, [])
    assert.equal(saved.project.candidates[0].status, 'ready')
    assert.deepEqual(saved.project.candidates[0].caption_edits, edits[0].caption_edits)
    assert.deepEqual(saved.project.transcript, fixture.transcript)
    assert.deepEqual(saved.project.candidates[1].caption_edits, [])
    assert.equal((await f.reload().openEditor(f.run)).project.candidates[0].title, 'A deliberate title')
    assert.equal((await f.reload().openEditor(f.run)).project.candidates[0].scenes[1].transition_ms, 600)
    await assert.rejects(f.main.saveEditor(f.run, 0, edits), /changed/)
    await assert.rejects(f.main.runEditor(f.run, 1, 'unknown', 'export'), /changed/)
  } finally { f.cleanup() }
})

test('only ready candidates render and only a completed render can mark a candidate baked', async () => {
  const f = setup()
  try {
    const project = (await f.main.openEditor(f.run)).project
    await assert.rejects(f.main.runEditor(f.run, 0, 'candidate-1', 'export'), /Mark this clip ready/)
    project.candidates[0].status = 'baked'
    await assert.rejects(f.main.saveEditor(f.run, 0, project.candidates), /completed render/)
    project.candidates[0].status = 'discarded'
    await f.main.saveEditor(f.run, 0, project.candidates)
    await assert.rejects(f.main.runEditor(f.run, 1, 'candidate-1', 'export'), /Mark this clip ready/)
    // A genuine previous render can survive unchanged saves, never edited content.
    project.revision = 2; project.candidates[0].status = 'baked'; project.candidates[0].exports = [0]
    fs.writeFileSync(path.join(f.run, 'editor-project.json'), JSON.stringify(project))
    await f.main.saveEditor(f.run, 2, project.candidates)
    project.candidates[0].caption_edits = [{ segment: 1, text: 'New words' }]
    await assert.rejects(f.main.saveEditor(f.run, 3, project.candidates), /completed render/)
    project.candidates[0].status = 'refining'
    const saved = await f.main.saveEditor(f.run, 3, project.candidates)
    assert.equal(saved.project.candidates[0].status, 'refining')
    assert.deepEqual(saved.project.candidates[0].exports, [0])
  } finally { f.cleanup() }
})

test('editor rejects external roots and symlinked source/project files', async () => {
  const f = setup()
  try {
    await assert.rejects(f.main.openEditor(f.dir))
    await assert.rejects(f.main.openEditor(f.library))
    const target = path.join(f.dir, 'external.json'); fs.writeFileSync(target, JSON.stringify(fixture))
    const project = path.join(f.run, 'editor-project.json'); fs.unlinkSync(project); fs.symlinkSync(target, project)
    await assert.rejects(f.main.openEditor(f.run))
    fs.unlinkSync(project); fs.writeFileSync(project, JSON.stringify(fixture))
    const source = path.join(f.run, 'editor-source.mp4'); fs.unlinkSync(source); fs.symlinkSync(target, source)
    await assert.rejects(f.main.openEditor(f.run))
    assert.equal(fs.readFileSync(target, 'utf8'), JSON.stringify(fixture))
  } finally { f.cleanup() }
})

test('enabled Jev reaches the worker and locks the project until review finishes', async () => {
  const { EventEmitter } = require('node:events')
  const { PassThrough } = require('node:stream')
  let release, entered, config
  const started = new Promise((r) => { entered = r })
  const f = setup({ child_process: { ...require('node:child_process'), spawn: () => {
    const child = new EventEmitter()
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough()
    child.stdin.end = (data) => {
      config = JSON.parse(data); entered()
      release = () => { child.stdout.write('{"ok":true}'); child.emit('close', 0) }
    }
    return child
  } } })
  try {
    f.main.settings.replaceApiKey('openrouterApiKey', 'fixture-key')
    f.main.settings.savePublicSettings({ outputDirectory: f.library, pythonPath: 'python3', jevEnabled: 'on' })
    const pending = f.main.runEditor(f.run, 0, 'candidate-1', 'review')
    await started
    assert.equal(config.action, 'review')
    assert.equal(config.library, fs.realpathSync(f.library))
    assert.equal((await f.main.openEditor(f.run)).operation, 'review')
    await assert.rejects(f.main.saveEditor(f.run, 0, fixture.candidates), /Wait/)
    await assert.rejects(f.main.runEditor(f.run, 0, 'candidate-1', 'export'), /already running/)
    release(); await pending
    assert.equal((await f.main.openEditor(f.run)).operation, null)
    f.main.settings.savePublicSettings({ outputDirectory: f.library, pythonPath: 'python3', jevEnabled: 'off' })
    await assert.rejects(f.main.runEditor(f.run, 0, 'candidate-1', 'review'), /Enable Jev/)
  } finally { f.cleanup() }
})
