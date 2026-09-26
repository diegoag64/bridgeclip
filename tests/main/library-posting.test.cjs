'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadMain, tempDir, fakeElectron } = require('../zernio/support/load-main.cjs')

test('only a confirmed published post is hidden; partial, scheduled and inbox deliveries stay visible', () => {
  const { clipPostingStatus } = loadMain("export * from './src/shared/library-posting'")
  const post = (status, targets) => ({ status, targets })
  const target = (status, inbox = false) => ({ platform: 'youtube', status, inbox })
  for (const [posts, expected] of [
    [[], 'not_posted'], [[post('published', [target('published')])], 'posted'],
    [[post('partial', [target('published'), target('failed')])], 'partial'],
    [[post('scheduled', [target('pending')])], 'scheduled'],
    [[post('publishing', [target('pending')])], 'publishing'],
    [[post('published', [target('published', true)])], 'draft'],
    [[post('failed', [target('failed')])], 'failed']
  ]) assert.equal(clipPostingStatus(0, posts).state, expected)
  assert.deepEqual(clipPostingStatus(0, [post('published', [target('published', true)])]).platforms, [])
})

test('queue reordering leaves submitted and uncertain slots fixed and preserves metadata', () => {
  const { reorderQueuedContent, hasEnhancedMetadata } = loadMain("export * from './src/shared/automations'")
  const a = { id: 'a', status: 'queued', metadataEnhancement: {}, generatedMetadata: [{ platform: 'youtube' }] }
  const fixed = { id: 'fixed', status: 'posted', postId: 'post' }
  const uncertain = { id: 'uncertain', status: 'needs_review' }
  const b = { id: 'b', status: 'queued' }
  const c = { id: 'c', status: 'queued', postId: 'post-c' }
  const initial = [a, fixed, b, uncertain, c]
  const reordered = reorderQueuedContent(initial, 'b', 'a')
  assert.deepEqual(reordered.map((item) => item.id), ['b', 'fixed', 'a', 'uncertain', 'c'])
  assert.equal(reordered[2], a)
  assert.deepEqual(reorderQueuedContent(reordered, 'b', null), initial)
  for (const id of ['fixed', 'uncertain', 'c']) {
    assert.throws(() => reorderQueuedContent(initial, id, 'a'), /Only unposted/)
    assert.throws(() => reorderQueuedContent(initial, 'a', id), /Only unposted/)
  }
  assert.equal(hasEnhancedMetadata(a, ['youtube']), true)
  assert.equal(hasEnhancedMetadata(a, ['youtube', 'instagram']), false)
  assert.equal(hasEnhancedMetadata({ ...a, metadataEnhancement: undefined }, ['youtube']), false)
})

function fixture(mocks = {}) {
  const temp = tempDir('bridgeclip-library-status-')
  const library = path.join(temp.dir, 'library')
  const run = path.join(library, 'run')
  fs.mkdirSync(run, { recursive: true })
  const clips = [0, 1, 2].map((index) => {
    const file = path.join(run, `clip_${index}.mp4`)
    fs.writeFileSync(file, `clip-${index}`)
    return { clip_index: index, s3_url: `file://${file}`, summary: 'Same title', duration_ms: 1000, start_time_ms: 0, end_time_ms: 1000, virality_score: 0.8 }
  })
  fs.writeFileSync(path.join(run, 'job_output.json'), JSON.stringify({ clips }))
  const posts = [], automations = []
  const main = loadMain("export * from './src/main/library-posting'; export * as settings from './src/main/settings-store'", {
    electron: fakeElectron(temp.dir).electron,
    './zernio/posts': { listPosts: () => posts },
    './automations': { listAutomations: () => automations, isAutomationMedia: (file) => file.startsWith(path.join(temp.dir, 'bank')) },
    ...mocks
  })
  main.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3' })
  main.settings.replaceApiKey('zernioApiKey', 'test-key')
  return { ...temp, main, run, clips, posts, automations }
}

test('library history matches original paths, source provenance and byte-identical legacy bank copies', async () => {
  const f = fixture()
  try {
    const direct = f.clips[0].s3_url.slice(7)
    f.posts.push({ id: 'direct', clipPath: direct, status: 'scheduled', targets: [] })
    f.posts.push({ id: 'origin', clipPath: '/deleted/bank-copy.mp4', status: 'published', targets: [{ platform: 'youtube', status: 'published' }] })
    f.automations.push({ content: [{ postId: 'origin', sourceClipPath: f.clips[1].s3_url.slice(7) }] })
    const bank = path.join(f.dir, 'bank-copy.mp4')
    fs.copyFileSync(f.clips[2].s3_url.slice(7), bank)
    f.posts.push({ id: 'legacy', clipPath: bank, status: 'published', targets: [{ platform: 'instagram', status: 'published' }] })
    f.posts.push({ id: 'missing', clipPath: path.join(f.dir, 'bank-missing.mp4'), status: 'published', targets: [] })
    assert.deepEqual((await f.main.libraryPostingStatus(f.run)).map((item) => item.state), ['scheduled', 'posted', 'posted'])
    fs.writeFileSync(bank, 'other!')
    assert.equal((await f.main.libraryPostingStatus(f.run))[2].state, 'not_posted', 'same title and size do not imply identical content')
    f.main.settings.replaceApiKey('zernioApiKey', '')
    assert.ok((await f.main.libraryPostingStatus(f.run)).every((item) => item.state === 'not_posted'))
  } finally { f.cleanup() }
})

test('Library enhancement uses automation generators and returns a reviewable draft without publishing', async () => {
  const calls = []
  const generated = [{ platform: 'youtube', title: 'Enhanced title', caption: 'Caption', tags: ['tag'], categoryId: '22', topicTag: null }]
  const f = fixture({
    './automation-source': { sourceFromOutput: () => null, parseSourceContext: (value) => value, completeSourceContext: async (value) => value },
    './automation-metadata': {
      transcribeAutomationClip: async (file) => { calls.push(['transcribe', file]); return 'spoken words' },
      researchAutomationTopic: async (...args) => { calls.push(['research', ...args]); return { status: 'success', summary: 'Context', sources: [] } },
      generateAutomationMetadata: async (...args) => { calls.push(['generate', ...args]); return generated }
    }
  })
  try {
    f.main.settings.replaceApiKey('openrouterApiKey', 'test-writing-key')
    const options = { platforms: ['youtube'], research: true, source: { title: 'Original', description: '', channel: '', url: null }, notes: 'Notes' }
    const result = await f.main.enhanceLibraryMetadata(f.run, 0, options)
    assert.deepEqual(result.posts, generated)
    assert.deepEqual(calls.map((call) => call[0]), ['transcribe', 'research', 'generate'])
    assert.equal(calls[2][1], 'spoken words')
    assert.equal(calls[2][3], 'Notes')
    assert.deepEqual(calls[2][4], ['youtube'])
    assert.equal(result.source.title, 'Original')
    assert.equal(f.posts.length, 0)
    await assert.rejects(f.main.enhanceLibraryMetadata(f.run, 9, options), /no longer/)
    await assert.rejects(f.main.enhanceLibraryMetadata(f.dir, 0, options), /Library/)
    await assert.rejects(f.main.enhanceLibraryMetadata(f.run, 0, { ...options, platforms: ['unknown'] }), /valid platforms/)
    const before = calls.length
    await f.main.enhanceLibraryMetadata(f.run, 0, { ...options, research: false })
    assert.deepEqual(calls.slice(before).map((call) => call[0]), ['transcribe', 'generate'])
  } finally { f.cleanup() }
})
