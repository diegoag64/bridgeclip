const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { buildApp, launchApp, ROOT } = require('../zernio/support/electron-app.cjs')
const fixture = require('../fixtures/editor/project.json')

test('static subtitle guide supports dragging and undo, and persists across reopening', { timeout: 90000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-caption-position-'))
  const userDataDir = path.join(root, 'user-data'), run = path.join(userDataDir, 'BridgeClip', 'captions')
  fs.mkdirSync(run, { recursive: true })
  const ffmpeg = fs.existsSync(path.join(ROOT, 'engine-bin/ffmpeg')) ? path.join(ROOT, 'engine-bin/ffmpeg') : 'ffmpeg'
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=12', '-c:v', process.platform === 'darwin' ? 'h264_videotoolbox' : 'libx264', '-pix_fmt', 'yuv420p', path.join(run, 'editor-source.mp4')])
  fs.copyFileSync(path.join(run, 'editor-source.mp4'), path.join(run, 'editor-preview.mp4'))
  const project = structuredClone(fixture)
  project.width = 640; project.height = 360
  project.candidates[0].caption_preset = 'paper'
  project.candidates[0].caption_suppression_ranges = [[3000, 4000]]
  fs.writeFileSync(path.join(run, 'editor-project.json'), JSON.stringify(project))
  fs.writeFileSync(path.join(run, 'job_output.json'), JSON.stringify({ job_id: 'captions', source_video_title: 'Subtitle placement', clips: [], editor_project: true }))
  const session = await launchApp({ appDir: buildApp(path.join(root, 'app')), userDataDir })
  t.after(async () => { await session.page.mouse.up().catch(() => {}); await session.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const { page, app } = session
  page.setDefaultTimeout(10000)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950))
  const errors = []; page.on('pageerror', e => errors.push(e.message))
  const open = async () => {
    await page.getByRole('button', { name: 'Library', exact: true }).first().click()
    await page.getByRole('button', { name: 'Open Subtitle placement', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2)
    await page.getByRole('button', { name: 'Transcript', exact: true }).click()
  }
  const seek = async ms => {
    await page.getByRole('slider', { name: 'Source timeline', exact: true }).evaluate((el, ms) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(ms))
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }, ms)
    await page.waitForFunction(() => !document.querySelector('video').seeking)
  }
  const saved = async () => {
    await page.getByText('All changes saved', { exact: true }).waitFor()
    return JSON.parse(fs.readFileSync(path.join(run, 'editor-project.json'), 'utf8')).candidates[0]
  }
  await open()
  const overlay = page.getByRole('button', { name: 'Subtitle position', exact: true })
  await overlay.waitFor()
  const sample = async () => (await overlay.innerText()).replace(/\s+/g, ' ').trim()
  assert.equal(await sample(), 'Captions go here')
  await page.getByRole('button', { name: 'Play / pause', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('video').currentTime > 1.3)
  assert.equal(await sample(), 'Captions go here', 'sample stays steady during playback')
  await page.getByRole('button', { name: 'Play / pause', exact: true }).click()
  await page.getByRole('button', { name: 'Top', exact: true }).click()
  assert.equal((await saved()).caption_y, .2)
  assert.equal(await overlay.evaluate(el => el.style.top), '20%')
  const before = await overlay.boundingBox()
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
  await page.mouse.down()
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2 + 100, { steps: 5 })
  await page.mouse.up()
  const moved = (await saved()).caption_y
  assert.ok(moved > .3 && moved < .8)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  assert.equal((await saved()).caption_y, .2, 'one undo restores the whole drag')
  await overlay.press('ArrowDown')
  assert.equal((await saved()).caption_y, .21)
  await page.getByRole('button', { name: 'Bottom', exact: true }).click()
  assert.equal((await saved()).caption_y, .8)
  await page.getByRole('button', { name: 'Edit caption at 0:00.000', exact: true }).click()
  await page.getByRole('textbox', { name: 'Caption at 0:00.000', exact: true }).fill('A corrected subtitle')
  await seek(1000)
  assert.equal(await sample(), 'Captions go here', 'caption edits do not change the placement guide')
  await saved()
  await page.screenshot({ path: '/tmp/bridgeclip-subtitle-position.png' })
  // Switching via either candidate list preserves the inspector tab while
  // clearing the previous candidate's caption edit field.
  for (const tab of ['Transcript', 'Captions', 'Framing', 'Jev']) {
    await page.locator('.editor-tabs').getByRole('button', { name: tab, exact: true }).click()
    await page.locator('.editor-candidate').nth(1).click()
    assert.equal(await page.getByLabel('Title', { exact: true }).inputValue(), project.candidates[1].title)
    assert.equal(await page.locator('.editor-tabs').getByRole('button', { name: tab, exact: true }).getAttribute('aria-pressed'), 'true')
    await page.getByRole('textbox', { name: 'Caption at 0:00.000', exact: true }).waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: `Jump to candidate 1: ${project.candidates[0].title}`, exact: true }).click()
    assert.equal(await page.getByLabel('Title', { exact: true }).inputValue(), project.candidates[0].title)
    assert.equal(await page.locator('.editor-tabs').getByRole('button', { name: tab, exact: true }).getAttribute('aria-pressed'), 'true')
  }
  await page.locator('.editor-tabs').getByRole('button', { name: 'Transcript', exact: true }).click()
  await seek(3500)
  assert.equal(await sample(), 'Captions go here', 'guide remains available in caption-free sections')
  await seek(6500)
  assert.equal(await sample(), 'Captions go here', 'guide remains available outside retained speech')
  await page.getByRole('button', { name: 'Library', exact: true }).first().click()
  await open()
  assert.equal((await saved()).caption_y, .8)
  assert.equal(await overlay.evaluate(el => el.style.top), '80%')
  await page.getByRole('button', { name: 'Automatic', exact: true }).click()
  assert.equal((await saved()).caption_y, null)
  assert.ok(Math.abs(await overlay.evaluate(el => parseFloat(el.style.top)) - 1340 / 1920 * 100) < .001)
  await page.getByRole('switch', { name: 'Show subtitle guide' }).click()
  assert.equal(await overlay.count(), 0)
  assert.deepEqual(errors, [])
})
