'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { buildApp, launchApp, ROOT } = require('../zernio/support/electron-app.cjs')
const FFMPEG = fs.existsSync(path.join(ROOT, 'engine-bin', 'ffmpeg')) ? path.join(ROOT, 'engine-bin', 'ffmpeg') : 'ffmpeg'

test('Electron authorizes local media and supports ranges, playback and seeking', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-media-e2e-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const userDataDir = path.join(root, 'user-data')
  const library = path.join(userDataDir, 'BridgeClip')
  fs.mkdirSync(library, { recursive: true })
  const inside = path.join(library, 'clip.mp4')
  const image = path.join(library, 'frame.png')
  const outside = path.join(root, 'outside.mp4')
  fs.writeFileSync(inside, '0123456789')
  fs.writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR9sAAAAASUVORK5CYII=', 'base64'))
  fs.writeFileSync(outside, 'private')
  // Exceed Chromium's initial media buffer so playing/seeking needs another
  // range request. Tiny fixtures miss the nonstandard-protocol read failure.
  const video = path.join(library, 'Playback #1 100% café.mp4')
  execFileSync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
    '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '8',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video
  ])
  assert.ok(fs.statSync(video).size > 4 * 1024 * 1024)
  const appDir = buildApp(path.join(root, 'app'))
  const session = await launchApp({ appDir, userDataDir })
  t.after(() => session.close())
  const request = (file, range) => session.app.evaluate(async ({ net }, { file, range }) => {
    const headers = range ? { Range: range } : {}
    const response = await net.fetch(`local-file://media/${encodeURIComponent(file)}`, { headers })
    return { status: response.status, body: await response.text(), range: response.headers.get('content-range') }
  }, { file, range })
  assert.deepEqual(await request(inside, 'bytes=2-5'), { status: 206, body: '2345', range: 'bytes 2-5/10' })
  assert.equal((await request(inside, 'bytes=11-12')).status, 416)
  assert.equal((await request(outside)).status, 403)
  assert.equal(await session.page.evaluate((file) => new Promise((resolve) => {
    const image = new Image()
    image.onload = () => resolve(true)
    image.onerror = () => resolve(false)
    image.src = `local-file://media/${encodeURIComponent(file)}`
  }), image), true)

  await session.page.evaluate((file) => {
    const video = document.createElement('video')
    video.id = 'local-media-regression'
    video.controls = true
    video.muted = true
    video.preload = 'metadata'
    video.src = `local-file://media/${encodeURIComponent(file)}`
    document.body.append(video)
  }, video)
  await session.page.waitForFunction(() => document.querySelector('#local-media-regression').readyState >= 2)
  await session.page.evaluate(() => document.querySelector('#local-media-regression').play())
  await session.page.waitForFunction(() => {
    const video = document.querySelector('#local-media-regression')
    if (video.error) throw new Error(video.error.message)
    return video.currentTime > 1
  })
  // Jump beyond the preloaded data, then backwards, and verify playback keeps
  // advancing after each seek (not just that a frame can be displayed).
  for (const time of [9, 2]) {
    await session.page.evaluate((time) => {
      document.querySelector('#local-media-regression').currentTime = time
    }, time)
    await session.page.waitForFunction((time) => {
      const video = document.querySelector('#local-media-regression')
      if (video.error) throw new Error(video.error.message)
      return !video.seeking && !video.paused && video.currentTime > time + 0.5
    }, time)
  }
  await session.page.evaluate(() => document.querySelector('#local-media-regression').pause())
})
