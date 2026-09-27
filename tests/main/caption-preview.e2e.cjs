const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { buildApp, launchApp } = require('../zernio/support/electron-app.cjs')

test('caption styles preview word progression, support transport controls and respect reduced motion', { timeout: 90000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-caption-preview-'))
  const appDir = buildApp(path.join(root, 'app'))
  const session = await launchApp({ appDir, userDataDir: path.join(root, 'user-data') })
  t.after(async () => { await session.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const { app, page } = session
  // The test window stays hidden. Simulate a visible tab without raising it over the user's app.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false))
  await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }))
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.getByPlaceholder('YouTube, Twitch VOD or direct video link').fill('https://example.com/video.mp4')
  await page.getByRole('button', { name: 'Use link', exact: true }).click()
  const steps = page.getByRole('navigation', { name: 'Create steps' })
  await steps.getByRole('button', { name: /Captions/ }).click()
  const preview = page.getByRole('region', { name: 'Caption preview' })
  const slider = preview.getByRole('slider', { name: 'Caption preview position' })
  const presets = page.getByRole('radiogroup', { name: 'Caption style' })
  const active = () => preview.locator('[data-caption-state="active"]').evaluate((el) => el.firstChild.textContent)
  const seek = async (ms) => {
    // Native keyboard interactions also pause playback while scrubbing.
    await slider.press('End')
    await slider.press('Home')
    for (let at = 0; at < ms; at += 100) await slider.press('ArrowRight')
  }

  await preview.getByRole('button', { name: 'Pause caption preview' }).waitFor()
  const start = Number(await slider.inputValue())
  await page.waitForTimeout(750)
  assert.ok(Number(await slider.inputValue()) > start + 400, 'preview advances automatically')
  await preview.getByRole('button', { name: 'Pause caption preview' }).click()
  const paused = await slider.inputValue()
  await page.waitForTimeout(200)
  assert.equal(await slider.inputValue(), paused)

  for (const name of ['Pop', 'Spotlight', 'Impact', 'Glow', 'Boxed', 'Sweep', 'Editorial', 'Hype', 'Punch', 'Neon', 'Headline', 'Paper', 'Subtle']) {
    await presets.getByRole('radio', { name, exact: true }).click()
    await preview.getByText(`${name} preview`, { exact: true }).waitFor()
    await seek(900)
    assert.match(await active(), /^is$/i, `${name} advances to the second spoken word`)
    const words = preview.locator('[data-caption-state]')
    if (name === 'Punch') assert.equal(await words.count(), 1)
    if (name === 'Impact') {
      assert.equal(await words.count(), 2)
      await seek(1200)
      assert.match(await active(), /^how$/i)
      assert.equal(await preview.locator('[data-caption-state="future"]').evaluate((el) => getComputedStyle(el).visibility), 'hidden')
    }
    if (name === 'Editorial' || name === 'Subtle') {
      assert.ok(Number(await preview.locator('[data-caption-state="future"]').first().evaluate((el) => getComputedStyle(el).opacity)) < 1)
    }
    if (name === 'Spotlight' || name === 'Headline') {
      assert.notEqual(await preview.locator('[data-caption-state="active"]').evaluate((el) => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)')
      assert.equal(await preview.locator('[data-caption-state="past"]').evaluate((el) => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)')
    }
    if (name === 'Sweep') {
      const fill = preview.locator('[data-caption-state="active"] > span')
      assert.equal(await fill.evaluate((el) => el.style.clipPath), 'inset(0px 50% 0px 0px)')
      await slider.press('ArrowRight')
      assert.notEqual(await fill.evaluate((el) => el.style.clipPath), 'inset(0px 50% 0px 0px)')
    }
  }

  const shots = process.env.BRIDGECLIP_E2E_SHOTS
  if (shots) {
    fs.mkdirSync(shots, { recursive: true })
    await presets.getByRole('radio', { name: 'Spotlight', exact: true }).click()
    await seek(900)
    await page.screenshot({ path: path.join(shots, 'caption-preview.png') })
  }
  await slider.press('End')
  assert.equal(await preview.locator('[data-caption-state="active"]').evaluate((el) => getComputedStyle(el).visibility), 'hidden')
  await preview.getByRole('button', { name: 'Replay caption preview' }).click()
  assert.ok(Number(await slider.inputValue()) < 600)
  await preview.getByRole('button', { name: 'Pause caption preview' }).waitFor()
  await page.getByRole('switch', { name: 'Captions', exact: true }).click()
  assert.equal(await slider.isDisabled(), true)
  const disabled = await slider.inputValue()
  await page.waitForTimeout(200)
  assert.equal(await slider.inputValue(), disabled)
  await page.getByRole('switch', { name: 'Captions', exact: true }).click()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await preview.getByRole('button', { name: 'Play caption preview', exact: true }).waitFor()
  await presets.getByRole('radio', { name: 'Pop', exact: true }).click()
  await preview.getByRole('button', { name: 'Play caption preview', exact: true }).waitFor()
  assert.equal(await slider.inputValue(), '0')
  await preview.getByRole('button', { name: 'Play caption preview', exact: true }).click()
  await page.waitForTimeout(750)
  assert.ok(Number(await slider.inputValue()) >= 600, 'reduced motion allows explicit playback')
  await steps.getByRole('button', { name: /Review/ }).click()
  assert.equal(await preview.count(), 0)
  assert.deepEqual(errors, [])
})
