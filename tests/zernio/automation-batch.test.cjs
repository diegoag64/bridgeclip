'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadMain, tempDir, fakeElectron } = require('./support/load-main.cjs')
const { createMockZernio } = require('./support/mock-zernio.cjs')
const SOURCE = { title: 'One original video', description: 'Reliable software and speech recognition.', channel: 'Channel', url: 'https://www.youtube.com/watch?v=hqP9fivmBqI' }
const ENTRY = "export * as automations from './src/main/automations'; export * as settings from './src/main/settings-store'"

test('attached sources and standalone uploads accept guidance without changing group identity or sharing unrelated research', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-file-guidance-')
  const research = []; const writing = []
  const mock = await createMockZernio({ extraRoutes: [{ method: 'POST', path: '/chat', auth: false, handler: (ctx) => {
    const input = JSON.parse(ctx.body.messages[1].content)
    if (ctx.body.tools) {
      research.push(input)
      return ctx.json(200, { choices: [{ message: { content: 'Terminology for reliable software.', annotations: [{ type: 'url_citation', url_citation: { title: 'Documentation', url: 'https://example.com/docs' } }] } }] })
    }
    writing.push(input)
    assert.match(ctx.body.messages[0].content, /Use enhancementGuidance/)
    ctx.json(200, { choices: [{ message: { content: JSON.stringify({ clips: input.clips.map((clip) => ({ id: clip.id, posts: [{ platform: 'youtube', title: 'Reliable software', caption: clip.transcript, evidence: clip.transcript, tags: [], categoryId: '28', topicTag: null }] })) }) } }] })
  } }] })
  const previous = process.env.BRIDGECLIP_E2E_OPENROUTER_URL
  process.env.BRIDGECLIP_E2E_OPENROUTER_URL = `${mock.url}/chat`
  try {
    const { electron } = fakeElectron(dir)
    let main = loadMain(ENTRY, { electron })
    main.settings.replaceApiKey('zernioApiKey', 'test-workspace')
    main.settings.replaceApiKey('openrouterApiKey', 'test-only')
    const library = path.join(dir, 'library'); fs.mkdirSync(library)
    main.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3' })
    const clip = path.join(library, 'clip.mp4'); fs.writeFileSync(clip, 'Already transcribed clip bytes')
    const source = { title: 'Attached workshop', description: '', channel: '', url: null, videoId: 'a'.repeat(64) }
    const [created] = main.automations.createAutomation('Files bank')
    await main.automations.addAutomationContent(created.id, Array(7).fill(clip), Array(7).fill('Workshop clip'), source)
    await main.automations.addAutomationContent(created.id, [clip], ['Other workshop'], { ...source, videoId: 'b'.repeat(64) })
    await main.automations.addAutomationContent(created.id, [clip], ['Standalone upload'])
    const storeFile = path.join(dir, 'userData', fs.readdirSync(path.join(dir, 'userData')).find((name) => /^automations-.*\.json$/.test(name)))
    const stored = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
    stored.automations[0].content.forEach((item, index) => { item.transcript = `Reliable software needs careful testing for example number ${index}.` })
    fs.writeFileSync(storeFile, JSON.stringify(stored))
    main = loadMain(ENTRY, { electron })
    const groups = await main.automations.automationEnhancementGroups(created.id)
    assert.deepEqual(groups.map((group) => [group.sourceType, group.contentIds.length]), [['file', 7], ['file', 1], ['file', 1]])
    assert.equal(groups[2].title, 'Standalone upload')
    for (const invalid of [null, {}, 12, 'x'.repeat(2001)]) {
      await assert.rejects(main.automations.enhanceAutomationBatch(created.id, groups[0].contentIds.slice(0, 5), groups[0].key, invalid), /prompt of up to 2000/)
    }
    assert.equal(research.length + writing.length, 0, 'invalid prompts are rejected before paid requests')
    const guidance = 'This is a software workshop. Focus on practical testing tips for beginners.'
    let result = await main.automations.enhanceAutomationBatch(created.id, groups[0].contentIds.slice(0, 5), groups[0].key, `  ${guidance}  `)
    assert.equal(result.completed, 5)
    main = loadMain(ENTRY, { electron })
    result = await main.automations.enhanceAutomationBatch(created.id, groups[0].contentIds.slice(5), groups[0].key, guidance)
    assert.equal(result.completed, 2, 'same group works across chunks and restarts')
    assert.equal(research.length, 1)
    assert.ok(result.automations[0].content.slice(0, 7).every((item) => item.metadataDraft.guidance === guidance && item.sourceContext.description === ''))
    assert.ok(writing.every((input) => input.enhancementGuidance === guidance))
    assert.equal(research[0].enhancementGuidance, guidance)
    assert.equal(research[0].transcript, undefined)
    let item = result.automations[0].content[0]
    main.automations.resolveAutomationMetadataDraft(created.id, item.id, item.metadataDraft.id, false)
    result = await main.automations.enhanceAutomationBatch(created.id, [item.id], groups[0].key, 'Focus on advanced testing practices.')
    assert.equal(result.completed, 1)
    assert.equal(research.length, 2, 'changing guidance invalidates shared research')
    await main.automations.enhanceAutomationBatch(created.id, groups[1].contentIds, groups[1].key, guidance)
    assert.equal(research.length, 3, 'different attached sources cannot share research')
    const unknown = await main.automations.enhanceAutomationBatch(created.id, groups[2].contentIds, groups[2].key, guidance)
    assert.equal(unknown.completed, 1, 'standalone uploads need no source URL')
    assert.equal(research.at(-1).sourceContext, null)
    assert.equal(research.at(-1).enhancementGuidance, guidance)
    assert.match(research.at(-1).transcript, /example number 8/)
    main = loadMain(ENTRY, { electron })
    assert.equal(main.automations.listAutomations()[0].content.at(-1).metadataDraft.guidance, guidance, 'review retains the supplied prompt after restart')
  } finally {
    if (previous === undefined) delete process.env.BRIDGECLIP_E2E_OPENROUTER_URL; else process.env.BRIDGECLIP_E2E_OPENROUTER_URL = previous
    await mock.close(); cleanup()
  }
})

test('source batches share research across requests and restarts, isolate videos and validate each clip independently', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-source-batch-')
  let searches = 0; const writing = []
  let releaseSearch; let searchStarted
  const started = new Promise((resolve) => { searchStarted = resolve })
  const release = new Promise((resolve) => { releaseSearch = resolve })
  const mock = await createMockZernio({ extraRoutes: [{ method: 'POST', path: '/chat', auth: false, handler: async (ctx) => {
    const input = JSON.parse(ctx.body.messages[1].content)
    if (ctx.body.tools) {
      searches++
      assert.equal(input.transcript, undefined, 'shared research must cover the source, not one short')
      assert.match(ctx.body.messages[0].content, /ALL its shorts/)
      if (searches === 1) { searchStarted(); await release }
      return ctx.json(200, { choices: [{ message: { content: 'Use relevant speech recognition and software terminology.', annotations: [{ type: 'url_citation', url_citation: { title: 'Primary documentation', url: 'https://example.com/docs' } }] } }] })
    }
    const clips = input.clips ?? [{ id: 'single', transcript: input.transcript }]
    writing.push(clips.map((clip) => clip.id))
    const postsFor = (clip, index) => [{ platform: 'youtube', title: `Accurate transcription ${index}`, caption: clip.transcript, tags: ['transcription'], categoryId: '28', topicTag: null,
      evidence: writing.length === 1 && index === 2 ? clips[0].transcript : clip.transcript }]
    ctx.json(200, { choices: [{ message: { content: JSON.stringify(input.clips ? { clips: clips.map((clip, index) => ({ id: clip.id, posts: postsFor(clip, index) })) } : { posts: postsFor(clips[0], 0) }) } }] })
  } }] })
  const previous = process.env.BRIDGECLIP_E2E_OPENROUTER_URL
  process.env.BRIDGECLIP_E2E_OPENROUTER_URL = `${mock.url}/chat`
  try {
    const { electron } = fakeElectron(dir)
    let main = loadMain(ENTRY, { electron })
    main.settings.replaceApiKey('zernioApiKey', 'test-workspace')
    main.settings.replaceApiKey('openrouterApiKey', 'test-only')
    const library = path.join(dir, 'library'); fs.mkdirSync(library)
    main.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3' })
    const clip = path.join(library, 'clip.mp4'); fs.writeFileSync(clip, 'Already transcribed clip bytes')
    const [created] = main.automations.createAutomation('Grouped bank')
    await main.automations.addAutomationContent(created.id, Array(7).fill(clip), Array(7).fill('Topic'), SOURCE)
    await main.automations.addAutomationContent(created.id, [clip], ['Topic'], { ...SOURCE, url: 'https://www.youtube.com/watch?v=cFx9Z3ZXca0' })
    const storeFile = path.join(dir, 'userData', fs.readdirSync(path.join(dir, 'userData')).find((name) => /^automations-.*\.json$/.test(name)))
    const stored = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
    stored.automations[0].content.forEach((item, index) => { item.transcript = `This clip explains topic number ${index} with a unique conclusion.` })
    fs.writeFileSync(storeFile, JSON.stringify(stored))
    main = loadMain(ENTRY, { electron })
    const groups = await main.automations.automationEnhancementGroups(created.id)
    assert.deepEqual(groups.map((group) => group.contentIds.length), [7, 1])
    const group = groups[0]
    const pending = main.automations.enhanceAutomationBatch(created.id, group.contentIds.slice(0, 5), group.key)
    await started
    assert.throws(() => main.automations.updateAutomationContent(created.id, group.contentIds[0], { title: 'Change', caption: 'Change' }), /current post/)
    await main.automations.runAutomation(created.id)
    assert.equal(main.automations.listAutomations()[0].lastRunAt, null, 'whole batch is reserved from publishing')
    releaseSearch()
    const first = await pending
    assert.equal(first.completed, 5); assert.deepEqual(first.errors, [])
    assert.equal(searches, 1)
    assert.deepEqual(writing.map((ids) => ids.length), [5, 1], 'only the cross-contaminated clip is retried')
    assert.equal(writing[1][0], group.contentIds[2])
    assert.ok(first.automations[0].content.slice(0, 5).every((item) => item.metadataDraft && item.title === 'Topic'))
    const stale = await main.automations.enhanceAutomationBatch(created.id, [group.contentIds[0], groups[1].contentIds[0]], group.key)
    assert.equal(stale.skipped, 1)
    assert.match(stale.errors[0].message, /source context changed/)
    assert.equal(searches, 1)
    main = loadMain(ENTRY, { electron })
    const second = await main.automations.enhanceAutomationBatch(created.id, group.contentIds.slice(5), group.key)
    assert.equal(second.completed, 2)
    assert.equal(searches, 1, 'persisted research is reused after restart')
    assert.equal(second.automations[0].content[5].metadataDraft.research.reused, true)
    assert.equal(writing[2].length, 2)
    await main.automations.enhanceAutomationBatch(created.id, groups[1].contentIds, groups[1].key)
    assert.equal(searches, 2, 'same title on a different video does not share research')
    const item = main.automations.listAutomations()[0].content[0]
    main.automations.resolveAutomationMetadataDraft(created.id, item.id, item.metadataDraft.id, false)
    await main.automations.enhanceAutomationContent(created.id, item.id, { source: { ...SOURCE, description: 'Corrected source context' }, research: true })
    assert.equal(searches, 3, 'edited source descriptions invalidate the context fingerprint')
    assert.equal(main.automations.listAutomations()[0].content[0].status, 'queued')
  } finally {
    releaseSearch?.()
    if (previous === undefined) delete process.env.BRIDGECLIP_E2E_OPENROUTER_URL; else process.env.BRIDGECLIP_E2E_OPENROUTER_URL = previous
    await mock.close(); cleanup()
  }
})

test('omitted batch entries fall back independently without relaxing transcript evidence checks', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-batch-repair-')
  const calls = []
  const mock = await createMockZernio({ extraRoutes: [{ method: 'POST', path: '/chat', auth: false, handler: (ctx) => {
    const input = JSON.parse(ctx.body.messages[1].content)
    calls.push(input)
    const post = (evidence) => ({ platform: 'youtube', title: 'Reliable transcripts', caption: 'Reliable transcripts matter.', evidence, tags: [], categoryId: '28', topicTag: null })
    if (input.clips) return ctx.json(200, { choices: [{ message: { content: JSON.stringify({ clips: calls.length === 1 ? [{ id: input.clips[0].id, posts: [post(input.clips[0].transcript)] }] : [] }) } }] })
    ctx.json(200, { choices: [{ message: { content: JSON.stringify({ posts: [post(input.title === 'permanently invalid' ? 'Evidence that is never in any clip' : input.evidenceOptions[0])] }) } }] })
  } }] })
  const previous = process.env.BRIDGECLIP_E2E_OPENROUTER_URL
  process.env.BRIDGECLIP_E2E_OPENROUTER_URL = `${mock.url}/chat`
  try {
    const main = loadMain("export * as metadata from './src/main/automation-metadata'; export * as settings from './src/main/settings-store'", { electron: fakeElectron(dir).electron })
    main.settings.replaceApiKey('openrouterApiKey', 'test-only')
    const clips = ['valid in batch', 'valid in isolation', 'permanently invalid'].map((title, i) => ({ id: `clip-${i}`, title, transcript: `You know, l- like, uh, an independent phrase for clip number ${i}.`, notes: '', facebookFormat: 'feed' }))
    const result = await main.metadata.generateAutomationMetadataBatch(clips, ['youtube'], { source: SOURCE, guidance: 'Explain the topic simply for developers.', research: { status: 'complete', summary: 'Shared context', sources: [] } })
    assert.deepEqual([...result.posts.keys()], ['clip-0', 'clip-1'])
    assert.match(result.errors.get('clip-2'), /not grounded/)
    assert.deepEqual(calls.filter((call) => call.clips).map((call) => call.clips.map((clip) => clip.id)), [['clip-0', 'clip-1', 'clip-2'], ['clip-1', 'clip-2']])
    assert.ok(calls.filter((call) => !call.clips).every((call) => call.title !== 'valid in batch'))
    assert.ok(calls.every((call) => call.enhancementGuidance === 'Explain the topic simply for developers.'), 'guidance survives batch repairs and isolated fallback')
    assert.ok(calls.every((call) => call.sourceContext.description === SOURCE.description && call.research.summary === 'Shared context'))
    for (const call of calls) for (const clip of call.clips ?? [call]) {
      assert.ok(clip.evidenceOptions.length)
      assert.ok(clip.evidenceOptions.every((excerpt) => clip.transcript.includes(excerpt)), 'excerpt choices preserve fillers and false starts verbatim')
    }
  } finally {
    if (previous === undefined) delete process.env.BRIDGECLIP_E2E_OPENROUTER_URL; else process.env.BRIDGECLIP_E2E_OPENROUTER_URL = previous
    await mock.close(); cleanup()
  }
})
