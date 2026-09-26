const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { buildApp, launchApp } = require('../zernio/support/electron-app.cjs')
const fixture = require('../fixtures/editorial/edit-audit.json')
const framingFixture = require('../fixtures/editorial/trace.json')

async function openDetails(container) {
  for (const details of await container.locator('details').all()) {
    if (await details.isVisible() && await details.getAttribute('open') === null) await details.locator(':scope > summary').click()
  }
}

async function readJson(container, label) {
  const region = container.getByRole('region', { name: label, exact: true }).first()
  await region.getByRole('button', { name: 'Collapse JSON', exact: true }).waitFor()
  assert.equal(await region.locator('[aria-label="Formatted JSON"]').evaluate(el => el.scrollWidth > el.clientWidth), false)
  await region.getByRole('radio', { name: 'Original', exact: true }).click()
  const value = JSON.parse(await region.getByRole('textbox', { name: 'Original JSON' }).inputValue())
  await region.getByRole('radio', { name: 'Formatted', exact: true }).click()
  return value
}

test('Details keeps navigation visible and makes nested JSON readable without changing saved evidence', { timeout: 90000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-details-'))
  const userDataDir = path.join(root, 'user-data'), library = path.join(userDataDir, 'BridgeClip')
  const id = '11111111-1111-4111-8111-111111111111', run = path.join(library, id)
  fs.mkdirSync(run, { recursive: true })
  const audit = structuredClone(fixture)
  audit.title = 'Saved decisions example'
  const request = audit.planner.requests[0]
  request.request_parameters = JSON.stringify({ model: 'fixture/planner', enabled: true, temperature: 0.5,
    schema: { type: 'object', description: 'A readable schema\nWith multiple lines' }, empty: [], nullable: null })
  request.request_parameters = JSON.stringify(request.request_parameters)
  request.response = '```json\n' + JSON.stringify({ clips: Array.from({ length: 125 }, (_, i) => `Moment ${i + 1}`) }) + '\n```'
  request.messages[0].content = 'Source context:\n{"channel":"A reaction channel","topics":["commentary"]}\nTranscript:\n' + 'Long saved context. '.repeat(1000) + 'END OF SAVED CONTEXT'
  audit.planner.requests.push({ ...request, status: 'truncated', response: '{"clips": [', messages: [{ role: 'user', content: '<img src=x onerror="alert(1)">' }] })
  const policy = structuredClone(audit.candidates[0].report.coherence.attempts[0].judgment)
  policy.questions = { not_sponsored: { type: 'noul', instructions: 'Check paid promotion.', criteria: { true: 'No promotion', false: 'Paid promotion' } },
    opening_context: { type: 'noul', instructions: 'Check the opening.', criteria: { true: 'Clear', false: 'Unclear' } } }
  policy.answers = { not_sponsored: { type: 'noul', noul: .9 }, opening_context: { type: 'noul', noul: .8 } }
  audit.candidates[0].report.coherence.attempts[0].policy_judgment = policy
  audit.candidates[0].report.moment = { topic: 'A context-dependent reaction', topic_interval: [0, 11000],
    setup: { id: 0, start_ms: 0, end_ms: 2000, text: 'Here is the setup.', speaker: null },
    payoff: { id: 3, start_ms: 9000, end_ms: 11000, text: 'The qualification.', speaker: null }, requires_visual_context: false }
  audit.candidates[0].report.coherence.visual_reviews = [{ interval: [0, 11000], result: {
    status: 'success', model: 'fixture/vision', cache_hit: false, observations: [], attempts: [] } }]
  const framing = structuredClone(framingFixture)
  framing.editorial.candidates[0].evidence.observed_facts.visual_coverage = null
  framing.editorial.fillers = [structuredClone(framing.editorial.candidates[0])]
  framing.editorial.duplicates = [{ other_clip: 1, judgment: framing.editorial.qa.judgment,
    evidence: { first: framing.editorial.qa.evidence, second: framing.editorial.qa.evidence } }]
  const framingFile = path.join(run, 'clip_00.framing.json'), savedFraming = JSON.stringify(framing)
  fs.writeFileSync(framingFile, savedFraming)
  const auditFile = path.join(run, 'edit_audit.json'), saved = JSON.stringify(audit)
  fs.writeFileSync(auditFile, saved)
  fs.writeFileSync(path.join(run, 'job_output.json'), JSON.stringify({ job_id: id, source_video_title: audit.title,
    source_video_url: 'source.mp4', source_video_duration_seconds: 16, total_clips: 1,
    clips: [{ clip_index: 0, s3_url: path.join(run, 'clip_00.mp4'), duration_ms: 10500,
      start_time_ms: 2300, end_time_ms: 13500, virality_score: .8 }] }))
  const session = await launchApp({ appDir: buildApp(path.join(root, 'app')), userDataDir })
  t.after(async () => { await session.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const { page, app } = session
  page.setDefaultTimeout(10000)
  const errors = []; page.on('pageerror', e => errors.push(e.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1300, 900))
  await page.getByRole('button', { name: 'Jobs', exact: true }).click()
  const actions = page.getByRole('button', { name: `Actions for ${audit.title}`, exact: true })
  await actions.click()
  await page.getByRole('menuitem', { name: 'Details', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Inspect transcript and edits' })
  await dialog.getByRole('combobox', { name: 'Clip candidate' }).waitFor()
  await dialog.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)))
  const box = await dialog.boundingBox()
  assert.ok(box.width <= 900 && box.height <= 640)
  const close = dialog.getByRole('button', { name: 'Close edit inspector' })
  const headerY = (await close.boundingBox()).y
  await dialog.getByRole('combobox', { name: 'Jev evaluation' }).selectOption('1')
  await dialog.getByText('Check paid promotion.', { exact: true }).waitFor()
  await dialog.getByText('Check the opening.', { exact: true }).waitFor()
  await openDetails(dialog)
  assert.equal(typeof (await readJson(dialog, 'Saved input evidence')), 'object')
  assert.equal((await readJson(dialog, 'Jev request and result')).questions.not_sponsored.instructions, 'Check paid promotion.')
  await dialog.getByRole('radio', { name: 'Transcript', exact: true }).click()
  await dialog.getByRole('textbox', { name: 'Search transcript' }).fill('qualification')
  assert.equal(await dialog.locator('[aria-label="Transcript passages"] p').count(), 1)
  await openDetails(dialog)
  assert.equal((await readJson(dialog, 'Proposed moment')).topic, 'A context-dependent reaction')
  assert.equal((await readJson(dialog, 'Visual review 1')).result.model, 'fixture/vision')
  assert.equal((await readJson(dialog, 'Coherence attempt 1')).decision, 'reject')
  assert.equal((await readJson(dialog, 'Boundary repair 1')).request_parameters, audit.candidates[0].report.coherence.repairs[0].request_parameters)
  assert.equal((await readJson(dialog, 'Additional clip checks')).moment.topic, 'A context-dependent reaction')
  await dialog.getByRole('radio', { name: 'Run details', exact: true }).click()
  await dialog.getByText('Planner requests & candidate discovery (2)', { exact: true }).click()
  const json = dialog.getByRole('region', { name: 'Planner requests', exact: true })
  await json.getByRole('button', { name: 'Expand 0', exact: true }).click()
  await json.getByRole('button', { name: 'Expand request_parameters', exact: true }).click()
  await json.getByText('"fixture/planner"', { exact: true }).waitFor()
  await json.getByRole('button', { name: 'Expand schema', exact: true }).click()
  await json.getByText('"A readable schema\nWith multiple lines"', { exact: true }).waitFor()
  assert.equal(await json.locator('[aria-label="Formatted JSON"]').evaluate(el => el.scrollWidth > el.clientWidth), false)
  await json.getByRole('button', { name: 'Expand response', exact: true }).click()
  await json.getByRole('button', { name: 'Expand clips', exact: true }).click()
  assert.equal(await json.getByText('"Moment 51"', { exact: true }).count(), 0)
  await json.getByRole('button', { name: 'Show next 50 of 75 remaining' }).click()
  await json.getByText('"Moment 100"', { exact: true }).waitFor()
  await json.getByRole('button', { name: 'Show next 25 of 25 remaining' }).click()
  await json.getByText('"Moment 125"', { exact: true }).waitFor()
  // Long strings load more text on demand; malformed JSON remains literal text.
  await json.getByRole('button', { name: 'Expand messages', exact: true }).click()
  await json.getByRole('button', { name: 'Expand 0', exact: true }).click()
  await json.getByRole('button', { name: 'Expand JSON', exact: true }).click()
  await json.getByText('"A reaction channel"', { exact: true }).waitFor()
  assert.equal(await json.getByText(/END OF SAVED CONTEXT/).count(), 0)
  await json.getByRole('button', { name: 'Show more text' }).click()
  await json.getByRole('button', { name: 'Show more text' }).click()
  await json.getByText(/END OF SAVED CONTEXT/).waitFor()
  await json.getByRole('button', { name: 'Expand 1', exact: true }).click()
  await json.getByText('"{"clips": ["', { exact: true }).waitFor()
  const headerAfterScroll = (await close.boundingBox()).y
  assert.ok(Math.abs(headerAfterScroll - headerY) < 1, `Header and close button stay fixed (${headerY} → ${headerAfterScroll})`)
  // The Original view preserves JSON strings and all their exact saved text.
  await json.getByRole('radio', { name: 'Original', exact: true }).click()
  const original = json.getByRole('textbox', { name: 'Original JSON' })
  const decoded = JSON.parse(await original.inputValue())
  assert.equal(decoded.requests[0].request_parameters, request.request_parameters)
  assert.equal(decoded.requests[0].response, request.response)
  assert.equal(decoded.requests[0].messages[0].content, request.messages[0].content)
  assert.equal(await original.getAttribute('readonly'), '')
  await json.getByRole('button', { name: 'Select all' }).click()
  assert.equal(await original.evaluate(el => el.selectionEnd - el.selectionStart), (await original.inputValue()).length)
  await original.press('Tab')
  assert.equal(await close.evaluate(el => el === document.activeElement), true, 'Tab wraps inside the modal')
  await close.press('Shift+Tab')
  assert.equal(await original.evaluate(el => el === document.activeElement), true)
  await json.getByRole('radio', { name: 'Formatted', exact: true }).click()
  assert.equal(await json.getByText('"Moment 125"', { exact: true }).count(), 0, 'Returning to formatted view starts with compact branches')
  if (process.env.BRIDGECLIP_E2E_SHOTS) {
    fs.mkdirSync(process.env.BRIDGECLIP_E2E_SHOTS, { recursive: true })
    await page.screenshot({ path: path.join(process.env.BRIDGECLIP_E2E_SHOTS, 'details-wide.png') })
  }
  // Fit a smaller app window without horizontal clipping or losing controls.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(740, 600))
  assert.equal(await dialog.evaluate(el => el.scrollWidth > el.clientWidth), false)
  assert.ok((await dialog.boundingBox()).height <= 480)
  if (process.env.BRIDGECLIP_E2E_SHOTS) await page.screenshot({ path: path.join(process.env.BRIDGECLIP_E2E_SHOTS, 'details-small.png') })
  await close.click()
  assert.equal(await dialog.count(), 0)
  assert.equal(await actions.evaluate(el => el === document.activeElement), true)
  await actions.click()
  await page.getByRole('menuitem', { name: 'Details', exact: true }).click()
  await dialog.getByRole('combobox', { name: 'Clip candidate' }).waitFor()
  await dialog.press('Escape')
  assert.equal(await dialog.count(), 0)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1300, 900))
  await page.getByTitle('Open in Library', { exact: true }).click()
  await page.getByRole('button', { name: 'Inspect framing', exact: true }).click()
  const frame = page.getByRole('dialog', { name: 'Inspect framing', exact: true })
  await frame.getByRole('region', { name: 'Recorded editorial review', exact: true }).waitFor()
  await openDetails(frame)
  assert.equal((await readJson(frame, 'Judgment request and result')).model, framing.editorial.candidates[0].judgment.model)
  assert.deepEqual((await readJson(frame, 'Editorial evidence')).evidence, framing.editorial.candidates[0].evidence)
  assert.deepEqual(await readJson(frame, 'Final quality evidence'), framing.editorial.qa.evidence)
  assert.equal((await readJson(frame, 'Fillers and acknowledgments')).length, 1)
  assert.deepEqual((await readJson(frame, 'Duplicate comparison 1')).first, framing.editorial.qa.evidence)
  assert.deepEqual((await readJson(frame, 'Framing plans')).rendered, framing.rendered_plan.map(s => [s.start_ms, s.end_ms, s.layout]))
  assert.equal((await readJson(frame, 'Framing configuration')).version, framing.version)
  await frame.getByRole('button', { name: 'Close framing inspector', exact: true }).click()
  assert.equal(fs.readFileSync(auditFile, 'utf8'), saved)
  assert.equal(fs.readFileSync(framingFile, 'utf8'), savedFraming)
  assert.deepEqual(errors, [])
})
