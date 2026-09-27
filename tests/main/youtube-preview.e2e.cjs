const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { buildApp, launchApp } = require('../zernio/support/electron-app.cjs')

test('YouTube source card progressively loads metadata, tolerates failures and ignores removed sources', { timeout: 90000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-youtube-e2e-'))
  const session = await launchApp({ appDir: buildApp(path.join(root, 'app')), userDataDir: path.join(root, 'user-data') })
  t.after(async () => { await session.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const { app, page } = session
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await app.evaluate(({ ipcMain }) => {
    globalThis.youtubeTest = { requests: [], waiting: [], fail: false, opened: null }
    ipcMain.removeHandler('source:youtubePreview')
    ipcMain.handle('source:youtubePreview', (_event, url, details) => {
      const state = globalThis.youtubeTest
      state.requests.push({ url, details })
      if (state.fail) throw new Error('Offline')
      const title = url.includes('aqz-KE-bpKQ') ? 'Big Buck Bunny — A short film by Blender' : 'A different video with a very long title that should wrap neatly inside the selected source card'
      const summary = { title, channel: 'Blender', durationSeconds: null, viewCount: null, uploadedOn: null }
      if (details) return new Promise((resolve) => state.waiting.push(() => resolve({ ...summary, durationSeconds: 634, viewCount: 12800000, uploadedOn: '2026-09-20' })))
      return summary
    })
    ipcMain.removeHandler('shell:openPath')
    ipcMain.handle('shell:openPath', (_event, url) => { globalThis.youtubeTest.opened = url; return true })
  })
  // Deterministic thumbnail; no third-party requests or media downloads in this test.
  await page.route('https://i.ytimg.com/**', (route) => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#253b34"/><circle cx="485" cy="85" r="38" fill="#ded3a0"/><path d="M0 330 210 90 430 360M220 360 460 145 640 330V360" fill="#648172"/><text x="30" y="300" fill="#ffffff" font-family="sans-serif" font-size="34">BIG BUCK BUNNY</text></svg>' }))
  await page.reload()
  await page.getByRole('radio', { name: 'Automatic', exact: true }).click()
  const add = async (url) => {
    await page.getByPlaceholder('YouTube, Twitch VOD or direct video link').fill(url)
    await page.getByRole('button', { name: 'Use link', exact: true }).click()
  }
  const card = page.getByRole('region', { name: 'YouTube video preview' })
  const resolveDetails = () => app.evaluate(() => { for (const resolve of globalThis.youtubeTest.waiting.splice(0)) resolve() })
  await add('https://youtu.be/aqz-KE-bpKQ?t=20')
  await card.getByRole('heading', { name: 'Big Buck Bunny — A short film by Blender' }).waitFor()
  await card.getByText('Blender', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Next: Format', exact: true }).isEnabled(), true)
  assert.equal(await card.getByText('10:34', { exact: true }).count(), 0, 'summary appears before slow details')
  await resolveDetails()
  await card.getByText('10:34', { exact: true }).waitFor()
  await card.getByText('12.8M views', { exact: true }).waitFor()
  await card.locator('time[datetime="2026-09-20"]').waitFor()
  assert.equal(await card.getByText('www.youtube.com/watch', { exact: true }).count(), 0)
  await card.getByRole('button', { name: 'View on YouTube' }).click()
  assert.equal(await app.evaluate(() => globalThis.youtubeTest.opened), 'https://www.youtube.com/watch?v=aqz-KE-bpKQ')
  const artifacts = process.env.BRIDGECLIP_E2E_SHOTS
  if (artifacts) {
    fs.mkdirSync(artifacts, { recursive: true })
    await card.screenshot({ path: path.join(artifacts, 'youtube-source-card.png') })
  }
  await card.getByRole('button', { name: 'Remove video' }).click()
  await add('https://youtube.com/watch?v=abcdefghijk')
  await card.getByRole('heading', { name: /A different video/ }).waitFor()
  await card.getByRole('button', { name: 'Remove video' }).click()
  await resolveDetails()
  assert.equal(await card.count(), 0, 'late responses do not restore a removed source')
  await app.evaluate(() => { globalThis.youtubeTest.fail = true })
  await add('https://youtu.be/aqz-KE-bpKQ')
  await card.getByText('Details couldn’t load. You can still continue.', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Next: Format', exact: true }).isEnabled(), true)
  await app.evaluate(() => { globalThis.youtubeTest.fail = false })
  await card.getByRole('button', { name: 'Retry details' }).click()
  await card.getByRole('heading', { name: /Big Buck Bunny/ }).waitFor()
  await resolveDetails()
  await card.getByText('10:34', { exact: true }).waitFor()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(720, 700))
  await page.waitForFunction(() => window.innerWidth === 720 && document.documentElement.scrollWidth <= window.innerWidth)
  if (artifacts) await card.screenshot({ path: path.join(artifacts, 'youtube-source-compact.png') })
  // Broken thumbnails retain the metadata and controls.
  await card.getByRole('img', { name: 'Video thumbnail' }).dispatchEvent('error')
  await card.getByRole('img', { name: 'Video thumbnail' }).waitFor({ state: 'detached' })
  await card.getByRole('heading', { name: /Big Buck Bunny/ }).waitFor()
  await card.getByRole('button', { name: 'Remove video' }).click()
  await add('https://www.twitch.tv/videos/12345')
  await page.getByText('Public, completed videos only', { exact: true }).waitFor()
  assert.equal(await card.count(), 0)
  assert.deepEqual(errors, [])
})
