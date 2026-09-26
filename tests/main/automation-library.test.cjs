'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadMain, tempDir, fakeElectron } = require('../zernio/support/load-main.cjs')
const { directoryLinkType } = require('../support/symlinks.cjs')

function fixture() {
  const temp = tempDir('bridgeclip-bank-library-')
  const library = path.join(temp.dir, 'library')
  const run = path.join(library, 'source-run')
  fs.mkdirSync(run, { recursive: true })
  const clip = path.join(run, 'clip.mp4')
  const other = path.join(run, 'other.mp4')
  fs.writeFileSync(other, 'different clip data')
  const bank = path.join(temp.dir, 'bank.mp4')
  fs.writeFileSync(clip, 'original clip bytes')
  fs.copyFileSync(clip, bank)
  const manifest = (file = clip) => fs.writeFileSync(path.join(run, 'job_output.json'), JSON.stringify({
    source_video_title: 'Source video', clips: [{ clip_index: 3, s3_url: other, duration_ms: 1000, start_time_ms: 0, end_time_ms: 1000, summary: 'Original title', virality_score: 1 }, { clip_index: 17, s3_url: `file://${file}`, duration_ms: 1000,
      start_time_ms: 0, end_time_ms: 1000, summary: 'Original title', virality_score: 0.8 }]
  }))
  manifest()
  const main = loadMain("export * from './src/main/automation-source'; export * as security from './src/main/security'; export * as automations from './src/main/automations'; export * as settings from './src/main/settings-store'", { electron: fakeElectron(temp.dir).electron })
  main.security.authorizeMedia(bank)
  main.settings.replaceApiKey('zernioApiKey', 'test-key')
  main.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3' })
  return { ...temp, library, run, clip, bank, manifest, main }
}

test('View in Library uses persisted provenance after title edits', async () => {
  const f = fixture()
  try {
    const [automation] = f.main.automations.createAutomation('Content bank')
    const [added] = await f.main.automations.addLibraryClipsToAutomation(automation.id, f.run, [17])
    f.main.automations.updateAutomationContent(automation.id, added.content[0].id, { title: 'An enhanced title', caption: 'New caption' })
    assert.deepEqual(await f.main.automations.automationLibraryClip(automation.id, added.content[0].id), { outputDir: f.run, clipIndex: 17 })
    await assert.rejects(f.main.automations.automationLibraryClip(automation.id, 'missing'), /Clip not found/)
    fs.rmSync(f.run, { recursive: true })
    assert.equal(await f.main.automations.automationLibraryClip(automation.id, added.content[0].id), null)
  } finally { f.cleanup() }
})

test('legacy bank copies resolve by bytes without relying on editable titles', async () => {
  const f = fixture()
  try {
    assert.deepEqual(await f.main.findLibraryClipForClip(f.bank, f.library), { outputDir: f.run, clipIndex: 17 })
    fs.writeFileSync(f.clip, 'different clip data') // Equal size is not sufficient.
    assert.equal(fs.statSync(f.clip).size, fs.statSync(f.bank).size)
    assert.equal(await f.main.findLibraryClipForClip(f.bank, f.library), null)
    assert.equal(await f.main.findLibraryClipForClip(null, f.library), null)
  } finally { f.cleanup() }
})

test('missing sources and clips outside the recorded run never produce a library link', async () => {
  const f = fixture()
  try {
    f.manifest(f.bank)
    assert.equal(await f.main.findLibraryClipForClip(f.bank, f.library, f.bank), null)
    f.manifest()
    fs.unlinkSync(f.clip)
    assert.equal(await f.main.findLibraryClipForClip(f.bank, f.library, f.clip), null)
    fs.rmSync(f.library, { recursive: true })
    assert.equal(await f.main.findLibraryClipForClip(f.bank, f.library, f.clip), null)
  } finally { f.cleanup() }
})

test('source links use the configured Library path even when it is a directory alias', { skip: !directoryLinkType }, async () => {
  const f = fixture()
  try {
    const alias = path.join(f.dir, 'library-alias')
    fs.symlinkSync(f.library, alias, directoryLinkType)
    assert.deepEqual(await f.main.findLibraryClipForClip(null, alias, f.clip), { outputDir: path.join(alias, 'source-run'), clipIndex: 17 })
  } finally { f.cleanup() }
})
