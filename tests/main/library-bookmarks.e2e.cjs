const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { buildApp, launchApp, ROOT } = require('../zernio/support/electron-app.cjs')

async function setupLibrary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-bookmarks-'))
  const userDataDir = path.join(root, 'user-data'), library = path.join(userDataDir, 'BridgeClip')
  const titles = ['A better morning', 'The creative process', 'Small ideas, big changes', 'Behind the scenes', 'Finding your focus', 'The long conversation']
  const video = path.join(root, 'sample.mp4')
  execFileSync(path.join(ROOT, 'engine-bin/ffmpeg'), ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10:duration=1', '-c:v', 'mpeg4', video])
  const runs = titles.map((title, index) => {
    const jobId = `${String(index + 1).repeat(8)}-1111-4111-8111-111111111111`
    const dir = path.join(library, jobId)
    fs.mkdirSync(dir, { recursive: true })
    const clip = path.join(dir, 'clip.mp4')
    fs.copyFileSync(video, clip)
    fs.writeFileSync(path.join(dir, 'run-history.json'), JSON.stringify({ jobId, sourceLabel: title, status: 'completed', errorMessage: null, startedAt: `2026-09-${20 - index}T12:00:00.000Z`, finishedAt: `2026-09-${20 - index}T12:01:00.000Z` }))
    fs.writeFileSync(path.join(dir, 'job_output.json'), JSON.stringify({ job_id: jobId, source_video_title: title, source_video_url: 'local.mp4', source_video_duration_seconds: 1,
      total_clips: 1, clips: [{ clip_index: 0, summary: title, s3_url: clip, duration_ms: 1000, start_time_ms: 0, end_time_ms: 1000, virality_score: 90 }] }))
    return dir
  })
  const session = await launchApp({ appDir: buildApp(path.join(root, 'app')), userDataDir })
  t.after(async () => { await session.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const { app, page } = session
  page.setDefaultTimeout(10000)
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 1020))
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  return { app, page, titles, runs, errors }
}

test('Library bookmarks move existing cards, preserve thumbnails, persist and recover from failed writes', { timeout: 90000 }, async t => {
  const { app, page, titles, runs, errors } = await setupLibrary(t)
  await page.getByRole('button', { name: 'Library', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.library-run-slot img').length === 12)
  const card = title => page.locator('article').filter({ has: page.getByRole('button', { name: `Open ${title}`, exact: true }) })
  const bookmark = title => card(title).getByRole('button', { name: `Bookmark ${title}`, exact: true })
  const unbookmark = title => card(title).getByRole('button', { name: `Remove bookmark from ${title}`, exact: true })
  const settled = () => page.waitForFunction(() => !Array.from(document.querySelectorAll('[data-library-layout]')).some(el => el.getAnimations().some(a => a.playState === 'running')))
  const saved = title => page.waitForFunction(title => {
    const card = Array.from(document.querySelectorAll('article')).find(el => el.querySelector(`[aria-label="Open ${title}"]`))
    return card?.querySelector('.library-bookmark')?.getAttribute('aria-disabled') !== 'true'
  }, title)
  await page.evaluate(() => { window.bookmarkNodes = Array.from(document.querySelectorAll('.library-run-slot')).map(slot => ({ slot, image: slot.querySelector('img') })) })
  const stableMedia = async () => assert.equal(await page.evaluate(() => window.bookmarkNodes.every(({ slot, image }) => slot.isConnected && image.isConnected && slot.querySelector('img') === image)), true, 'Reordering never remounts a card or clears its thumbnail')
  assert.equal(await page.getByRole('heading', { name: 'Bookmarked', exact: true }).count(), 0)
  await bookmark(titles[4]).focus()
  await page.keyboard.press('Enter')
  await page.getByRole('heading', { name: 'Bookmarked', exact: true }).waitFor()
  assert.ok(await page.locator('[data-library-layout]').evaluateAll(nodes => nodes.some(node => node.getAnimations().length)), 'Cards animate to their new positions')
  await settled(); await saved(titles[4]); await stableMedia()
  assert.equal(await unbookmark(titles[4]).evaluate(el => el === document.activeElement), true, 'Keyboard focus follows the same card')
  assert.equal(await page.locator('.library-run-slot').first().getAttribute('data-bookmarked'), 'true')
  assert.ok(fs.existsSync(path.join(runs[4], '.bridgeclip-favorite')))
  // A second bookmark moves into the existing section while the first stays mounted.
  await bookmark(titles[1]).click()
  await settled(); await saved(titles[1]); await stableMedia()
  assert.deepEqual(await page.locator('.library-run-slot[data-bookmarked=true] article > button').evaluateAll(nodes => nodes.map(el => el.getAttribute('aria-label'))), [`Open ${titles[1]}`, `Open ${titles[4]}`])
  if (process.env.BRIDGECLIP_E2E_SHOTS) {
    fs.mkdirSync(process.env.BRIDGECLIP_E2E_SHOTS, { recursive: true })
    await page.mouse.move(0, 0)
    await page.screenshot({ path: path.join(process.env.BRIDGECLIP_E2E_SHOTS, 'library-bookmarks.png') })
  }
  await unbookmark(titles[1]).click(); await settled(); await saved(titles[1])
  await unbookmark(titles[4]).click(); await settled(); await saved(titles[4]); await stableMedia()
  assert.equal(await page.getByRole('heading', { name: 'Bookmarked', exact: true }).count(), 0)
  assert.deepEqual(await page.locator('.library-run-slot article > button').evaluateAll(nodes => nodes.map(el => el.getAttribute('aria-label'))), titles.map(title => `Open ${title}`))
  // New actions can interrupt an in-flight rearrangement without losing cards.
  await page.evaluate(titles => {
    document.querySelector(`[aria-label="Bookmark ${titles[2]}"]`).click()
    document.querySelector(`[aria-label="Bookmark ${titles[5]}"]`).click()
  }, titles)
  await saved(titles[2]); await saved(titles[5])
  await unbookmark(titles[2]).evaluate(el => el.click())
  await saved(titles[2]); await settled(); await stableMedia()
  assert.equal(await page.locator('.library-run-slot').count(), titles.length)
  await unbookmark(titles[5]).click(); await saved(titles[5]); await settled()
  // A single filtered card has nowhere to move: only its bookmark responds.
  await page.getByRole('textbox', { name: 'Search runs' }).fill(titles[0])
  const singleImage = await card(titles[0]).locator('img').first().elementHandle()
  await bookmark(titles[0]).click(); await saved(titles[0])
  assert.equal(await card(titles[0]).locator('img').first().evaluate((el, old) => el === old, singleImage), true)
  assert.equal(await page.locator('.library-run-slot').evaluateAll(nodes => nodes.some(node => node.getAnimations().length)), false, 'A stationary card does not flash or animate')
  await page.getByRole('textbox', { name: 'Search runs' }).fill('')
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await unbookmark(titles[0]).waitFor()
  assert.ok(fs.existsSync(path.join(runs[0], '.bridgeclip-favorite')))
  // Reduced motion disables layout travel and the icon pulse.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await bookmark(titles[3]).click(); await saved(titles[3])
  assert.equal(await page.locator('[data-library-layout]').evaluateAll(nodes => nodes.some(node => node.getAnimations({ subtree: true }).some(a => a.playState === 'running'))), false)
  // A failed write rolls back the optimistic bookmark, keeping the card usable.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('history:setFavorite')
    ipcMain.handle('history:setFavorite', async () => { await new Promise(resolve => setTimeout(resolve, 150)); throw new Error('Bookmark storage is unavailable') })
  })
  await bookmark(titles[2]).click()
  await unbookmark(titles[2]).waitFor()
  await page.getByRole('alert').filter({ hasText: 'Bookmark storage is unavailable' }).waitFor()
  await bookmark(titles[2]).waitFor()
  assert.equal(fs.existsSync(path.join(runs[2], '.bridgeclip-favorite')), false)
  assert.deepEqual(errors, [])
})


test('Library reloads preserve pending bookmarks and ignore stale reads after a save or rollback', { timeout: 90000 }, async t => {
  const { app, page, titles, runs, errors } = await setupLibrary(t)
  await page.getByRole('button', { name: 'Library', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.library-run-slot img').length === 12)
  const initial = await page.evaluate(() => window.bridgeclip.history.list())
  await page.emulateMedia({ reducedMotion: 'reduce' })
  // Control both IPC completions so each ordering is covered without timing sleeps.
  await app.evaluate(({ ipcMain }, entries) => {
    globalThis.libraryEntries = entries
    ipcMain.removeHandler('history:list')
    ipcMain.handle('history:list', () => {
      const snapshot = structuredClone(globalThis.libraryEntries)
      return new Promise(resolve => { globalThis.finishList = () => resolve(snapshot) })
    })
    ipcMain.removeHandler('history:setFavorite')
    ipcMain.handle('history:setFavorite', (_event, dir, favorite) => new Promise((resolve, reject) => {
      globalThis.finishBookmark = success => {
        if (!success) return reject(new Error('Bookmark storage is unavailable'))
        globalThis.libraryEntries = globalThis.libraryEntries.map(entry => entry.outputDir === dir ? { ...entry, favorite } : entry)
        resolve(favorite)
      }
    }))
  }, initial)
  const control = page.locator('article').filter({ has: page.getByRole('button', { name: `Open ${titles[0]}`, exact: true }) }).locator('.library-bookmark')
  for (const [favorite, success, listFirst] of [[true, true, true], [false, true, false], [true, false, true], [true, false, false]]) {
    await control.click()
    assert.equal(await control.getAttribute('aria-pressed'), String(favorite))
    await page.getByRole('button', { name: `Open ${titles[1]}`, exact: true }).click()
    await page.locator('#page-scroll').getByRole('button', { name: 'Library', exact: true }).click()
    await control.waitFor()
    await page.waitForFunction(() => document.querySelector('[aria-label="Refresh"]')?.disabled)
    // Confirm the reload reached main before releasing either operation.
    await page.evaluate(() => window.bridgeclip.settings.load())
    assert.equal(await app.evaluate(() => typeof globalThis.finishList), 'function')
    if (listFirst) {
      await app.evaluate(() => { globalThis.finishList(); globalThis.finishList = null })
      await page.waitForFunction(() => document.querySelector('[aria-label="Refresh"] svg')?.classList.contains('animate-spin') === false)
      assert.equal(await control.getAttribute('aria-pressed'), String(favorite), 'Reload retains the pending optimistic value')
    }
    if (success) {
      const marker = path.join(runs[0], '.bridgeclip-favorite')
      if (favorite) fs.writeFileSync(marker, '')
      else fs.unlinkSync(marker)
    }
    await app.evaluate((_electron, success) => globalThis.finishBookmark(success), success)
    await page.waitForFunction(title => document.querySelector(`[aria-label="Open ${title}"]`)?.disabled === false, titles[0])
    if (!listFirst) {
      await app.evaluate(() => { globalThis.finishList(); globalThis.finishList = null })
      // A renderer IPC round trip lets the previously released list handler finish.
      await page.evaluate(() => window.bridgeclip.settings.load())
    }
    assert.equal(await control.getAttribute('aria-pressed'), String(success ? favorite : !favorite), JSON.stringify({ favorite, success, listFirst, status: await page.getByRole('status').allTextContents(), alert: await page.getByRole('alert').allTextContents() }))
    assert.equal(fs.existsSync(path.join(runs[0], '.bridgeclip-favorite')), success ? favorite : !favorite)
    if (!success) await page.getByRole('alert').filter({ hasText: 'Bookmark storage is unavailable' }).waitFor()
  }
  assert.deepEqual(errors, [])
})

test('Library Refresh retries failed previews without resetting healthy images on bookmark changes', { timeout: 90000 }, async t => {
  const { app, page, titles, runs, errors } = await setupLibrary(t)
  const thumbnail = await page.evaluate(clip => window.bridgeclip.thumbnails.generate(clip), path.join(runs[0], 'clip.mp4'))
  assert.ok(thumbnail)
  await app.evaluate(({ ipcMain }, thumbnail) => {
    globalThis.thumbnailCalls = 0
    globalThis.retryPreviews = false
    ipcMain.removeHandler('thumbnails:generate')
    ipcMain.handle('thumbnails:generate', () => { globalThis.thumbnailCalls++; return globalThis.retryPreviews ? thumbnail : null })
  }, thumbnail)
  await page.getByRole('button', { name: 'Library', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.library-run-slot').length === 6)
  // Poll the controlled main-process counter until all failed requests finish.
  for (let i = 0; i < 100 && await app.evaluate(() => globalThis.thumbnailCalls) < 6; i++) await page.waitForTimeout(20)
  assert.equal(await app.evaluate(() => globalThis.thumbnailCalls), 6)
  assert.equal(await page.locator('.library-run-slot img').count(), 0)
  await app.evaluate(() => { globalThis.retryPreviews = true })
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.library-run-slot img').length === 12)
  assert.equal(await app.evaluate(() => globalThis.thumbnailCalls), 12)
  const image = await page.locator('.library-run-slot img').first().elementHandle()
  await page.getByRole('button', { name: `Bookmark ${titles[0]}`, exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Bookmarked' }).waitFor()
  assert.equal(await image.evaluate(el => el.isConnected), true)
  assert.equal(await app.evaluate(() => globalThis.thumbnailCalls), 12, 'Bookmark-only changes do not reload previews')
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('[aria-label="Refresh"]')?.disabled)
  assert.equal(await image.evaluate(el => el.isConnected), true, 'Refresh keeps a healthy thumbnail visible')
  assert.deepEqual(errors, [])
})
