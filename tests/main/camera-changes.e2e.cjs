const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { buildApp, launchApp, ROOT } = require('../zernio/support/electron-app.cjs')
const fixture = require('../fixtures/editor/project.json')

test('camera scanning, exact frame edits, dismissals and Space playback survive reopening', { timeout: 180000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-camera-e2e-'))
  const userDataDir = path.join(root, 'user-data'), library = path.join(userDataDir, 'BridgeClip'), run = path.join(library, 'camera-run')
  fs.mkdirSync(run, { recursive: true })
  const ffmpeg = path.join(ROOT, 'engine-bin/ffmpeg')
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', "color=red:s=320x180:r=24000/1001:d=5,drawbox=x=0:y=0:w=iw:h=ih:color=blue:t=fill:enable='gte(n,37)',drawbox=x=0:y=0:w=iw:h=ih:color=green:t=fill:enable='gte(n,73)'",
    '-c:v', process.platform === 'darwin' ? 'h264_videotoolbox' : 'libx264', '-pix_fmt', 'yuv420p', path.join(run, 'editor-source.mp4')])
  fs.copyFileSync(path.join(run, 'editor-source.mp4'), path.join(run, 'editor-preview.mp4'))
  const project = structuredClone(fixture)
  project.width = 320; project.height = 180; project.duration_ms = 5005; project.transcript = []
  project.candidates = [project.candidates[0]]
  Object.assign(project.candidates[0], { ranges: [[0, 4950]], scenes: [{ at_ms: 0, layout: 'fill', crops: [[0, 0, .3164, 1]] }], caption_edits: [], review: null, status: 'ready' })
  fs.writeFileSync(path.join(run, 'editor-project.json'), JSON.stringify(project))
  fs.writeFileSync(path.join(run, 'job_output.json'), JSON.stringify({ job_id: 'camera-run', source_video_title: 'Camera fixture', source_video_url: 'local.mp4', source_video_duration_seconds: 5, clips: [], total_clips: 0, editor_project: true }))
  fs.writeFileSync(path.join(userDataDir, 'settings.json'), JSON.stringify({ version: 6, outputDirectory: library, pythonPath: path.join(ROOT, 'engine/.venv/bin/python'), openrouterApiKey: '', zernioApiKey: '' }))
  const appDir = buildApp(path.join(root, 'app'))
  for (const dir of ['engine', 'bridge', 'engine-bin']) fs.symlinkSync(path.join(ROOT, dir), path.join(appDir, dir), 'junction')
  const session = await launchApp({ appDir, userDataDir })
  t.after(async () => {
    if (process.env.BRIDGECLIP_E2E_SHOTS) { fs.mkdirSync(process.env.BRIDGECLIP_E2E_SHOTS, { recursive: true }); await session.page.screenshot({ path: path.join(process.env.BRIDGECLIP_E2E_SHOTS, 'camera-final.png') }).catch(() => {}) }
    const timer = setTimeout(() => session.app.process().kill('SIGTERM'), 5000)
    try { await session.close() } finally { clearTimeout(timer); fs.rmSync(root, { recursive: true, force: true }) }
  })
  const { app, page } = session
  page.setDefaultTimeout(15000)
  const errors = []; page.on('pageerror', (e) => errors.push(e.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 1100))
  await page.getByRole('button', { name: 'Library', exact: true }).first().click()
  const card = page.locator('article').filter({ has: page.getByRole('button', { name: 'Open Camera fixture', exact: true }) })
  await card.getByRole('button', { name: 'Open Camera fixture', exact: true }).click()
  await page.getByRole('region', { name: 'Clip editor', exact: true }).waitFor()
  await page.waitForFunction(() => document.querySelector('.editor-source-frame video')?.readyState >= 2)
  const reviewSpeed = page.getByRole('combobox', { name: 'Review speed', exact: true })
  assert.deepEqual(await reviewSpeed.locator('option').allTextContents(), ['1×', '1.5×', '2×', '3×'])
  const beforeReview = fs.readFileSync(path.join(run, 'editor-project.json'), 'utf8')
  for (const speed of [1.5, 2, 3, 1]) {
    await reviewSpeed.selectOption(String(speed))
    await page.waitForFunction((rate) => document.querySelector('video').playbackRate === rate, speed * project.candidates[0].video_speed)
  }
  // Speed shortcuts work after scrubbing without starting playback or editing the clip.
  await page.locator('.editor-fine-scrub').focus()
  for (const speed of [2, 3, 1]) {
    await page.keyboard.press(String(speed))
    assert.equal(await reviewSpeed.inputValue(), String(speed))
    assert.equal(await page.locator('video').evaluate((v) => v.paused), true)
    await page.waitForFunction((rate) => document.querySelector('video').playbackRate === rate, speed * project.candidates[0].video_speed)
  }
  for (const timeline of ['.editor-fine-scrub', '.editor-source-scrub']) {
    await page.locator(timeline).focus()
    for (const speed of [3, 2, 1]) {
      await page.keyboard.press(String(speed))
      const before = await page.locator('video').evaluate((v) => v.currentTime * 1000)
      await page.keyboard.press('ArrowRight')
      const after = await page.locator('video').evaluate((v) => v.currentTime * 1000)
      assert.ok(Math.abs(after - before - speed * 1000 / 30) < .01, `${timeline} at ${speed}×: got ${after - before}ms`)
      await page.keyboard.press('ArrowLeft')
      assert.ok(Math.abs(await page.locator('video').evaluate((v) => v.currentTime * 1000) - before) < .01)
    }
  }
  await page.locator('.editor-fine-scrub').focus()
  // Exercise the editor's capture handler without invoking app-wide Cmd/Ctrl+2 navigation.
  for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }]) {
    await page.locator('.editor-fine-scrub').dispatchEvent('keydown', { key: '2', code: 'Digit2', bubbles: false, ...modifiers })
    assert.equal(await reviewSpeed.inputValue(), '1')
  }
  await reviewSpeed.selectOption('1.5')
  await page.keyboard.press('Space')
  await page.waitForFunction(() => !document.querySelector('video').paused)
  await page.keyboard.press('3')
  assert.equal(await reviewSpeed.inputValue(), '3')
  await page.waitForFunction(() => document.querySelector('video').playbackRate === 3.75)
  assert.equal(await page.locator('video').evaluate((v) => v.paused), false)
  await page.keyboard.press('Space')
  await page.waitForFunction(() => document.querySelector('video').paused)
  assert.equal(fs.readFileSync(path.join(run, 'editor-project.json'), 'utf8'), beforeReview, 'Review speed never modifies export settings or Ready status')
  // Playhead and native thumb centers must agree near both edges and the middle.
  const assertAligned = async () => {
    const geometry = await page.evaluate(() => {
      const input = document.querySelector('.editor-fine-scrub'), line = document.querySelector('.editor-playhead')
      const r = input.getBoundingClientRect(), l = line.getBoundingClientRect()
      const fraction = (Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min))
      return { handle: r.left + 8 + fraction * (r.width - 16), line: l.left + l.width / 2 }
    })
    assert.ok(Math.abs(geometry.handle - geometry.line) < .1, JSON.stringify(geometry))
  }
  for (const fraction of [.01, .5, .99]) {
    await page.locator('.editor-fine-scrub').evaluate((input, fraction) => {
      const value = Number(input.min) + fraction * (Number(input.max) - Number(input.min))
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(value))
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }, fraction)
    await assertAligned()
  }
  const scanButton = page.getByRole('button', { name: 'Find camera changes', exact: true })
  assert.equal(await scanButton.innerText(), '', 'Scan action is icon-only')
  for (const [button, help] of [
    [scanButton, 'choose sensitivity and scan for suggested camera cuts'],
    [page.getByRole('button', { name: 'Undo', exact: true }), 'Undo the last editor change'],
    [page.getByRole('button', { name: 'Redo', exact: true }), 'Redo the change you just undid']
  ]) {
    assert.equal(await button.getAttribute('title'), '', 'Custom tooltips suppress native button titles')
    assert.equal(await button.evaluate(el => el.parentElement.getAttribute('title')), '', 'The wrapper blocks inherited native titles')
    await button.hover()
    await page.getByRole('tooltip').filter({ hasText: help }).waitFor()
    await page.mouse.move(0, 0)
    await page.getByRole('tooltip').waitFor({ state: 'hidden' })
  }
  const splitButton = page.locator('.editor-timeline-tools').getByRole('button', { name: 'Split', exact: true })
  await splitButton.focus()
  await page.getByRole('tooltip').filter({ hasText: 'No footage is removed' }).waitFor()
  if (process.env.BRIDGECLIP_E2E_SHOTS) {
    fs.mkdirSync(process.env.BRIDGECLIP_E2E_SHOTS, { recursive: true })
    await page.screenshot({ path: path.join(process.env.BRIDGECLIP_E2E_SHOTS, 'editor-tooltip.png') })
  }
  await page.keyboard.press('Escape')
  await page.getByRole('tooltip').waitFor({ state: 'hidden' })

  assert.equal(await page.getByRole('combobox', { name: 'Camera detection sensitivity' }).count(), 0)
  assert.equal(await page.locator('.editor-camera-changes').count(), 0, 'No scan row before there are results')
  await scanButton.focus()
  await page.keyboard.press('Space')
  const scanDialog = page.getByRole('dialog', { name: 'Find camera changes', exact: true })
  const sensitivity = scanDialog.getByRole('combobox', { name: 'Camera detection sensitivity' })
  assert.equal(await sensitivity.innerText(), 'Balanced')
  await page.keyboard.press('Shift+Tab')
  assert.equal(await scanDialog.getByRole('button', { name: 'Scan clip', exact: true }).evaluate(el => el === document.activeElement), true)
  await page.keyboard.press('s')
  assert.equal(await page.locator('.editor-timeline-piece').count(), 1, 'Dialog keys do not edit the timeline')
  await page.keyboard.press('Tab')
  assert.equal(await sensitivity.evaluate(el => el === document.activeElement), true)
  await sensitivity.click()
  await scanDialog.getByRole('option', { name: 'More sensitive', exact: true }).click()
  await scanDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.equal(JSON.parse(fs.readFileSync(path.join(run, 'editor-project.json'), 'utf8')).candidates[0].camera_scan, undefined, 'Opening and cancelling does not scan')
  assert.equal(await scanButton.evaluate(el => el === document.activeElement), true)
  await scanButton.click()
  assert.equal(await sensitivity.innerText(), 'Balanced', 'Cancel discards the pending sensitivity')
  await page.keyboard.press('Escape')
  assert.equal(await scanDialog.count(), 0)
  await scanButton.click()
  await sensitivity.click()
  await scanDialog.getByRole('option', { name: 'More sensitive', exact: true }).click()
  if (process.env.BRIDGECLIP_E2E_SHOTS) {
    fs.mkdirSync(process.env.BRIDGECLIP_E2E_SHOTS, { recursive: true })
    await page.screenshot({ path: path.join(process.env.BRIDGECLIP_E2E_SHOTS, 'camera-scan-dialog.png') })
  }
  await scanDialog.getByRole('button', { name: 'Scan clip', exact: true }).click()
  await page.getByRole('progressbar').waitFor()
  assert.equal(await page.getByRole('progressbar').getAttribute('max'), '100')
  await page.getByText('Scan complete.', { exact: false }).waitFor({ timeout: 60000 })
  assert.equal(await reviewSpeed.inputValue(), '3')
  await page.waitForFunction(() => document.querySelector('video').playbackRate === 3.75)
  await page.getByRole('button', { name: 'Rescan camera changes', exact: true }).click()
  const rescanDialog = page.getByRole('dialog', { name: 'Rescan camera changes', exact: true })
  assert.equal(await rescanDialog.getByRole('combobox', { name: 'Camera detection sensitivity' }).innerText(), 'More sensitive')
  await rescanDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await reviewSpeed.selectOption('1')
  const camera = page.getByRole('region', { name: 'Camera changes', exact: true })
  assert.equal(await camera.getByRole('button', { name: /^Camera change at/ }).count(), 2)
  assert.equal(await page.getByRole('button', { name: /^(Previous|Next) camera change$/ }).count(), 0)
  assert.equal(await page.getByText(/\d+ potential changes?/).count(), 0)
  assert.equal(await page.locator('.editor-stagebar .editor-status').innerText(), 'Ready')
  const saved = () => JSON.parse(fs.readFileSync(path.join(run, 'editor-project.json'), 'utf8'))
  const cut = saved().candidates[0].camera_scan.markers[0].at_ms
  assert.ok(Math.abs(cut - 37 * 1001 / 24) < .01)
  assert.ok(saved().preview_id)
  assert.equal(fs.existsSync(path.join(run, 'editor-preview.mp4')), false)
  await camera.getByRole('button', { name: /^Camera change at/ }).first().click()
  const markers = camera.getByRole('button', { name: /^Camera change at/ })
  const removeMarker = camera.getByRole('button', { name: 'Remove camera marker', exact: true })
  await markers.nth(1).click()
  assert.equal(await markers.first().getAttribute('aria-pressed'), 'false')
  assert.equal(await markers.nth(1).getAttribute('aria-pressed'), 'true')
  await camera.locator('.editor-camera-track').click({ position: { x: 2, y: 10 } })
  assert.equal(await removeMarker.count(), 0, 'Clicking the empty marker lane closes the actions')
  assert.equal(await camera.locator('[aria-pressed="true"]').count(), 0)
  assert.equal(await markers.count(), 2, 'Deselecting keeps the markers')
  await markers.first().click()
  await page.keyboard.press('Escape')
  assert.equal(await removeMarker.count(), 0, 'Escape deselects the marker')
  await markers.first().click()
  const mediaTime = () => page.locator('video').evaluate((v) => v.currentTime * 1000)
  assert.ok(Math.abs(await mediaTime() - cut) < .1)
  const checkFrameScrubbing = async () => {
    for (const target of ['.editor-fine-scrub', '.editor-source-scrub', '[aria-label="Play / pause"]']) {
      await page.locator(target).focus()
      for (const speed of [3, 2, 1]) {
        await page.keyboard.press(String(speed))
        await page.keyboard.press('ArrowRight')
        assert.ok(Math.abs(await mediaTime() - (37 + speed) * 1001 / 24) < .1, `${target} at ${speed}×`)
        await page.keyboard.press('ArrowLeft')
        assert.ok(Math.abs(await mediaTime() - cut) < .1)
      }
    }
  }
  await checkFrameScrubbing()
  await page.keyboard.press('3') // Dedicated buttons remain exact one-frame controls at any review speed.

  await page.getByRole('button', { name: 'Previous frame', exact: true }).click()
  await page.waitForFunction((cut) => Math.abs(document.querySelector('video').currentTime * 1000 - cut) < .1, 36 * 1001 / 24)
  await page.getByRole('button', { name: 'Next frame', exact: true }).click()
  await page.waitForFunction((cut) => Math.abs(document.querySelector('video').currentTime * 1000 - cut) < .1, cut)
  await page.keyboard.press('1')
  assert.equal(await removeMarker.count(), 0, 'Clicking the frame controls deselects the camera marker')
  await markers.first().click()
  await camera.getByRole('button', { name: 'Insert layout at cut', exact: true }).click()
  assert.equal(await removeMarker.count(), 1, 'Using marker actions keeps the selection open')
  await page.getByLabel('Horizontal crop position', { exact: true }).fill('0.5')
  await page.getByRole('button', { name: 'One frame later', exact: true }).click()
  await page.getByRole('button', { name: 'One frame earlier', exact: true }).click()
  const timelineZoom = page.getByRole('combobox', { name: 'Timeline zoom', exact: true })
  await timelineZoom.focus()
  await page.keyboard.press('Space')
  await page.getByRole('option', { name: 'Playhead', exact: false }).click()
  const timeline = page.getByRole('slider', { name: 'Fine timeline position', exact: true })
  assert.ok(Math.abs(Number(await timeline.getAttribute('min')) - (cut - 1000)) < .1)
  assert.ok(Math.abs(Number(await timeline.getAttribute('max')) - (cut + 1000)) < .1)
  await timelineZoom.click()
  await page.getByRole('option', { name: 'Full source', exact: true }).click()
  assert.equal(await timeline.getAttribute('min'), '0')
  assert.equal(await timeline.getAttribute('max'), String(project.duration_ms))
  await timelineZoom.click()
  await page.getByRole('option', { name: 'Clip', exact: true }).click()
  assert.equal(await timelineZoom.innerText(), 'Clip')
  await timelineZoom.click()
  await page.getByRole('option', { name: 'Playhead', exact: false }).click()
  await assertAligned()
  await checkFrameScrubbing()
  await page.keyboard.press('Space')
  await page.waitForFunction(() => !document.querySelector('video').paused)
  await page.keyboard.press('Space')
  await page.waitForFunction(() => document.querySelector('video').paused)
  await markers.first().click()
  await removeMarker.click()
  assert.equal(await removeMarker.count(), 0)
  await page.getByText('All changes saved', { exact: true }).waitFor()
  assert.equal(await camera.getByRole('button', { name: /^Camera change at/ }).count(), 0) // Second cut is outside the zoomed view.
  assert.deepEqual(saved().candidates[0].dismissed_camera_markers, [cut])
  const scene = saved().candidates[0].scenes[1]
  assert.equal(scene.at_ms, cut)
  assert.equal(scene.crops[0][0], .5)
  await page.getByRole('button', { name: 'Library', exact: true }).first().click()
  await card.getByRole('button', { name: 'Open Camera fixture', exact: true }).click()
  await page.getByRole('button', { name: 'Rescan camera changes', exact: true }).waitFor()
  assert.equal(await camera.getByRole('button', { name: /^Camera change at/ }).count(), 1)
  await page.getByRole('button', { name: 'Rescan camera changes', exact: true }).click()
  await page.getByRole('dialog', { name: 'Rescan camera changes', exact: true }).getByRole('button', { name: 'Restore removed markers', exact: true }).click()
  assert.equal(await page.getByRole('dialog').count(), 0)
  assert.equal(await camera.getByRole('button', { name: /^Camera change at/ }).count(), 2)
  await page.getByText('All changes saved', { exact: true }).waitFor()
  if (process.env.BRIDGECLIP_E2E_SHOTS) {
    fs.mkdirSync(process.env.BRIDGECLIP_E2E_SHOTS, { recursive: true })
    await camera.getByRole('button', { name: /^Camera change at/ }).first().click()
    await page.screenshot({ path: path.join(process.env.BRIDGECLIP_E2E_SHOTS, 'camera-editor.png') })
  }
  const title = page.getByRole('textbox', { name: 'Title', exact: true })
  const originalTitle = await title.inputValue()
  await title.focus()
  await page.keyboard.press('End')
  await page.keyboard.type('123')
  assert.equal(await reviewSpeed.inputValue(), '1', 'Typing numbers in a field must not change speed')
  assert.ok((await title.inputValue()).includes('123'))
  await title.fill(originalTitle)
  await page.getByText('All changes saved', { exact: true }).waitFor()
  assert.deepEqual(errors, [])
})

// The frame list is intentionally narrower than the source. Reaching its end
// (including normal playback stopping at the clip end) must never trap navigation.
test('timeline seeking preserves playback and frame controls recover from edges', { timeout: 90000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-frame-edges-'))
  const userDataDir = path.join(root, 'user-data'), run = path.join(userDataDir, 'BridgeClip', 'edge-run')
  fs.mkdirSync(run, { recursive: true })
  const ffmpeg = fs.existsSync(path.join(ROOT, 'engine-bin/ffmpeg')) ? path.join(ROOT, 'engine-bin/ffmpeg') : 'ffmpeg'
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=5', '-c:v', process.platform === 'darwin' ? 'h264_videotoolbox' : 'libx264', '-pix_fmt', 'yuv420p', path.join(run, 'editor-source.mp4')])
  fs.copyFileSync(path.join(run, 'editor-source.mp4'), path.join(run, 'editor-preview.mp4'))
  const project = structuredClone(fixture)
  Object.assign(project, { width: 320, height: 180, duration_ms: 5000, transcript: [], frame_preview: true })
  project.candidates = project.candidates.slice(0, 1)
  Object.assign(project.candidates[0], { ranges: [[2000, 3000]], scenes: [{ at_ms: 0, layout: 'fill', crops: [[0, 0, .3164, 1]] }], caption_edits: [], review: null, status: 'ready',
    camera_scan: { start_ms: 1000, end_ms: 3000, frames: Array.from({ length: 60 }, (_, i) => Math.round((1000 + i * 1000 / 30) * 1000) / 1000), markers: [] } })
  const saved = JSON.stringify(project)
  fs.writeFileSync(path.join(run, 'editor-project.json'), saved)
  fs.writeFileSync(path.join(run, 'job_output.json'), JSON.stringify({ job_id: 'edge-run', source_video_title: 'Frame edges', clips: [], editor_project: true }))
  const session = await launchApp({ appDir: buildApp(path.join(root, 'app')), userDataDir })
  t.after(async () => { await session.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const { page } = session
  page.setDefaultTimeout(10000)
  await page.getByRole('button', { name: 'Library', exact: true }).first().click()
  await page.getByRole('button', { name: 'Open Frame edges', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2)
  const play = page.getByRole('button', { name: 'Play / pause', exact: true })
  const previous = page.getByRole('button', { name: 'Previous frame', exact: true })
  const next = page.getByRole('button', { name: 'Next frame', exact: true })
  const time = () => page.locator('video').evaluate(v => v.currentTime * 1000)
  const seek = async ms => {
    await page.locator('.editor-source-scrub').evaluate((el, ms) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(ms))
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }, ms)
    await page.waitForFunction(() => !document.querySelector('video').seeking)
  }
  for (const at of [0, 900, 1000, 2966.667, 3000, 4000, 4999]) {
    const direction = at < 2000 ? 1 : -1
    for (const target of ['.editor-source-scrub', '.editor-fine-scrub', '[aria-label="Play / pause"]']) {
      await seek(at)
      await page.locator(target).focus()
      const before = await time()
      await page.keyboard.press(direction > 0 ? 'ArrowRight' : 'ArrowLeft')
      assert.ok(((await time()) - before) * direction > 1, `arrows must recover from ${at}ms with ${target} focused`)
    }
    await seek(at)
    const before = await time()
    await (direction > 0 ? next : previous).click()
    assert.ok(((await time()) - before) * direction > 1, `frame button must recover from ${at}ms`)
  }
  // Overshooting either end with coarse arrows still permits fine recovery.
  for (const [at, outward, inward] of [[0, 'Shift+ArrowLeft', 'ArrowRight'], [4999, 'Shift+ArrowRight', 'ArrowLeft']]) {
    await seek(at); await play.focus(); await page.keyboard.press(outward)
    const before = await time()
    await page.keyboard.press(inward)
    assert.ok(Math.abs((await time()) - before) > 1)
  }
  await seek(2900)
  await play.click()
  await page.waitForFunction(() => { const v = document.querySelector('video'); return v.paused && v.currentTime >= 2.999 })
  await previous.click()
  assert.ok(await time() < 2999, 'recover after playback stops at the clip end')
  // Actual pointer clicks preserve playback on both sliders and retained cuts.
  for (const selector of ['.editor-source-scrub', '.editor-fine-scrub', '.editor-piece-body']) {
    const clickTimeline = async () => {
      const box = await page.locator(selector).boundingBox()
      const fraction = selector === '.editor-piece-body' ? .35 : .47
      await page.mouse.click(box.x + box.width * fraction, box.y + box.height / 2)
      await page.waitForFunction(() => !document.querySelector('video').seeking)
    }
    await seek(2000)
    await play.click()
    await clickTimeline()
    assert.equal(await page.locator('video').evaluate(v => v.paused), false, `${selector} must keep playing`)
    const clickedTime = await time()
    assert.ok(clickedTime > 2150 && clickedTime < 2800, `${selector} seeks to the clicked position: ${clickedTime}`)
    await page.waitForFunction(at => document.querySelector('video').currentTime * 1000 > at + 50, clickedTime)
    await previous.click()
    await seek(2000)
    await clickTimeline()
    assert.equal(await page.locator('video').evaluate(v => v.paused), true, `${selector} must stay paused`)
    assert.ok(await time() > 2150 && await time() < 2800)
  }
  assert.equal(fs.readFileSync(path.join(run, 'editor-project.json'), 'utf8'), saved, 'navigation must not change edits')
})
