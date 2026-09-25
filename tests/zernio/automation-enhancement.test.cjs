'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { loadMain, tempDir, fakeElectron, ROOT } = require('./support/load-main.cjs')
const { createMockZernio } = require('./support/mock-zernio.cjs')
const { createPostingMock } = require('./support/mock-posts.cjs')

const SOURCE = { title: 'How reliable automations work', description: 'A long discussion about speech recognition and reliable automation workflows.', channel: 'Example channel', url: 'https://www.youtube.com/watch?v=hqP9fivmBqI' }
const TRANSCRIPT = 'Building reliable automations starts with accurate transcripts.'
const POST = { platform: 'youtube', title: 'Why Accurate Transcripts Matter for Automations', caption: 'Accurate transcripts are the foundation for reliable automations.', tags: ['speech recognition', 'automation'], categoryId: '28', topicTag: null, evidence: 'accurate transcripts' }
const entry = "export * as automations from './src/main/automations'; export * as settings from './src/main/settings-store'; export * as source from './src/main/automation-source'"

test('source URLs discard tracking parameters and reject arbitrary hosts, local paths and credentials', () => {
  const { youtubeSourceUrl, parseSourceContext } = loadMain("export * from './src/main/automation-source'", { electron: {} })
  assert.equal(youtubeSourceUrl('https://youtu.be/hqP9fivmBqI?token=secret'), SOURCE.url)
  assert.equal(youtubeSourceUrl('https://www.youtube.com/shorts/hqP9fivmBqI'), SOURCE.url)
  for (const value of ['/private/movie.mp4', 'http://127.0.0.1/a', 'https://youtube.com.evil.test/watch?v=hqP9fivmBqI', 'https://secret@youtube.com/watch?v=hqP9fivmBqI', 'https://youtube.com:8443/watch?v=hqP9fivmBqI']) assert.equal(youtubeSourceUrl(value), null)
  assert.throws(() => parseSourceContext({ ...SOURCE, description: 'x'.repeat(20001) }), /source title/)
})

test('enhancement preserves current copy until review, holds scheduling, survives restart and publishes the applied draft unchanged', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-enhancement-')
  const posting = createPostingMock()
  let writingCalls = 0; let researchCalls = 0; let speechCalls = 0
  let researchAvailable = true; let validWriting = true
  const mock = await createMockZernio({ apiKey: 'enhance-key', extraRoutes: [...posting.routes,
    { method: 'POST', path: '/speech', auth: false, handler: (ctx) => { speechCalls++; ctx.json(200, { text: TRANSCRIPT }) } },
    { method: 'POST', path: '/chat', auth: false, handler: (ctx) => {
      if (ctx.body.tools) {
        researchCalls++
        assert.deepEqual(ctx.body.tools[0], { type: 'openrouter:web_search', parameters: { engine: 'exa', max_results: 3, max_total_results: 3, max_uses: 1, max_characters: 2000 } })
        ctx.json(200, { choices: [{ message: { content: 'Clip: transcript accuracy. Broader topic: reliable workflows. Natural terms: speech recognition, automation.', annotations: researchAvailable ? [
          { type: 'url_citation', url_citation: { url: 'javascript:alert(1)', title: 'unsafe' } },
          { type: 'url_citation', url_citation: { url: 'https://example.com/docs', title: 'Speech recognition' } }
        ] : [] } }] })
      } else {
        writingCalls++
        const input = JSON.parse(ctx.body.messages[1].content)
        assert.equal(input.transcript, TRANSCRIPT)
        assert.equal(input.sourceContext.description, SOURCE.description)
        assert.equal(Boolean(input.research), researchAvailable)
        assert.match(ctx.body.messages[0].content, /transcript is the authority/)
        ctx.json(200, { choices: [{ message: { content: JSON.stringify({ posts: [{ ...POST, evidence: validWriting ? POST.evidence : 'Invented evidence from another video' }] }) } }] })
      }
    } }
  ] })
  const env = { BRIDGECLIP_ZERNIO_API_URL: mock.apiUrl, BRIDGECLIP_E2E_TRANSCRIPTION_URL: `${mock.url}/speech`, BRIDGECLIP_E2E_OPENROUTER_URL: `${mock.url}/chat`, PATH: `${process.env.PATH}${path.delimiter}${path.join(ROOT, 'engine-bin')}` }
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
  Object.assign(process.env, env)
  try {
    const { electron } = fakeElectron(dir)
    let main = loadMain(entry, { electron })
    main.settings.replaceApiKey('zernioApiKey', 'enhance-key')
    main.settings.replaceApiKey('openrouterApiKey', 'test-only')
    const library = path.join(dir, 'library'); const run = path.join(library, 'run-one'); fs.mkdirSync(run, { recursive: true })
    main.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3' })
    const clip = path.join(run, 'clip.mp4')
    const ffmpeg = fs.existsSync(path.join(ROOT, 'engine-bin/ffmpeg')) ? path.join(ROOT, 'engine-bin/ffmpeg') : 'ffmpeg'
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=360x640:d=2:r=15', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-shortest', '-c:v', 'mpeg4', '-c:a', 'aac', clip])
    fs.writeFileSync(path.join(run, 'job_output.json'), JSON.stringify({ source_video_title: SOURCE.title, source_video_description: SOURCE.description, source_video_channel: SOURCE.channel, source_video_url: `${SOURCE.url}&token=private`, clips: [{ clip_index: 0, s3_url: `file://${clip}`, duration_ms: 2000, start_time_ms: 0, end_time_ms: 2000, summary: 'Original weak title', virality_score: 0.8 }] }))
    const [created] = main.automations.createAutomation('Review first')
    const profile = mock.state.profiles[0]; const account = mock.addAccount('youtube', profile._id)
    const update = { name: created.name, enabled: false, profileId: profile._id, metadataMode: 'manual', timezone: 'UTC', times: ['12:00'], youtubeVisibility: 'unlisted', youtubeMadeForKids: false, accounts: [{ platform: 'youtube', accountId: account._id }] }
    await main.automations.updateAutomation(created.id, update)
    await main.automations.addLibraryClipsToAutomation(created.id, run, [0])
    let item = main.automations.listAutomations()[0].content[0]
    assert.deepEqual(item.sourceContext, SOURCE)
    assert.deepEqual(await main.automations.automationContentSource(created.id, item.id), SOURCE)
    await main.automations.enhanceAutomationContent(created.id, item.id, { source: SOURCE, research: true })
    item = main.automations.listAutomations()[0].content[0]
    assert.equal(item.title, 'Original weak title'); assert.equal(item.generatedMetadata, null)
    assert.equal(item.metadataDraft.research.sources.length, 1)
    assert.equal(item.metadataDraft.research.status, 'complete')
    assert.equal(posting.state.creates.length, 0)
    await main.automations.runAutomation(created.id)
    assert.match(main.automations.listAutomations()[0].lastError, /Review the next clip/)
    assert.equal(posting.state.creates.length, 0)
    assert.throws(() => main.automations.resolveAutomationMetadataDraft(created.id, item.id, 'stale-id', true), /no longer available/)
    assert.throws(() => main.automations.updateAutomationContent(created.id, item.id, { title: 'Changed', caption: 'Changed' }), /Apply or discard/)
    const instagram = mock.addAccount('instagram', profile._id)
    await main.automations.updateAutomation(created.id, { ...update, accounts: [...update.accounts, { platform: 'instagram', accountId: instagram._id }] })
    assert.throws(() => main.automations.resolveAutomationMetadataDraft(created.id, item.id, item.metadataDraft.id, true), /platforms changed/)
    await main.automations.updateAutomation(created.id, update)
    main = loadMain(entry, { electron })
    item = main.automations.listAutomations()[0].content[0]
    assert.ok(item.metadataDraft, 'draft survives restart')
    main.automations.resolveAutomationMetadataDraft(created.id, item.id, item.metadataDraft.id, true)
    item = main.automations.listAutomations()[0].content[0]
    assert.equal(item.title, POST.title); assert.equal(item.caption, POST.caption)
    assert.equal(item.metadataDraft, null)
    assert.equal(item.metadataEnhancement.research.sources.length, 1)
    const appliedCalls = writingCalls
    await main.automations.runAutomation(created.id)
    assert.equal(posting.state.creates.length, 1)
    assert.equal(writingCalls, appliedCalls, 'manual automation reuses approved AI metadata without regeneration')
    assert.equal(posting.state.creates[0].body.platforms[0].platformSpecificData.title, POST.title)
    assert.deepEqual(posting.state.creates[0].body.tags, POST.tags)
    assert.equal(posting.state.creates[0].body.platforms[0].customContent, POST.caption)
    await assert.rejects(main.automations.enhanceAutomationContent(created.id, item.id, { research: true }), /unposted queued/)

    // Legacy import recovers provenance by bytes, not just by its matching title.
    await main.automations.addAutomationContent(created.id, [clip], ['Original weak title'])
    const second = main.automations.listAutomations()[0].content[1]
    assert.equal(second.sourceContext, null)
    assert.deepEqual(await main.automations.automationContentSource(created.id, second.id), SOURCE)
    // Expire the persisted video research to exercise unavailable-search behavior.
    const storePath = fs.readdirSync(path.join(dir, 'userData')).find((name) => /^automations-.*\.json$/.test(name))
    const fullStorePath = path.join(dir, 'userData', storePath)
    const stored = JSON.parse(fs.readFileSync(fullStorePath, 'utf8'))
    stored.automations[0].sourceResearch[0].createdAt = '2000-01-01T00:00:00.000Z'
    fs.writeFileSync(fullStorePath, JSON.stringify(stored))
    main = loadMain(entry, { electron })
    researchAvailable = false
    await main.automations.enhanceAutomationContent(created.id, second.id, { research: true })
    item = main.automations.listAutomations()[0].content[1]
    assert.equal(item.metadataDraft.research.status, 'unavailable')
    const savedDraft = item.metadataDraft.id
    validWriting = false
    await assert.rejects(main.automations.enhanceAutomationContent(created.id, second.id, { research: true }), /not grounded/)
    item = main.automations.listAutomations()[0].content[1]
    assert.equal(item.metadataDraft.id, savedDraft, 'failed regeneration keeps the previous draft')
    assert.equal(item.title, 'Original weak title')
    assert.equal(speechCalls, 2, 'cached transcript is reused')
    main.automations.resolveAutomationMetadataDraft(created.id, second.id, savedDraft, false)
    assert.equal(main.automations.listAutomations()[0].content[1].title, 'Original weak title')
    assert.equal(main.automations.listAutomations()[0].content[1].metadataDraft, null)
    assert.equal(posting.state.creates.length, 1)
    assert.equal(researchCalls, 2)

    const impostor = path.join(library, 'impostor.mp4'); fs.copyFileSync(clip, impostor)
    const bytes = fs.readFileSync(impostor); bytes[bytes.length - 1] ^= 1; fs.writeFileSync(impostor, bytes)
    await main.automations.addAutomationContent(created.id, [impostor], ['Original weak title'])
    const third = main.automations.listAutomations()[0].content[2]
    assert.equal(await main.automations.automationContentSource(created.id, third.id), null, 'same title and size do not establish provenance')
    validWriting = true
    const [unconfigured] = main.automations.createAutomation('Prepare before connecting')
    await main.automations.addLibraryClipsToAutomation(unconfigured.id, run, [0])
    const unconfiguredItem = main.automations.listAutomations()[0].content[0]
    await main.automations.enhanceAutomationContent(unconfigured.id, unconfiguredItem.id, { research: false })
    const standalone = main.automations.listAutomations()[0].content[0]
    assert.deepEqual(standalone.metadataDraft.platforms, ['youtube'])
    assert.equal(standalone.metadataDraft.research.status, 'skipped')
    assert.equal(researchCalls, 2, 'research-off makes no search request')
    assert.equal(posting.state.creates.length, 1)

  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await mock.close(); cleanup()
  }
})
