const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { buildApp, launchApp } = require('../zernio/support/electron-app.cjs')

test('Studio Timeline shows measured stages, queued workflows and honest older-worker progress', { timeout: 90000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-studio-timeline-'))
  const session = await launchApp({ appDir: buildApp(path.join(root, 'app')), userDataDir: path.join(root, 'user-data') })
  t.after(async () => { await session.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const { app, page } = session
  page.setDefaultTimeout(10000)
  const errors = []; page.on('pageerror', e => errors.push(e.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1300, 1000))
  const job = { id: 'studio-test', revision: 1, status: 'queued', outputDir: root, output: null,
    request: { videoUrl: 'Creative conversations.mp4', workflow: 'automatic' }, percent: 0, step: '', clipsDone: 0, clipsTotal: 0,
    error: null, errorHint: null, queuedAt: new Date(Date.now() - 927000).toISOString(), startedAt: null, finishedAt: null }
  const publish = patch => {
    Object.assign(job, patch, { revision: job.revision + 1 })
    return app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.send('jobs:update', value), job)
  }
  await publish({})
  await page.getByRole('button', { name: /^Jobs(?:,|$)/ }).click()
  await page.getByRole('region', { name: 'Active jobs' }).getByRole('button').first().click()
  await page.getByRole('button', { name: 'Remove from queue', exact: true }).waitFor()
  const stages = page.getByRole('list', { name: 'Stage progress' })
  assert.equal(await stages.getByRole('progressbar').count(), 8)
  assert.deepEqual(await stages.getByRole('progressbar').evaluateAll(bars => bars.map(b => b.value)), Array(8).fill(0))
  assert.equal(await stages.locator('[aria-current="step"]').count(), 0)
  const ids = ['download', 'source_context', 'transcription', 'planning', 'preparing', 'saving', 'preview']
  const times = [42000, 18000, 204000, 96000, 567000, 0, 0]
  await publish({ status: 'planning', percent: 65, startedAt: job.queuedAt, request: { ...job.request, workflow: 'review' },
    step: 'Analyzing framing for candidate 13 of 19…', progressAt: Date.now(),
    stages: ids.map((id, i) => ({ id, state: i < 4 ? 'completed' : i === 4 ? 'running' : 'pending', percent: i < 4 ? 100 : i === 4 ? 68 : null, elapsed_ms: times[i] })) })
  await stages.getByText('Frame & review', { exact: true }).waitFor()
  assert.equal(await stages.getByRole('progressbar').count(), 7)
  assert.equal(await stages.getByRole('progressbar', { name: 'Prepare editor clips progress' }).getAttribute('value'), '68')
  assert.equal(await stages.getByRole('progressbar', { name: 'Prepare source preview progress' }).getAttribute('value'), '0')
  await page.getByText('4 of 7 stages complete', { exact: true }).waitFor()
  await page.getByText('Analyzing framing for candidate 13 of 19…', { exact: true }).waitFor()
  const timed = page.getByRole('region', { name: 'Time by stage' })
  await timed.waitFor()
  assert.equal(await timed.locator('.studio-time-strip > div').count(), 5)
  const proportions = await timed.locator('.studio-time-strip > div').evaluateAll(parts => parts.map(p => p.getBoundingClientRect().width))
  assert.ok(Math.abs(proportions[2] / proportions[0] - 204 / 42) < .05)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  if (process.env.BRIDGECLIP_E2E_SHOTS) {
    fs.mkdirSync(process.env.BRIDGECLIP_E2E_SHOTS, { recursive: true })
    await page.screenshot({ path: path.join(process.env.BRIDGECLIP_E2E_SHOTS, 'studio-timeline.png') })
  }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  assert.equal(await stages.locator('.studio-node > span').evaluate(el => getComputedStyle(el).animationName), 'none')
  await publish({ stages: job.stages.map(stage => stage.id === 'preparing' ? { ...stage, percent: null } : stage) })
  assert.equal(await stages.getByRole('progressbar', { name: 'Prepare editor clips progress' }).getAttribute('value'), null)
  await stages.locator('.studio-indeterminate').waitFor({ state: 'visible' })
  assert.equal(await stages.locator('.studio-indeterminate').evaluate(el => getComputedStyle(el).animationName), 'none')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(740, 800))
  await page.waitForFunction(() => window.innerWidth <= 740)
  assert.equal(await page.locator('.job-timeline').evaluate(el => el.scrollWidth > el.clientWidth), false)
  if (process.env.BRIDGECLIP_E2E_SHOTS) await page.screenshot({ path: path.join(process.env.BRIDGECLIP_E2E_SHOTS, 'studio-timeline-compact.png') })
  await publish({ stages: undefined, step: 'Finding the strongest moments…' })
  await page.getByText('Stage measurements unavailable for this run', { exact: true }).waitFor()
  assert.equal(await timed.count(), 0)
  assert.equal(await stages.getByText('Done', { exact: true }).count(), 0)
  assert.equal(await stages.getByRole('progressbar').count(), 7)
  assert.deepEqual(errors, [])
})
