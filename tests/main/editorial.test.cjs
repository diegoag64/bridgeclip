const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { buildSync } = require('esbuild')
const { renderToStaticMarkup } = require('react-dom/server')
const React = require('react')
const fixture = require('../fixtures/editorial/trace.json')
function load(entry) {
  const code = buildSync({ entryPoints: [path.resolve(__dirname, '../../', entry)], bundle: true, jsx: 'automatic',
    platform: 'node', format: 'cjs', packages: 'external', write: false }).outputFiles[0].text
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', code)(mod, mod.exports, require)
  return mod.exports
}
const { parseEditorialTrace, parseEditorialSummary, editorialScore, defaultWeights } = load('src/shared/editorial.ts')
const { parseFramingTrace, sourceToOutput } = load('src/shared/framing-trace.ts')

test('recorded reaction protects exact source time and exposes prevented cuts', () => {
  const trace = parseFramingTrace(fixture)
  assert.deepEqual(trace.editorial.protected_source, [[4000, 13000]])
  assert.deepEqual(trace.editorial.prevented_cuts, [
    { interval: [7000, 8500], kind: 'pacing' }, { interval: [7000, 8500], kind: 'planner_skip' }
  ])
  assert.equal(sourceToOutput(trace, 7500), 5500)
  assert.equal(sourceToOutput(trace, 12500), 10500)
  const c = trace.editorial.candidates[0]
  assert.equal(c.judgment.answers.refers_back.type, 'noul')
  assert.equal(c.judgment.answers.refers_back.noul, .95)
  assert.equal(c.judgment.answers.refers_back.confidence, undefined)
  assert.equal(c.judgment.cost_usd, .0000126)
  assert.equal(c.judgment.model, 'typesafe/jev-1.13-20260917')
  assert.equal(c.judgment.requested_model, 'typesafe/jev-1.13')
  assert.equal(c.evidence_history.length, c.judgment_history.length)
})

test('editorial parsing drops secret fields and rejects malformed judgments', () => {
  const copy = structuredClone(fixture.editorial)
  copy.api_key = 'do-not-forward'
  copy.candidates[0].judgment.secret = 'do-not-forward'
  copy.candidates[0].evidence.api_key = 'do-not-forward'
  copy.candidates[0].judgment.answers.secret = { type: 'noul', noul: 1 }
  assert.doesNotMatch(JSON.stringify(parseEditorialTrace(copy)), /do-not-forward|"secret"/)
  for (const edit of [
    t => { t.candidates[0].judgment.answers.refers_back.noul = 2 },
    t => { t.protected_source = [[9000, 1000]] },
    t => { t.candidates[0].judgment.estimated_cost_usd = Infinity },
    t => { t.qa.judgment.answers.hook.score = 8 },
    t => { t.candidates = Array(25).fill(t.candidates[0]) }
  ]) {
    const invalid = structuredClone(fixture.editorial); edit(invalid)
    assert.throws(() => parseEditorialTrace(invalid))
  }
})

test('ranking reuses separate scores and gates completeness independently', () => {
  const answers = fixture.editorial.qa.judgment.answers
  const scores = Object.fromEntries(Object.keys(defaultWeights).map(key => [key, answers[key]]))
  const summary = parseEditorialSummary({ status: 'success', flags: [], scores, qa: answers })
  assert.equal(editorialScore(summary), .75)
  const changed = structuredClone(summary)
  changed.scores.hook = { ...changed.scores.hook, score: 2, probabilities: { '0': 0, '1': 0, '2': 1 } }
  assert.equal(editorialScore(changed, { hook: 1, standalone: 0, arc: 0, quotability: 0, ending: 0 }), 1)
  changed.flags = ['missing_context']
  assert.equal(editorialScore(changed), null)
  assert.equal(editorialScore({ ...summary, status: 'unavailable' }), null)
  assert.equal(editorialScore(summary, { ...defaultWeights, hook: NaN }), null)
})

test('inspector renders saved evidence and probability semantics without an API', () => {
  const { RecordedEditorialReview } = load('src/renderer/components/EditorialReview.tsx')
  const html = renderToStaticMarkup(React.createElement(RecordedEditorialReview, { trace: parseEditorialTrace(fixture.editorial), seek() {} }))
  assert.match(html, /2 proposed cuts prevented/)
  assert.match(html, /95.0% yes/)
  assert.match(html, /billed cost.*0.000013/)
  assert.match(html, /Opening this view makes no model calls/)
})


test('legacy editorial traces remain readable without requested_model or reported cost', () => {
  const copy = structuredClone(fixture.editorial)
  const judgment = copy.candidates[0].judgment
  delete judgment.requested_model
  judgment.model = 'jev-1.13.0'
  judgment.cost_usd = null
  const parsed = parseEditorialTrace(copy).candidates[0].judgment
  assert.equal(parsed.requested_model, 'jev-1.13.0')
  assert.equal(parsed.cost_usd, null)
})

const { parseEditAudit } = load('src/shared/editorial.ts')
const editFixture = require('../fixtures/editorial/edit-audit.json')
test('whole transcript audit preserves rejected candidates, repair requests and exact Jev decisions', () => {
  const audit = parseEditAudit(editFixture)
  const coherence = audit.candidates[0].report.coherence
  assert.equal(audit.transcript.length, 4)
  assert.deepEqual(audit.preferred_range, [3, 8])
  assert.deepEqual(coherence.accepted_interval, [0, 11000])
  assert.deepEqual(coherence.attempts.map(a => a.decision), ['reject', 'accept', 'restore', 'accept'])
  assert.match(coherence.repairs[0].request_messages[0].content, /never pad or truncate/)
  assert.deepEqual(JSON.parse(coherence.repairs[0].request_parameters).reasoning, { effort: 'low', exclude: true })
  assert.equal(coherence.policy, 'coherence-v4')
  assert.equal(coherence.threshold, .75)
  assert.equal(coherence.evidence_threshold, .9)
  assert.match(coherence.repairs[0].evidence.failed_checks[0].criteria.false, /essential/)
  assert.equal(coherence.repairs[0].usage.total_tokens, 440)
  assert.equal(audit.candidates[1].status, 'rejected')
  const copy = structuredClone(editFixture)
  copy.api_key = 'do-not-forward'
  copy.candidates[0].report.coherence.attempts[0].evidence.api_key = 'do-not-forward'
  copy.candidates[0].report.coherence.repairs[0].usage.api_key = 'do-not-forward'
  assert.doesNotMatch(JSON.stringify(parseEditAudit(copy)), /do-not-forward/)
  copy.candidates[0].report.coherence.attempts[0].judgment.answers.self_contained.noul = 2
  assert.throws(() => parseEditAudit(copy))
})

test('legacy coherence records retain their original evidence threshold', () => {
  const copy = structuredClone(editFixture)
  const trace = copy.candidates[0].report.coherence
  trace.policy = 'coherence-v1'
  trace.threshold = .9
  delete trace.evidence_threshold
  assert.equal(parseEditAudit(copy).candidates[0].report.coherence.evidence_threshold, .9)
})

test('sponsor and opening checks survive parsing and appear in the edit inspector', () => {
  const copy = structuredClone(editFixture)
  const trace = copy.candidates[0].report.coherence
  trace.policy = 'coherence-v5'
  trace.sponsor_threshold = .9
  trace.reason = 'sponsored_or_uncertain_promotion'
  trace.attempts[0].policy_judgment = { ...structuredClone(trace.attempts[0].judgment), answers: {}, questions: {} }
  for (const key of ['not_sponsored', 'opening_context']) {
    trace.attempts[0].policy_judgment.answers[key] = { type: 'noul', noul: .1 }
    trace.attempts[0].policy_judgment.questions[key] = { type: 'noul', instructions: `Check ${key}`, criteria: { true: 'Pass', false: 'Fail' } }
  }
  const audit = parseEditAudit(copy)
  assert.equal(audit.candidates[0].report.coherence.sponsor_threshold, .9)
  assert.equal(audit.candidates[0].report.coherence.attempts[0].policy_judgment.answers.opening_context.noul, .1)
  const { RecordedEditView } = load('src/renderer/components/EditInspector.tsx')
  const html = renderToStaticMarkup(React.createElement(RecordedEditView, { audit }))
  // Nested JSON starts folded; the policy evaluation remains available in Jev.
  assert.match(html, /sponsorship &amp; opening/)
  const { jevTraceEntries } = load('src/renderer/components/JevTrace.tsx')
  const policy = jevTraceEntries(audit.candidates[0].report).find(e => e.title.includes('sponsorship'))
  assert.equal(policy.judgment.questions.not_sponsored.instructions, 'Check not_sponsored')
  assert.equal(policy.judgment.questions.opening_context.instructions, 'Check opening_context')
  assert.match(html, /Sponsor disclosures are not trimmed/)
})

test('edit inspector renders repairs and omissions without inference or framing capture', () => {
  const { RecordedEditView } = load('src/renderer/components/EditInspector.tsx')
  const html = renderToStaticMarkup(React.createElement(RecordedEditView, { audit: parseEditAudit(editFixture) }))
  for (const text of ['Here is the setup.', 'An incomplete event', 'Boundary repair 1', 'cut · restore', 'self_contained', 'source_segments', 'Opening this view makes no AI calls']) assert.ok(html.includes(text), text)
})

test('edit audit reader enforces library containment and bounded regular files with legacy support', async t => {
  const fs = require('node:fs')
  const os = require('node:os')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-audit-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const run = path.join(root, 'run'), outside = path.join(root, 'outside'), library = path.join(root, 'library')
  fs.mkdirSync(run); fs.mkdirSync(outside); fs.mkdirSync(library)
  const { inspectEdits } = load('src/main/edit-inspector.ts')
  fs.writeFileSync(path.join(run, 'edit_audit.json'), JSON.stringify(editFixture))
  assert.equal((await inspectEdits(run, root)).candidates.length, 2)
  await assert.rejects(inspectEdits(run, library), /outside/)
  fs.symlinkSync(run, path.join(library, 'escaped'))
  await assert.rejects(inspectEdits(path.join(library, 'escaped'), library))
  fs.unlinkSync(path.join(run, 'edit_audit.json'))
  fs.writeFileSync(path.join(outside, 'trace.json'), JSON.stringify(editFixture))
  fs.symlinkSync(path.join(outside, 'trace.json'), path.join(run, 'edit_audit.json'))
  await assert.rejects(inspectEdits(run, root), /invalid/)
  fs.unlinkSync(path.join(run, 'edit_audit.json'))
  fs.writeFileSync(path.join(run, 'edit_audit.json'), '{bad')
  await assert.rejects(inspectEdits(run, root), /invalid/)
  fs.truncateSync(path.join(run, 'edit_audit.json'), 32 * 1024 * 1024 + 1)
  await assert.rejects(inspectEdits(run, root), /invalid/)
  fs.unlinkSync(path.join(run, 'edit_audit.json'))
  fs.writeFileSync(path.join(run, 'transcript.json'), JSON.stringify({ segments: [{ start_time_ms: 0, end_time_ms: 2000, text: 'Legacy words' }] }))
  const old = await inspectEdits(run, root)
  assert.equal(old.outcome, 'legacy_transcript_only')
  assert.equal(old.transcript[0].text, 'Legacy words')
  assert.deepEqual(old.candidates, [])
  fs.writeFileSync(path.join(run, 'transcript.json'), 'null')
  await assert.rejects(inspectEdits(run, root), /Invalid saved transcript/)
})

test('repair trace preserves bounded retry diagnostics and reads legacy records', () => {
  const copy = structuredClone(editFixture)
  const repair = copy.candidates[0].report.coherence.repairs[0]
  const truncated = { ...repair, status: 'truncated', repair_round: 1, finish_reason: 'length', reasoning_tokens: 767, proposal: null, response: '{"omit":' }
  copy.candidates[0].report.coherence.repairs = [truncated, { ...repair, repair_round: 1 }, { ...truncated, repair_round: 2 }, { ...repair, repair_round: 2 }]
  const parsed = parseEditAudit(copy)
  const records = parsed.candidates[0].report.coherence.repairs
  assert.equal(records.length, 4)
  assert.equal(records[0].reasoning_tokens, 767)
  assert.equal(records[0].finish_reason, 'length')
  assert.equal(records[3].repair_round, 2)
  assert.equal(parseEditAudit(editFixture).candidates[0].report.coherence.repairs[0].finish_reason, 'stop')
  const { RecordedEditView } = load('src/renderer/components/EditInspector.tsx')
  const html = renderToStaticMarkup(React.createElement(RecordedEditView, { audit: parsed }))
  assert.match(html, /model reached its output limit/)
  assert.match(html, /Boundary repair 2.*request 4/)
  copy.candidates[0].report.coherence.repairs.push(repair)
  assert.throws(() => parseEditAudit(copy))
})

test('new discovery, speaker, moment and grounded repair records survive IPC parsing', () => {
  const copy = structuredClone(editFixture)
  const sourceRow = { id: 0, start_ms: 0, end_ms: 2000, text: 'Here is the setup.', speaker: 'C1S1' }
  copy.transcript[0].speaker = 'C1S1'
  copy.candidates[0].discovery_pass = 2
  copy.candidates[0].report.moment = { topic: 'The result', topic_interval: [0, 11000], setup: sourceRow,
    payoff: { ...sourceRow, id: 3, start_ms: 9000, end_ms: 11000 }, requires_visual_context: false }
  copy.discovery = { status: 'completed', search_intervals: [[0, 11000]], previous_candidates: [] }
  copy.planner.requests = Array.from({ length: 4 }, (_, i) => ({ ...copy.planner.requests[0], discovery_pass: i < 3 ? 1 : 2 }))
  const parsed = parseEditAudit(copy)
  assert.equal(parsed.transcript[0].speaker, 'C1S1')
  assert.equal(parsed.candidates[0].discovery_pass, 2)
  assert.equal(parsed.candidates[0].report.moment.setup.speaker, 'C1S1')
  assert.equal(parsed.candidates[0].report.coherence.repairs[0].diagnosis.quote, 'Here is the setup.')
  assert.equal(parsed.planner.requests[3].discovery_pass, 2)
  assert.equal(parsed.discovery.status, 'completed')
  const { RecordedEditView } = load('src/renderer/components/EditInspector.tsx')
  const html = renderToStaticMarkup(React.createElement(RecordedEditView, { audit: parsed }))
  assert.match(html, /Proposed topic, setup and payoff/)
  assert.match(html, /C1S1/)
  copy.candidates[0].report.coherence.repairs[0].diagnosis.quote = 'x'.repeat(1001)
  assert.throws(() => parseEditAudit(copy))
})

test('Jev trace presents exact questions, criteria, probabilities and recorded thresholds', () => {
  const { JevTrace, jevTraceEntries, jevQuestionGate } = load('src/renderer/components/JevTrace.tsx')
  const trace = parseEditAudit(editFixture).candidates[0].report
  const entries = jevTraceEntries(trace)
  const first = entries[0]
  const html = renderToStaticMarkup(React.createElement(JevTrace, { trace }))
  assert.match(html, /Jev questions &amp; results/)
  assert.match(html, /Can a viewer identify the subject/)
  assert.match(html, /Exact answer criteria/)
  assert.match(html, /Below threshold: self contained/)
  assert.match(html, /Yes probability ≥ 75.0%/)
  assert.match(html, /Sufficient evidence ≥ 90.0%/)
  assert.equal(jevQuestionGate('self_contained', first.judgment.answers.self_contained, first).passed, false)
  const cut = entries.find(e => e.stage === 'cut')
  assert.match(jevQuestionGate('removal_safe', cut.judgment.answers.removal_safe, cut).required, /95.0%/)
  assert.match(jevQuestionGate('evidence', cut.judgment.answers.evidence, cut).required, /90.0%/)
  // A confident 'insufficient' result is still a failed evidence check.
  const insufficient = { type: 'choice', choice: 'insufficient', confidence: .99, probabilities: { sufficient: .01, insufficient: .99 } }
  assert.equal(jevQuestionGate('evidence', insufficient, first).passed, false)
})

test('Jev trace keeps policy calls and context retries separate with their own evidence', () => {
  const { jevTraceEntries, jevQuestionGate } = load('src/renderer/components/JevTrace.tsx')
  const trace = parseEditAudit(editFixture).candidates[0].report
  trace.coherence.sponsor_threshold = .9
  trace.coherence.attempts[0].policy_judgment = { ...trace.coherence.attempts[0].judgment, answers: { not_sponsored: { type: 'noul', noul: .89 } } }
  const reaction = parseEditorialTrace(fixture.editorial).candidates[0]
  reaction.judgment_history = [reaction.judgment, reaction.judgment]
  reaction.evidence_history = [{ before: 'first evidence' }, { before: 'updated evidence' }]
  trace.candidates = [reaction]
  const entries = jevTraceEntries(trace)
  assert.match(entries[1].title, /sponsorship & opening/)
  assert.equal(jevQuestionGate('not_sponsored', entries[1].judgment.answers.not_sponsored, entries[1]).passed, false)
  const history = entries.filter(e => e.group === 'Reaction context')
  assert.deepEqual(history.map(e => e.evidence.before), ['first evidence', 'updated evidence'])
  assert.equal(history[0].decision, 'superseded')
  assert.equal(history[1].decision, reaction.decision)
})

test('Jev trace distinguishes unavailable answers, skipped calls and legacy traces', () => {
  const { JevTrace, jevQuestionGate } = load('src/renderer/components/JevTrace.tsx')
  const trace = parseEditAudit(editFixture).candidates[0].report
  const attempt = trace.coherence.attempts[0]
  attempt.judgment.status = 'budget_exhausted'
  attempt.judgment.answers = {}
  const html = renderToStaticMarkup(React.createElement(JevTrace, { trace }))
  assert.match(html, /No answer recorded · budget exhausted/)
  assert.doesNotMatch(html, />Pass</)
  assert.equal(jevQuestionGate('self_contained', { type: 'noul', noul: 1 }, { coherence: trace.coherence, judgment: attempt.judgment }), null)
  attempt.judgment = null
  assert.match(renderToStaticMarkup(React.createElement(JevTrace, { trace })), /Jev was not called/)
  assert.match(renderToStaticMarkup(React.createElement(JevTrace, { trace: null })), /No Jev question trace was recorded/)
})

test('Jev trace uses relaxed per-check thresholds while preserving historical rules', () => {
  const { JevTrace, jevTraceEntries, jevQuestionGate } = load('src/renderer/components/JevTrace.tsx')
  const saved = structuredClone(editFixture)
  const coherence = saved.candidates[0].report.coherence
  coherence.policy = 'coherence-v6'
  coherence.self_contained_threshold = .7
  coherence.evidence_threshold = .5
  coherence.attempts[0].judgment.answers.self_contained.noul = .7
  coherence.attempts[0].judgment.answers.evidence = { type: 'choice', choice: 'sufficient', confidence: .2, probabilities: { sufficient: .5, insufficient: .5 } }
  const trace = parseEditAudit(saved).candidates[0].report
  const entry = jevTraceEntries(trace)[0]
  assert.equal(jevQuestionGate('self_contained', entry.judgment.answers.self_contained, entry).passed, true)
  assert.equal(jevQuestionGate('evidence', entry.judgment.answers.evidence, entry).passed, true)
  const html = renderToStaticMarkup(React.createElement(JevTrace, { trace }))
  assert.match(html, /Yes probability ≥ 70.0%/)
  assert.match(html, /Sufficient evidence ≥ 50.0%/)
  const historic = jevTraceEntries(parseEditAudit(editFixture).candidates[0].report)[0]
  assert.equal(jevQuestionGate('self_contained', { type: 'noul', noul: .7 }, historic).passed, false)
  assert.equal(jevQuestionGate('evidence', entry.judgment.answers.evidence, historic).passed, false)
})


test('source and sponsorship gates use the new saved thresholds while preserving historical requirements', () => {
  const { jevTraceEntries, jevQuestionGate } = load('src/renderer/components/JevTrace.tsx')
  const saved = structuredClone(editFixture)
  const coherence = saved.candidates[0].report.coherence
  coherence.policy = 'coherence-v8'
  coherence.faithful_to_source_threshold = .65
  coherence.sponsor_threshold = .8
  const entry = jevTraceEntries(parseEditAudit(saved).candidates[0].report)[0]
  for (const [key, probability, percentage] of [['faithful_to_source', .65, '65.0'], ['not_sponsored', .8, '80.0']]) {
    assert.deepEqual(jevQuestionGate(key, { type: 'noul', noul: probability }, entry), { passed: true, required: `Yes probability ≥ ${percentage}%` })
    assert.equal(jevQuestionGate(key, { type: 'noul', noul: probability - .001 }, entry).passed, false)
  }
  coherence.policy = 'coherence-v7'
  coherence.faithful_to_source_threshold = .7
  coherence.sponsor_threshold = .9
  const historic = jevTraceEntries(parseEditAudit(saved).candidates[0].report)[0]
  assert.equal(jevQuestionGate('faithful_to_source', { type: 'noul', noul: .65 }, historic).passed, false)
  assert.equal(jevQuestionGate('not_sponsored', { type: 'noul', noul: .8 }, historic).passed, false)
})

test('source and title gates use saved 70% thresholds without changing older runs', () => {
  const { jevTraceEntries, jevQuestionGate } = load('src/renderer/components/JevTrace.tsx')
  const saved = structuredClone(editFixture)
  const coherence = saved.candidates[0].report.coherence
  coherence.policy = 'coherence-v7'
  coherence.threshold = .75
  coherence.faithful_to_source_threshold = .7
  coherence.title_supported_threshold = .7
  const entry = jevTraceEntries(parseEditAudit(saved).candidates[0].report)[0]
  for (const key of ['faithful_to_source', 'title_supported']) {
    assert.deepEqual(jevQuestionGate(key, { type: 'noul', noul: .7 }, entry), { passed: true, required: 'Yes probability ≥ 70.0%' })
    assert.equal(jevQuestionGate(key, { type: 'noul', noul: .699 }, entry).passed, false)
  }
  assert.equal(jevQuestionGate('logical_flow', { type: 'noul', noul: .7 }, entry).passed, false)
  coherence.policy = 'coherence-v6'
  delete coherence.faithful_to_source_threshold
  delete coherence.title_supported_threshold
  const historic = jevTraceEntries(parseEditAudit(saved).candidates[0].report)[0]
  for (const key of ['faithful_to_source', 'title_supported']) {
    assert.deepEqual(jevQuestionGate(key, { type: 'noul', noul: .7 }, historic), { passed: false, required: 'Yes probability ≥ 75.0%' })
  }
})

test('source context survives saved audit parsing, keeps evidence labels, and renders its channel overview', () => {
  const saved = structuredClone(editFixture)
  const context = {
    version: 1, status: 'ready', research_status: 'completed', created_at: '2026-09-26T00:00:00Z',
    source: { title: 'A reaction to a demo', description: 'Source description', channel: 'Example Reviews', channel_id: 'UCfixture' },
    brief: { summary: 'Likely a reaction to a demonstration.', channel_summary: 'A channel about technology reviews.',
      format: 'Reaction/commentary', topics: ['Technology'], perspectives: ['Host versus demonstration'],
      clip_guidance: ['Keep the setup and response.'], uncertainties: ['Confirm the host position.'], vocabulary: ['Example'],
      background: [{ claim: 'The demo is a prototype.', url: 'https://example.org/demo' }] },
    citations: [{ title: 'Original demo', url: 'https://example.org/demo' }], cost_usd: .003, cost_incomplete: false,
    requests: [{ status: 'success', model: 'google/gemini-3.8-flash', web_requested: true, search_requests: 1, latency_ms: 20, usage: { cost: .003 } }],
    api_key: 'must-not-survive'
  }
  saved.source_context = context
  const contextEvidence = { rule: 'Background is not evidence.', status: context.status, metadata: context.source,
    brief: context.brief, research_status: context.research_status, citations: context.citations, secret: 'must-not-survive' }
  saved.candidates[0].report.coherence.attempts[0].evidence.source_context = contextEvidence
  const audit = parseEditAudit(saved)
  assert.equal(audit.source_context.brief.format, 'Reaction/commentary')
  assert.equal(audit.candidates[0].report.coherence.attempts[0].evidence.source_context.rule, 'Background is not evidence.')
  assert.equal(JSON.stringify(audit).includes('must-not-survive'), false)
  const { RecordedEditView } = load('src/renderer/components/EditInspector.tsx')
  const html = renderToStaticMarkup(React.createElement(RecordedEditView, { audit }))
  assert.match(html, /Channel overview/)
  assert.match(html, /A channel about technology reviews/)
  assert.match(html, /Prepared before transcription/)
  assert.match(html, /Original demo/)
  assert.equal(parseEditAudit(editFixture).source_context, null)
  saved.source_context.citations[0].url = 'javascript:alert(1)'
  assert.throws(() => parseEditAudit(saved), /Invalid context source URL/)
})
