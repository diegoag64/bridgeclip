/** Saved editorial evidence. Parsers copy only allowlisted bounded fields. */
export const scoreNames = ['hook', 'standalone', 'arc', 'quotability', 'ending'] as const
export type ScoreName = typeof scoreNames[number]
export type JudgmentAnswer = { type: 'noul'; noul: number } |
  { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> } |
  { type: 'score'; score: number; confidence: number; probabilities: Record<string, number>; legend: Record<string, string> }
export interface Judgment {
  status: string; model: string; requested_model: string; rule_version: string; cache_id: string; cache_hit: boolean
  latency_ms: number; input_tokens: number | null; output_tokens: number | null
  cost_usd: number | null; estimated_cost_usd: number | null
  answers: Record<string, JudgmentAnswer>; questions: Record<string, { type: string; instructions: string; criteria: unknown }>
}
export interface EditorialSummary {
  flags: string[]; status: string; scores: Partial<Record<ScoreName, Extract<JudgmentAnswer, { type: 'score' }>>>
  qa: Record<string, JudgmentAnswer>
}
export interface EditorialRecord {
  interval: [number, number]; sequence: [number, number]; decision: string; reason: string
  evidence: Record<string, unknown>; judgment: Judgment; judgment_history: Judgment[]; visual: Record<string, unknown> | null
  layout_segments: { start_ms: number; end_ms: number; layout: string }[]
  evidence_history: Record<string, unknown>[]
}
export interface EditorialTrace {
  coherence: CoherenceTrace | null
  moment: Record<string, unknown> | null
  version: 1; candidates: EditorialRecord[]; protected_source: [number, number][]; flags: string[]
  fillers: EditorialRecord[]; qa: { evidence: Record<string, unknown>; judgment: Judgment } | null
  duplicates: { other_clip: number; judgment: Judgment; evidence: Record<string, unknown> }[]; retained_source: [number, number][]
  prevented_cuts: { interval: [number, number]; kind: string }[]
}
const keys = ['not_sponsored', 'opening_context', 'self_contained', 'complete_ending', 'logical_flow', 'faithful_to_source', 'removal_safe', 'join_logical', 'introduces_event', 'refers_back', 'necessary_event', 'evidence', 'missing_context', 'unresolved_payoff', 'title_supported', 'acknowledgment', 'relationship', ...scoreNames]
const statuses = ['disabled', 'success', 'unavailable', 'evidence_limit', 'budget_exhausted']
const obj = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid editorial object')
  return v as Record<string, unknown>
}
const str = (v: unknown, max = 2000): string => {
  if (typeof v !== 'string' || v.length > max) throw new Error('Invalid editorial text')
  return v
}
const num = (v: unknown, max = 86400000): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max) throw new Error('Invalid editorial number')
  return v
}
const list = <T>(v: unknown, max: number, parse: (x: unknown) => T): T[] => {
  if (!Array.isArray(v) || v.length > max) throw new Error('Invalid editorial list')
  return v.map(parse)
}
const span = (v: unknown): [number, number] => {
  const pair = list(v, 2, (n) => num(n))
  if (pair.length !== 2 || pair[1] <= pair[0]) throw new Error('Invalid editorial interval')
  return pair as [number, number]
}
const maybeNumber = (v: unknown): number | null => v == null ? null : num(v)
const flags = (v: unknown): string[] => list(v ?? [], 64, (s) => {
  const value = str(s, 80)
  if (!/^[a-z_]+$/.test(value)) throw new Error('Invalid editorial flag')
  return value
})
function answers(value: unknown): Record<string, JudgmentAnswer> {
  const result: Record<string, JudgmentAnswer> = {}
  for (const [key, raw] of Object.entries(obj(value ?? {}))) {
    if (!keys.includes(key)) continue
    const a = obj(raw)
    if (a.type === 'noul') { result[key] = { type: 'noul', noul: num(a.noul, 1) }; continue }
    if (a.type !== 'choice' && a.type !== 'score') throw new Error('Invalid judgment type')
    const entries = Object.entries(obj(a.probabilities))
    if (!entries.length || entries.length > 10) throw new Error('Invalid distribution')
    const probabilities = Object.fromEntries(entries.map(([k, v]) => [str(k, 80), num(v, 1)]))
    if (Math.abs(Object.values(probabilities).reduce((a, b) => a + b, 0) - 1) > .005) throw new Error('Invalid distribution')
    const confidence = num(a.confidence, 1)
    if (a.type === 'choice') {
      const selected = str(a.choice, 80)
      if (!Object.hasOwn(probabilities, selected) || probabilities[selected] < Math.max(...Object.values(probabilities)) - .005) throw new Error('Invalid choice')
      result[key] = { type: 'choice', choice: selected, confidence, probabilities }
    } else {
      const legend = obj(a.legend)
      if (entries.length !== 3 || !['0', '1', '2'].every((k) => Object.hasOwn(probabilities, k))) throw new Error('Invalid score levels')
      const score = num(a.score, 2)
      if (Math.abs(score - probabilities['1'] - 2 * probabilities['2']) > .02) throw new Error('Inconsistent editorial score')
      result[key] = { type: 'score', score, confidence, probabilities,
        legend: Object.fromEntries(entries.map(([k]) => [k, str(legend[k])])) }
    }
  }
  return result
}
export function parseEditorialSummary(value: unknown): EditorialSummary | null {
  if (value == null) return null
  try {
    const v = obj(value), rawScores = answers(v.scores), scores: EditorialSummary['scores'] = {}
    for (const key of scoreNames) { const a = rawScores[key]; if (a?.type === 'score') scores[key] = a }
    return { flags: flags(v.flags), status: str(v.status, 40), scores, qa: answers(v.qa) }
  } catch { return null }
}
function judgment(value: unknown): Judgment {
  const v = obj(value), questions: Judgment['questions'] = {}
  for (const [k, raw] of Object.entries(obj(v.questions ?? {}))) {
    if (!keys.includes(k)) continue
    const q = obj(raw)
    const criteria = Array.isArray(q.criteria) ? list(q.criteria, 10, (x) => str(x)) :
      Object.fromEntries(Object.entries(obj(q.criteria)).slice(0, 10).map(([k, val]) => [str(k, 80), str(val)]))
    questions[k] = { type: str(q.type, 20), instructions: str(q.instructions, 4000), criteria }
  }
  const status = str(v.status, 40)
  if (!statuses.includes(status) || typeof v.cache_hit !== 'boolean') throw new Error('Invalid judgment status')
  return { status, model: str(v.model, 160), requested_model: str(v.requested_model ?? v.model, 160), rule_version: str(v.rule_version, 80), cache_id: str(v.cache_id, 64), cache_hit: v.cache_hit,
    latency_ms: num(v.latency_ms), input_tokens: maybeNumber(v.input_tokens), output_tokens: maybeNumber(v.output_tokens),
    cost_usd: maybeNumber(v.cost_usd), estimated_cost_usd: maybeNumber(v.estimated_cost_usd), answers: answers(v.answers), questions }
}
function observations(value: unknown): Record<string, unknown>[] {
  return list(value ?? [], 24, (x) => { const o = obj(x); return { timestamp_ms: num(o.timestamp_ms), description: str(o.description, 1000),
    provenance: str(o.provenance, 40), model: str(o.model, 160) } })
}
function sourceRow(value: unknown): Record<string, unknown> {
  const r = obj(value)
  return { id: num(r.id, 1000000), start_ms: num(r.start_ms), end_ms: num(r.end_ms),
    text: str(r.text, 30000), speaker: r.speaker == null ? null : str(r.speaker, 100) }
}
function moment(value: unknown): Record<string, unknown> | null {
  if (value == null) return null
  const m = obj(value)
  if (typeof m.requires_visual_context !== 'boolean') throw new Error('Invalid visual requirement')
  return { topic: str(m.topic, 300), topic_interval: span(m.topic_interval), setup: sourceRow(m.setup),
    payoff: sourceRow(m.payoff), requires_visual_context: m.requires_visual_context }
}
function diagnosis(value: unknown): Record<string, unknown> | null {
  if (value == null) return null
  const d = obj(value)
  return { check: str(d.check, 40), segment_id: num(d.segment_id, 1000000), quote: str(d.quote, 1000), explanation: str(d.explanation, 2000) }
}
function evidence(value: unknown): Record<string, unknown> {
  const v = obj(value), result: Record<string, unknown> = {}
  for (const key of ['before', 'after', 'title', 'retained_dialogue']) if (v[key] != null) result[key] = str(v[key], 12000)
  if (v.candidate != null) result.candidate = typeof v.candidate === 'string' ? str(v.candidate, 1000) : span(v.candidate)
  for (const key of ['dialogue_before', 'dialogue_after']) if (v[key]) result[key] = list(v[key], 3, (x) => {
    const s = obj(x); return { start_ms: num(s.start_ms), end_ms: num(s.end_ms), text: str(s.text, 1600) }
  })
  if (v.observed_facts) { const facts = obj(v.observed_facts); result.observed_facts = {
    transcript_speech_gap: facts.transcript_speech_gap === true,
    visual_coverage: facts.visual_coverage == null ? null : str(facts.visual_coverage, 40) } }
  result.visual_observations = observations(v.visual_observations)
  if (v.speaker_context != null) result.speaker_context = str(v.speaker_context, 2000)
  if (v.moment != null) result.moment = moment(v.moment)
  if (v.known_flags) result.known_flags = flags(v.known_flags)
  for (const key of ['audio_tone_available', 'dialogue_truncated']) if (v[key] != null) result[key] = v[key] === true
  return result
}
function visual(value: unknown): Record<string, unknown> | null {
  if (value == null) return null
  const v = obj(value)
  return { status: str(v.status, 40), model: str(v.model, 160), cache_hit: v.cache_hit === true, observations: observations(v.observations),
    attempts: list(v.attempts, 2, (x) => { const a = obj(x); return { sample_times: list(a.sample_times, 12, (n) => num(n)),
      evidence_id: str(a.evidence_id, 64), status: str(a.status ?? 'success', 40),
      model: str(a.model ?? v.model, 160), actual_model: a.actual_model == null ? null : str(a.actual_model, 160), latency_ms: num(a.latency_ms), cost_usd: maybeNumber(a.cost_usd),
      input_tokens: maybeNumber(a.input_tokens), output_tokens: maybeNumber(a.output_tokens) } }) }
}
function candidate(value: unknown): EditorialRecord {
  const v = obj(value)
  return { interval: span(v.interval), sequence: span(v.sequence ?? v.interval), decision: str(v.decision, 40), reason: str(v.reason, 80),
    evidence: evidence(v.evidence), judgment: judgment(v.judgment),
    evidence_history: list(v.evidence_history ?? [v.evidence], 2, evidence),
    layout_segments: list(v.layout_segments ?? [], 14401, (x) => { const s = obj(x); return { start_ms: num(s.start_ms), end_ms: num(s.end_ms), layout: str(s.layout, 40) } }),
    judgment_history: list(v.judgment_history ?? [v.judgment], 2, judgment), visual: visual(v.visual) }
}
export function parseEditorialTrace(value: unknown): EditorialTrace | null {
  if (value == null) return null
  const v = obj(value)
  if (v.version !== 1) throw new Error('Unsupported editorial trace')
  const qa = v.qa == null ? null : obj(v.qa)
  return { coherence: parseCoherence(v.coherence), moment: moment(v.moment), version: 1, candidates: list(v.candidates, 24, candidate), protected_source: list(v.protected_source, 20000, span),
    flags: flags(v.flags), fillers: list(v.fillers ?? [], 12, candidate),
    qa: qa && { evidence: evidence(qa.evidence), judgment: judgment(qa.judgment) },
    duplicates: list(v.duplicates ?? [], 12, (x) => { const d = obj(x), state = obj(d.evidence); return { other_clip: num(d.other_clip, 999), judgment: judgment(d.judgment), evidence: { first: evidence(state.first), second: evidence(state.second) } } }),
    retained_source: list(v.retained_source ?? [], 20000, span),
    prevented_cuts: list(v.prevented_cuts ?? [], 40000, (x) => { const c = obj(x); return { interval: span(c.interval), kind: str(c.kind, 40) } }) }
}
export const defaultWeights: Record<ScoreName, number> = { hook: 1, standalone: 2, arc: 2, quotability: 1, ending: 2 }
export function editorialScore(summary: EditorialSummary | null | undefined, weights = defaultWeights): number | null {
  if (!summary || summary.status !== 'success' || summary.flags.some((f) => /context|payoff|insufficient|unavailable|reaction_candidate_limit/.test(f))) return null
  let total = 0, count = 0
  for (const key of scoreNames) {
    const answer = summary.scores[key], weight = weights[key]
    if (!answer || !Number.isFinite(weight) || weight < 0 || weight > 10) return null
    total += answer.score / 2 * weight; count += weight
  }
  return count > 0 ? total / count : null
}

export interface CoherenceTrace {
  status: string; policy: string; threshold: number; self_contained_threshold?: number; faithful_to_source_threshold?: number; title_supported_threshold?: number; sponsor_threshold?: number; evidence_threshold: number; cut_threshold: number
  original_interval?: [number, number]; accepted_interval?: [number, number]
  reason: string | null; visual_reviews: { interval: [number, number]; result: Record<string, unknown> | null }[]
  attempts: { stage: string; keeps: [number, number][]; decision: string; reason: string; evidence: Record<string, unknown>; judgment: Judgment | null; policy_judgment?: Judgment | null }[]
  repairs: { diagnosis: Record<string, unknown> | null; status: string; model: string; repair_round: number | null; finish_reason: string | null; reasoning_tokens: number | null; cost_usd: number | null; latency_ms: number; proposal: unknown; request_parameters: string | null; response: string | null; usage: Record<string, number | null> | null; request_messages: { role: string; content: string }[]; evidence: Record<string, unknown> }[]
}
function parseCoherence(value: unknown): CoherenceTrace | null {
  if (value == null) return null
  const v = obj(value)
  return { status: str(v.status, 40), policy: str(v.policy, 80), threshold: num(v.threshold, 1), cut_threshold: num(v.cut_threshold, 1),
    evidence_threshold: num(v.evidence_threshold ?? v.threshold, 1),
    ...(v.self_contained_threshold == null ? {} : { self_contained_threshold: num(v.self_contained_threshold, 1) }),
    ...(v.faithful_to_source_threshold == null ? {} : { faithful_to_source_threshold: num(v.faithful_to_source_threshold, 1) }),
    ...(v.title_supported_threshold == null ? {} : { title_supported_threshold: num(v.title_supported_threshold, 1) }),
    ...(v.sponsor_threshold == null ? {} : { sponsor_threshold: num(v.sponsor_threshold, 1) }),
    reason: v.reason == null ? null : str(v.reason, 80),
    visual_reviews: list(v.visual_reviews ?? [], 3, (x) => { const r = obj(x); return { interval: span(r.interval), result: visual(r.result) } }),
    ...(v.original_interval ? { original_interval: span(v.original_interval) } : {}),
    ...(v.accepted_interval ? { accepted_interval: span(v.accepted_interval) } : {}),
    attempts: list(v.attempts, 48, (x) => { const a = obj(x), e = obj(a.evidence); return {
      stage: str(a.stage, 40), keeps: list(a.keeps, 20000, span), decision: str(a.decision, 40), reason: str(a.reason, 80),
      evidence: { ...evidence(e), ...(e.removed_text != null ? { removed_text: str(e.removed_text, 12000) } : {}),
        ...(e.interval ? { interval: span(e.interval) } : {}),
        ...(e.overlapping_layouts ? { overlapping_layouts: list(e.overlapping_layouts, 14401, (x) => str(x, 40)) } : {}) },
      judgment: a.judgment == null ? null : judgment(a.judgment),
      policy_judgment: a.policy_judgment == null ? null : judgment(a.policy_judgment) } }),
    repairs: list(v.repairs, 4, (x) => { const r = obj(x), e = obj(r.evidence); return {
      diagnosis: diagnosis(r.diagnosis), status: str(r.status, 40), model: str(r.model, 160), cost_usd: maybeNumber(r.cost_usd), latency_ms: num(r.latency_ms),
      repair_round: r.repair_round == null ? null : num(r.repair_round, 2),
      finish_reason: r.finish_reason == null ? null : str(r.finish_reason, 80), reasoning_tokens: maybeNumber(r.reasoning_tokens),
      request_parameters: r.request_parameters == null ? null : str(r.request_parameters, 40000),
      response: r.response == null ? null : str(r.response, 100000), usage: parseUsage(r.usage),
      request_messages: list(r.request_messages ?? [], 2, (x) => { const m = obj(x); return { role: str(m.role, 40), content: str(m.content, 40000) } }),
      proposal: r.proposal == null ? null : (() => { const p = list(r.proposal, 3, x => x); if (p.length !== 3) throw new Error('Invalid proposal'); return [num(p[0]), num(p[1]), str(p[2], 200)] })(),
      evidence: Object.keys(e).length === 0 ? {} : { candidate: span(e.candidate), title: e.title == null ? '' : str(e.title, 2000),
        failed_checks: list(e.failed_checks ?? [], 8, (x) => { const f = obj(x); return { name: str(f.name, 40), question: str(f.question, 4000),
          criteria: Object.fromEntries(Object.entries(obj(f.criteria ?? {})).slice(0, 10).map(([key, value]) => [str(key, 80), str(value, 4000)])),
          probability: num(f.probability, 1), required_probability: num(f.required_probability, 1) } }),
        previous_proposals: list(e.previous_proposals ?? [], 4, (x) => { const p = list(x, 3, x => x); if (p.length !== 3) throw new Error('Invalid previous proposal'); return [num(p[0]), num(p[1]), str(p[2], 200)] }),
        source_segments: list(e.source_segments, 200, sourceRow), moment: moment(e.moment),
        judgments: answers(e.judgments) } } }) }
}

export interface EditAudit {
  version: 1; title: string; duration_ms: number; preferred_range: (number | null)[]; outcome: string
  transcript: { start_ms: number; end_ms: number; text: string; speaker: string | null }[]
  discovery: Record<string, unknown> | null
  planner: { requests: { discovery_pass: number; model: string; requested_model: string; request_parameters: string | null; status: string; messages: { role: string; content: string }[]; response: string | null; usage: Record<string, number | null> | null }[] }
  candidates: { discovery_pass: number; candidate_index: number; title: string; original_interval: [number, number]; clip_index: number | null; status: string; report: EditorialTrace | null }[]
}
export function parseEditAudit(value: unknown): EditAudit {
  const v = obj(value), planner = obj(v.planner)
  if (v.version !== 1) throw new Error('Unsupported edit trace')
  return { version: 1, title: str(v.title, 2000), duration_ms: num(v.duration_ms),
    preferred_range: list(v.preferred_range, 2, maybeNumber), outcome: str(v.outcome, 80),
    discovery: v.discovery == null ? null : (() => { const d = obj(v.discovery); return { status: str(d.status, 40), search_intervals: list(d.search_intervals, 6, span), previous_candidates: list(d.previous_candidates, 100, (x) => { const c = obj(x); return { interval: span(c.interval), title: str(c.title, 2000), status: str(c.status, 40) } }) } })(),
    transcript: list(v.transcript, 100000, (x) => { const t = obj(x); return { start_ms: num(t.start_ms), end_ms: num(t.end_ms), text: str(t.text, 100000), speaker: t.speaker == null ? null : str(t.speaker, 100) } }),
    planner: { requests: list(planner.requests, 4, (x) => { const r = obj(x); return {
      discovery_pass: num(r.discovery_pass ?? 1, 2), model: str(r.model, 160), requested_model: str(r.requested_model ?? r.model, 160),
      request_parameters: r.request_parameters == null ? null : str(r.request_parameters, 40000), status: str(r.status, 40), response: r.response == null ? null : str(r.response, 1000000),
      messages: list(r.messages, 5, (x) => { const m = obj(x); return { role: str(m.role, 40), content: typeof m.content === 'string' ? str(m.content, 8000000) : list(m.content, 100, (x) => str(obj(x).text, 8000000)).join('\n') } }),
      usage: parseUsage(r.usage) } }) },
    candidates: list(v.candidates, 100, (x) => { const c = obj(x); return { discovery_pass: num(c.discovery_pass ?? 1, 2), candidate_index: num(c.candidate_index, 999), title: str(c.title, 2000),
      original_interval: span(c.original_interval), clip_index: maybeNumber(c.clip_index), status: str(c.status, 40), report: parseEditorialTrace(c.report) } }) }
}

function parseUsage(value: unknown): Record<string, number | null> | null {
  return value == null ? null : Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens', 'cost'].map(k => [k, maybeNumber(obj(value)[k])]))
}
