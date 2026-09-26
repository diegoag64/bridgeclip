const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { buildApp, launchApp } = require('../zernio/support/electron-app.cjs')

test('Jobs actions inspect runs and open completed jobs in the shared Library view', { timeout: 90000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-jobs-library-'))
  const userDataDir = path.join(root, 'user-data'), library = path.join(userDataDir, 'BridgeClip')
  const completedId = '11111111-1111-4111-8111-111111111111'
  const failedId = '22222222-2222-4222-8222-222222222222'
  const liveId = '33333333-3333-4333-8333-333333333333'
  const date = '2026-01-01T12:00:00.000Z'
  const writeRun = (id, title, status) => {
    const dir = path.join(library, id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'run-history.json'), JSON.stringify({ jobId: id, sourceLabel: title, status,
      startedAt: date, finishedAt: status === 'running' ? null : date, errorMessage: status === 'failed' ? 'Test failure' : null }))
    fs.writeFileSync(path.join(dir, 'transcript.json'), JSON.stringify({ segments: [
      { start_time_ms: 0, end_time_ms: 2000, text: `Saved transcript for ${title}.`, words: [] }
    ] }))
    return dir
  }
  const output = (id, title) => ({ job_id: id, source_video_title: title, source_video_url: 'source.mp4',
    source_video_duration_seconds: 2, clips: [], total_clips: 0 })
  const completedDir = writeRun(completedId, 'Completed test run', 'completed')
  fs.writeFileSync(path.join(completedDir, 'job_output.json'), JSON.stringify(output(completedId, 'Completed test run')))
  const failedDir = writeRun(failedId, 'Failed test run', 'failed')
  const session = await launchApp({ appDir: buildApp(path.join(root, 'app')), userDataDir })
  t.after(async () => { await session.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const { app, page } = session
  page.setDefaultTimeout(10000)
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  // Exercise the real folder IPC without opening Finder during the test.
  await app.evaluate(({ shell, BrowserWindow }) => {
    globalThis.jobsTestFolders = []
    shell.openPath = async file => { globalThis.jobsTestFolders.push(file); return '' }
    BrowserWindow.getAllWindows()[0].setSize(1300, 900)
  })
  const jobs = async () => {
    await page.getByRole('button', { name: /^Jobs(?:,|$)/ }).click()
    await page.getByRole('heading', { name: 'Jobs', exact: true }).waitFor()
  }
  const expectLibrary = async title => {
    await page.getByRole('heading', { name: title, exact: true }).waitFor()
    assert.equal(await page.locator('button[aria-current="page"]').getAttribute('aria-label'), 'Library')
    assert.equal(await page.getByRole('button', { name: 'All jobs', exact: true }).count(), 0)
  }
  await jobs()
  const completedActions = page.getByRole('button', { name: 'Actions for Completed test run', exact: true })
  await completedActions.waitFor()
  assert.equal(await page.getByRole('button', { name: 'Inspect transcript & edits', exact: true }).count(), 0)
  await completedActions.focus()
  await completedActions.press('ArrowDown')
  const menu = page.getByRole('menu', { name: 'Actions for Completed test run', exact: true })
  await menu.waitFor()
  assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), ['Open in Library', 'Open folder', 'Details'])
  assert.equal(await menu.getByRole('menuitem', { name: 'Open in Library' }).evaluate(el => el === document.activeElement), true)
  await menu.press('Escape')
  assert.equal(await completedActions.evaluate(el => el === document.activeElement), true)

  await completedActions.click()
  await page.getByRole('menuitem', { name: 'Details', exact: true }).click()
  const inspector = page.getByRole('dialog', { name: 'Inspect transcript and edits' })
  await inspector.getByText('Saved transcript for Completed test run.', { exact: false }).waitFor()
  await page.getByRole('button', { name: 'Close edit inspector' }).click()
  await completedActions.click()
  await page.getByRole('menuitem', { name: 'Open folder', exact: true }).click()
  assert.deepEqual(await app.evaluate(() => globalThis.jobsTestFolders), [fs.realpathSync(completedDir)])

  await completedActions.click()
  if (process.env.BRIDGECLIP_E2E_SHOTS) {
    fs.mkdirSync(process.env.BRIDGECLIP_E2E_SHOTS, { recursive: true })
    await page.screenshot({ path: path.join(process.env.BRIDGECLIP_E2E_SHOTS, 'jobs-actions.png') })
  }
  await page.getByRole('menuitem', { name: 'Open in Library', exact: true }).click()
  await expectLibrary('Completed test run')
  await jobs()
  await page.getByTitle('Open in Library', { exact: true }).click()
  await expectLibrary('Completed test run')

  // Old failed runs still expose their saved transcript, even without a live job.
  await jobs()
  const failedActions = page.getByRole('button', { name: 'Actions for Failed test run', exact: true })
  await failedActions.click()
  assert.equal(await page.getByRole('menuitem', { name: 'Open job', exact: true }).isDisabled(), true)
  await page.getByRole('menuitem', { name: 'Details', exact: true }).click()
  await inspector.getByText('Saved transcript for Failed test run.', { exact: false }).waitFor()
  await page.getByRole('button', { name: 'Close edit inspector' }).click()

  // Real snapshot events cover session jobs and completion while watching progress.
  const publish = job => app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.send('jobs:update', value), job)
  const snapshot = (id, status, outputDir) => ({ id, revision: 1, status, outputDir, output: null,
    request: { videoUrl: 'source.mp4' }, percent: 50, step: '', clipsDone: 0, clipsTotal: 0,
    error: status === 'failed' ? 'Test failure' : null, errorHint: null, queuedAt: date, startedAt: date, finishedAt: null })
  await publish(snapshot(failedId, 'failed', failedDir))
  await failedActions.click()
  await page.getByRole('menuitem', { name: 'Open job', exact: true }).click()
  await page.getByRole('button', { name: 'Run again', exact: true }).waitFor()
  assert.equal(await page.locator('button[aria-current="page"]').getAttribute('aria-label'), 'Jobs')
  await page.getByRole('button', { name: 'All jobs', exact: true }).click()

  const liveDir = writeRun(liveId, 'Watched test run', 'running')
  const live = snapshot(liveId, 'rendering', liveDir)
  await publish(live)
  await page.getByRole('region', { name: 'Active jobs' }).getByRole('button').first().click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).waitFor()
  const finishedOutput = output(liveId, 'Watched test run')
  fs.writeFileSync(path.join(liveDir, 'job_output.json'), JSON.stringify(finishedOutput))
  await publish({ ...live, revision: 2, status: 'completed', percent: 100, output: finishedOutput, finishedAt: date })
  await expectLibrary('Watched test run')
  // Returning to Jobs must stay at the list, without a stale completion redirect.
  await jobs()
  await page.getByRole('button', { name: 'Actions for Watched test run', exact: true }).waitFor()
  await page.getByTitle('Open in Library', { exact: true }).filter({ hasText: 'Watched test run' }).click()
  await expectLibrary('Watched test run')
  assert.deepEqual(errors, [])
})
