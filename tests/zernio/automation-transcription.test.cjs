'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { loadMain, tempDir, fakeElectron, ROOT } = require('./support/load-main.cjs')
const { createMockZernio } = require('./support/mock-zernio.cjs')

test('automation transcription retries temporary provider failures without blaming playable audio', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-speech-recovery-')
  let replies = []; let requests = []
  const mock = await createMockZernio({ extraRoutes: [{ method: 'POST', path: '/speech', auth: false, handler: (ctx) => {
    requests.push(ctx.body)
    const reply = replies.shift() ?? 'success'
    if (reply === 'disconnect') return ctx.res.destroy()
    if (reply === 'empty') return ctx.json(200, { text: '' })
    if (reply === 'malformed') return ctx.text(200, 'not json')
    if (reply === 'rate-limit') return ctx.json(429, {}, { 'Retry-After': '60' })
    if (typeof reply === 'number') return ctx.json(reply, {})
    ctx.json(200, { text: 'AI tools can help developers test their software.' })
  } }] })
  const previous = process.env.BRIDGECLIP_E2E_TRANSCRIPTION_URL
  process.env.BRIDGECLIP_E2E_TRANSCRIPTION_URL = `${mock.url}/speech`
  try {
    const clip = path.join(dir, 'speech.mp4')
    const ffmpeg = fs.existsSync(path.join(ROOT, 'engine-bin/ffmpeg')) ? path.join(ROOT, 'engine-bin/ffmpeg') : 'ffmpeg'
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=32x32:d=1:r=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-shortest', '-c:v', 'mpeg4', '-c:a', 'aac', clip])
    const main = loadMain("export { transcribeAutomationClip } from './src/main/automation-metadata'; export * as settings from './src/main/settings-store'", { electron: fakeElectron(dir).electron })
    main.settings.replaceApiKey('openrouterApiKey', 'test-only')
    for (const scenario of [
      { replies: ['disconnect', 503, 'success'], count: 3 },
      { replies: ['empty', 'malformed', 'success'], count: 3 },
      { replies: [401], count: 1, error: /rejected the API key/ },
      { replies: [400], count: 1, error: /rejected the transcription request/ },
      { replies: ['rate-limit'], count: 1, error: /rate limiting/ },
      { replies: ['disconnect', 'disconnect', 'disconnect'], count: 3, error: /OpenRouter transcription could not be reached after retrying/ },
      { replies: ['empty', 'empty', 'empty'], count: 3, error: /No speech was returned after retrying/ }
    ]) {
      replies = [...scenario.replies]; requests = []
      if (scenario.error) await assert.rejects(main.transcribeAutomationClip(clip), scenario.error)
      else assert.equal(await main.transcribeAutomationClip(clip), 'AI tools can help developers test their software.')
      assert.equal(requests.length, scenario.count, JSON.stringify(scenario))
      const wav = Buffer.from(requests[0].input_audio.data, 'base64')
      assert.equal(wav.subarray(0, 4).toString(), 'RIFF', 'the request contains decoded audio')
      assert.ok(wav.length > 1000)
      assert.ok(requests.every((request) => request.input_audio.data === requests[0].input_audio.data), 'retries reuse the same decoded audio')
    }
  } finally {
    if (previous === undefined) delete process.env.BRIDGECLIP_E2E_TRANSCRIPTION_URL
    else process.env.BRIDGECLIP_E2E_TRANSCRIPTION_URL = previous
    await mock.close(); cleanup()
  }
})
