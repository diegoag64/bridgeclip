'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { loadMain, tempDir, fakeElectron } = require('../zernio/support/load-main.cjs')
const { directoryLinkType } = require('../support/symlinks.cjs')

function fixture(extraMocks = {}) {
  const temp = tempDir('bridgeclip-library-management-')
  const library = path.join(temp.dir, 'library')
  const run = path.join(library, 'completed-run')
  fs.mkdirSync(run, { recursive: true })
  const clip = path.join(run, 'clip.mp4')
  fs.writeFileSync(clip, 'clip bytes')
  const output = { source_video_title: 'Test run', clips: [{ clip_index: 0, s3_url: `file://${clip}`, duration_ms: 1000, start_time_ms: 0, end_time_ms: 1000, summary: 'Clip', virality_score: 0.8 }] }
  fs.writeFileSync(path.join(run, 'job_output.json'), JSON.stringify(output))
  const active = new Set(), dismissed = []
  const mocks = {
    electron: fakeElectron(temp.dir).electron,
    './job-manager': { liveJobIds: () => active, dismissJob: (id) => dismissed.push(id) },
    ...extraMocks
  }
  const source = "export * from './src/main/library-management'; export * as files from './src/main/file-manager'; export * as settings from './src/main/settings-store'"
  const main = loadMain(source, mocks)
  main.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3' })
  return { ...temp, library, run, clip, output, active, dismissed, main, reload: () => loadMain(source, mocks) }
}

test('favorites persist across reloads and are returned in Library history', async () => {
  const f = fixture()
  try {
    assert.equal((await f.main.files.getJobHistory(f.library))[0].favorite, false)
    await f.main.setLibraryFavorite(f.run, true)
    assert.equal((await f.reload().files.getJobHistory(f.library))[0].favorite, true)
    await f.main.setLibraryFavorite(f.run, true)
    await f.main.setLibraryFavorite(f.run, false)
    assert.equal((await f.main.files.getJobHistory(f.library))[0].favorite, false)
    await assert.rejects(f.main.setLibraryFavorite(f.run, 'true'), /valid favorite/)
  } finally { f.cleanup() }
})

test('manual posted marks persist, undo independently, and validate clip IDs and run state', async () => {
  const f = fixture()
  try {
    const manifest = fs.readFileSync(path.join(f.run, 'job_output.json'), 'utf8')
    await f.main.setLibraryPosted(f.run, 0, true)
    await f.main.setLibraryPosted(f.run, 0, true)
    assert.equal(f.reload().files.isManuallyPosted(f.run, 0), true)
    assert.equal(fs.readFileSync(path.join(f.run, 'job_output.json'), 'utf8'), manifest)
    assert.equal(fs.readFileSync(f.clip, 'utf8'), 'clip bytes')
    for (const id of [-1, 1000, 0.5, '0', null, 1]) await assert.rejects(f.main.setLibraryPosted(f.run, id, true))
    await assert.rejects(f.main.setLibraryPosted(f.run, 0, 'true'))
    await assert.rejects(f.main.setLibraryPosted(f.library, 0, true))
    f.active.add('completed-run')
    await assert.rejects(f.main.setLibraryPosted(f.run, 0, false), /finish/)
    assert.equal(f.main.files.isManuallyPosted(f.run, 0), true)
    f.active.clear()
    await f.main.setLibraryPosted(f.run, 0, false)
    await f.main.setLibraryPosted(f.run, 0, false)
    assert.equal(f.reload().files.isManuallyPosted(f.run, 0), false)
  } finally { f.cleanup() }
})

test('deletion removes every run file and its cached previews, preserving other runs and external sources', async () => {
  const f = fixture()
  try {
    const sibling = path.join(f.library, 'other-run')
    const outside = path.join(f.dir, 'original.mp4')
    fs.mkdirSync(sibling)
    fs.writeFileSync(path.join(sibling, 'keep.txt'), 'keep')
    fs.writeFileSync(outside, 'original')
    fs.mkdirSync(path.join(f.run, 'nested'))
    fs.writeFileSync(path.join(f.run, 'nested', 'transcript.json'), '{}')
    fs.writeFileSync(path.join(f.run, 'run.log'), 'log')
    if (directoryLinkType) fs.symlinkSync(sibling, path.join(f.run, 'linked-folder'), directoryLinkType)
    await f.main.setLibraryFavorite(f.run, true)
    const cache = path.join(f.dir, 'userData', 'thumbnails')
    fs.mkdirSync(cache)
    const stat = fs.statSync(f.clip)
    const thumbnails = ['middle', 0.5].map((seek) => {
      const identity = `${fs.realpathSync(f.clip)}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${seek}`
      const file = path.join(cache, `${createHash('sha256').update(identity).digest('hex')}.jpg`)
      fs.writeFileSync(file, 'preview')
      return file
    })
    fs.writeFileSync(path.join(cache, 'unrelated.jpg'), 'keep')
    await f.main.deleteLibraryRun(f.run)
    assert.equal(fs.existsSync(f.run), false)
    assert.ok(thumbnails.every((file) => !fs.existsSync(file)))
    assert.equal(fs.readFileSync(path.join(cache, 'unrelated.jpg'), 'utf8'), 'keep')
    assert.equal(fs.readFileSync(outside, 'utf8'), 'original')
    assert.equal(fs.readFileSync(path.join(sibling, 'keep.txt'), 'utf8'), 'keep')
    assert.deepEqual(f.dismissed, ['completed-run'])
  } finally { f.cleanup() }
})

test('Library mutations reject the root, outside folders, nested folders, symlink runs and active jobs', async () => {
  const f = fixture()
  try {
    const nested = path.join(f.run, 'nested')
    fs.mkdirSync(nested)
    const invalid = [f.library, f.dir, nested, 'relative/path']
    if (directoryLinkType) {
      const link = path.join(f.library, 'linked-run')
      fs.symlinkSync(f.run, link, directoryLinkType)
      invalid.push(link)
    }
    for (const file of invalid) {
      await assert.rejects(f.main.deleteLibraryRun(file))
      await assert.rejects(f.main.setLibraryFavorite(file, true))
    }
    f.active.add('completed-run')
    await assert.rejects(f.main.deleteLibraryRun(f.run), /finish/)
    assert.equal(fs.existsSync(f.clip), true)
    f.active.clear()
    fs.unlinkSync(path.join(f.run, 'job_output.json'))
    await assert.rejects(f.main.deleteLibraryRun(f.run), /completed run/)
  } finally { f.cleanup() }
})

test('a run becoming active during manifest validation cannot be deleted', async () => {
  let release, entered
  const started = new Promise((resolve) => { entered = resolve })
  const f = fixture({ './file-manager': { getJobOutput: () => { entered(); return new Promise((resolve) => { release = resolve }) } } })
  try {
    const deletion = f.main.deleteLibraryRun(f.run)
    await started
    f.active.add('completed-run')
    release(f.output)
    await assert.rejects(deletion, /finish/)
    assert.equal(fs.existsSync(f.clip), true)
  } finally { f.cleanup() }
})

test('a favorite marker symlink cannot overwrite a file outside the run', async (t) => {
  if (!directoryLinkType) { t.skip('Symlinks unavailable'); return }
  const f = fixture()
  try {
    const outside = path.join(f.dir, 'keep.txt')
    fs.writeFileSync(outside, 'keep')
    fs.symlinkSync(outside, path.join(f.run, '.bridgeclip-favorite'))
    await assert.rejects(f.main.setLibraryFavorite(f.run, true))
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep')
    await f.main.setLibraryFavorite(f.run, false)
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep')
  } finally { f.cleanup() }
})

function clipFixture(mocks = {}) {
  const f = fixture(mocks)
  const first = f.output.clips[0]
  fs.unlinkSync(f.clip)
  f.output.clips = [0, 2, 9].map(clip_index => ({ ...first, clip_index, s3_url: path.join(f.run, `clip_${String(clip_index).padStart(2, '0')}.mp4`) }))
  for (const clip of f.output.clips) {
    fs.writeFileSync(clip.s3_url, `clip ${clip.clip_index}`)
    fs.writeFileSync(clip.s3_url.replace('.mp4', '.framing.json'), '{}')
  }
  f.output.editor_project = true
  f.output.custom_metadata = { keep: 'complete raw metadata' }
  f.output.total_clips = 3
  fs.writeFileSync(path.join(f.run, 'job_output.json'), JSON.stringify(f.output))
  const project = structuredClone(require('../fixtures/editor/project.json'))
  project.candidates = ['baked', 'baked', 'refining', 'discarded'].map((status, i) => ({
    ...structuredClone(project.candidates[0]), id: `candidate-${i}`, status, exports: i === 0 ? [0, 2] : i === 1 ? [2] : [9]
  }))
  fs.writeFileSync(path.join(f.run, 'editor-project.json'), JSON.stringify(project))
  for (const name of ['editor-source.mp4', 'editor-preview.mp4', 'framing-source.mp4', 'transcript.json']) fs.writeFileSync(path.join(f.run, name), 'preserved')
  return { ...f, project }
}

test('selected clip deletion preserves sources, unselected files, metadata, posting copies and stable IDs', async () => {
  const f = clipFixture()
  try {
    const copy = path.join(f.dir, 'automation-copy.mp4')
    fs.copyFileSync(f.output.clips[1].s3_url, copy)
    await f.main.setLibraryPosted(f.run, 0, true)
    await f.main.setLibraryPosted(f.run, 2, true)
    const output = await f.main.deleteLibraryClips(f.run, [2, 9])
    assert.equal(f.main.files.isManuallyPosted(f.run, 0), true)
    assert.equal(fs.existsSync(path.join(f.run, '.bridgeclip-posted-2')), false)
    assert.deepEqual(output.clips.map(c => c.clip_index), [0])
    assert.equal(output.total_clips, 1)
    assert.equal(fs.existsSync(path.join(f.run, 'clip_02.mp4')), false)
    assert.equal(fs.existsSync(path.join(f.run, 'clip_09.framing.json')), false)
    assert.equal(fs.readFileSync(path.join(f.run, 'clip_00.mp4'), 'utf8'), 'clip 0')
    assert.ok(fs.existsSync(path.join(f.run, 'clip_00.framing.json')))
    assert.equal(fs.readFileSync(copy, 'utf8'), 'clip 2')
    for (const name of ['editor-source.mp4', 'editor-preview.mp4', 'framing-source.mp4', 'transcript.json']) assert.equal(fs.readFileSync(path.join(f.run, name), 'utf8'), 'preserved')
    const raw = JSON.parse(fs.readFileSync(path.join(f.run, 'job_output.json')))
    assert.deepEqual(raw.custom_metadata, f.output.custom_metadata)
    assert.equal(raw.next_clip_index, 10)
    const project = JSON.parse(fs.readFileSync(path.join(f.run, 'editor-project.json')))
    assert.equal(project.revision, f.project.revision + 1)
    assert.deepEqual(project.candidates.map(c => c.status), ['ready', 'ready', 'refining', 'discarded'])
    assert.deepEqual(project.candidates.map(c => c.exports), [[0], [], [], []])
    assert.deepEqual(project.candidates[1].ranges, f.project.candidates[1].ranges)
    assert.deepEqual(project.transcript, f.project.transcript)
    assert.deepEqual(f.dismissed, [])
    await f.main.deleteLibraryClips(f.run, [0])
    assert.equal((await f.reload().files.getJobHistory(f.library))[0].clipCount, 0)
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.run, 'job_output.json'))).next_clip_index, 10)
    assert.ok(fs.existsSync(path.join(f.run, 'editor-source.mp4')))
    assert.equal(fs.readdirSync(f.run).some(name => name.startsWith('.delete-clips-')), false)
  } finally { f.cleanup() }
})

test('clip deletion rejects invalid selections and unsafe media without removing any files', async () => {
  const f = clipFixture()
  try {
    for (const ids of [[], null, '0', [0, 0], [1], [-1], [0.1], [1000], ['0']]) await assert.rejects(f.main.deleteLibraryClips(f.run, ids))
    for (const run of [f.library, f.dir, 'relative']) await assert.rejects(f.main.deleteLibraryClips(run, [0]))
    const keep = path.join(f.dir, 'clip_00.mp4')
    fs.writeFileSync(keep, 'outside')
    for (const file of [keep, path.join(f.run, 'editor-source.mp4')]) {
      const altered = structuredClone(f.output); altered.clips[0].s3_url = file
      fs.writeFileSync(path.join(f.run, 'job_output.json'), JSON.stringify(altered))
      await assert.rejects(f.main.deleteLibraryClips(f.run, [0]), /outside/)
      assert.ok(fs.existsSync(file))
    }
    fs.writeFileSync(path.join(f.run, 'job_output.json'), JSON.stringify(f.output))
    if (directoryLinkType) {
      const clip = path.join(f.run, 'clip_00.mp4')
      fs.unlinkSync(clip); fs.symlinkSync(keep, clip)
      await assert.rejects(f.main.deleteLibraryClips(f.run, [0]), /unsafe/)
      assert.equal(fs.readFileSync(keep, 'utf8'), 'outside')
    }
    assert.ok(fs.existsSync(path.join(f.run, 'clip_02.mp4')))
  } finally { f.cleanup() }
})

test('clip deletion restores media and both manifests if committing the output fails', async () => {
  let failed = false
  const f = clipFixture({ fs: { ...fs, renameSync: (from, to) => {
    if (!failed && path.basename(from) === 'new-job_output.json') { failed = true; throw new Error('disk failure') }
    fs.renameSync(from, to)
  } } })
  try {
    await assert.rejects(f.main.deleteLibraryClips(f.run, [0, 2]), /disk failure/)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.run, 'job_output.json'))), f.output)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.run, 'editor-project.json'))), f.project)
    for (const clip of f.output.clips) assert.ok(fs.existsSync(clip.s3_url))
    assert.equal(fs.readdirSync(f.run).some(name => name.startsWith('.delete-clips-')), false)
  } finally { f.cleanup() }
})

test('overlapping deletions re-read current metadata and tolerate already missing video files', async () => {
  const f = clipFixture()
  try {
    fs.unlinkSync(path.join(f.run, 'clip_02.mp4'))
    await Promise.all([f.main.deleteLibraryClips(f.run, [2]), f.main.deleteLibraryClips(f.run, [9])])
    assert.deepEqual((await f.main.files.getJobOutput(f.run)).clips.map(c => c.clip_index), [0])
    await assert.rejects(f.main.deleteLibraryClips(f.run, [2]), /no longer/)
  } finally { f.cleanup() }
})

test('clip deletion refuses active jobs and editor operations', async () => {
  let busy = false
  const f = clipFixture({ './clip-editor': { editorBusy: () => busy } })
  try {
    busy = true
    await assert.rejects(f.main.deleteLibraryClips(f.run, [0]), /editor to finish/)
    busy = false; f.active.add('completed-run')
    await assert.rejects(f.main.deleteLibraryClips(f.run, [0]), /run to finish/)
    assert.ok(fs.existsSync(path.join(f.run, 'clip_00.mp4')))
  } finally { f.cleanup() }
})
