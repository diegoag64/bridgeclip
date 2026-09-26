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
