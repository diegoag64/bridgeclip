import { useId, useMemo, useState } from 'react'
import type { CoherenceTrace, EditorialRecord, EditorialTrace, Judgment, JudgmentAnswer } from '../../shared/editorial'
import { formatTimecode } from '../lib/utils'

const label = (value: string): string => value.replaceAll('_', ' ')
const percent = (value: number): string => `${(value * 100).toFixed(1)}%`
const intervals = (spans: [number, number][]): string => spans.map(([a, b]) => `${formatTimecode(a)}–${formatTimecode(b)}`).join(', ')

type Entry = {
  group: string; title: string; decision: string; reason: string; range: string
  judgment: Judgment | null; evidence: Record<string, unknown> | undefined
  coherence?: CoherenceTrace; stage?: string
}

/** Preserve individual requests, including policy calls and every evidence retry. */
export function jevTraceEntries(trace: EditorialTrace): Entry[] {
  const entries: Entry[] = []
  const coherence = trace.coherence
  coherence?.attempts.forEach((attempt, i) => {
    const base = { group: 'Coherence & cuts', title: `${i + 1}. ${label(attempt.stage)}`, decision: attempt.decision,
      reason: attempt.reason, range: intervals(attempt.keeps), evidence: attempt.evidence, coherence, stage: attempt.stage }
    entries.push({ ...base, judgment: attempt.judgment })
    if (attempt.policy_judgment) entries.push({ ...base, title: `${base.title} · sponsorship & opening`, judgment: attempt.policy_judgment })
  })
  const records = (group: string, rows: EditorialRecord[]): void => rows.forEach((row, i) => {
    const history = row.judgment_history.length ? row.judgment_history : [row.judgment]
    history.forEach((judgment, j) => entries.push({ group, title: `${i + 1}. Evaluation ${j + 1}`, judgment,
      // Only the final evaluation has the record's final decision attached.
      decision: j === history.length - 1 ? row.decision : 'superseded', reason: j === history.length - 1 ? row.reason : 'later_evidence_review',
      range: intervals([row.interval]), evidence: row.evidence_history[j] }))
  })
  records('Reaction context', trace.candidates)
  records('Fillers & acknowledgments', trace.fillers)
  if (trace.qa) entries.push({ group: 'Final quality review', title: 'Retained clip', judgment: trace.qa.judgment,
    evidence: trace.qa.evidence, decision: 'recorded', reason: '', range: intervals(trace.retained_source) })
  trace.duplicates.forEach(row => entries.push({ group: 'Duplicate comparisons', title: `Compared with clip ${row.other_clip + 1}`,
    judgment: row.judgment, evidence: row.evidence, decision: 'advisory', reason: '', range: '' }))
  return entries
}

export function jevQuestionGate(key: string, answer: JudgmentAnswer | undefined, entry: Entry): { passed: boolean; required: string } | null {
  const trace = entry.coherence
  if (!trace || !answer || entry.judgment?.status !== 'success') return null
  if (key === 'evidence' && answer.type === 'choice') {
    return { passed: (answer.probabilities.sufficient ?? 0) >= trace.evidence_threshold,
      required: `Sufficient evidence ≥ ${percent(trace.evidence_threshold)}` }
  }
  if (answer.type !== 'noul') return null
  const contentThresholds: Record<string, number | undefined> = {
    self_contained: trace.self_contained_threshold,
    faithful_to_source: trace.faithful_to_source_threshold,
    title_supported: trace.title_supported_threshold
  }
  const threshold = key === 'not_sponsored' ? trace.sponsor_threshold : entry.stage === 'cut' ? trace.cut_threshold : (contentThresholds[key] ?? trace.threshold)
  // Older traces may not record a sponsor threshold. Do not invent one.
  if (threshold == null) return null
  return { passed: answer.noul >= threshold, required: `Yes probability ≥ ${percent(threshold)}` }
}

function QuestionResult({ name, entry }: { name: string; entry: Entry }): React.JSX.Element {
  const question = entry.judgment?.questions[name], answer = entry.judgment?.answers[name]
  const gate = jevQuestionGate(name, answer, entry)
  const criteria = question?.criteria
  const definitions = criteria && typeof criteria === 'object' ? Object.entries(criteria) : []
  return <article className="space-y-2 rounded-lg border border-white/10 p-3" aria-label={`Jev question: ${label(name)}`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="text-sm font-semibold capitalize">{label(name)}</h4>
      {gate && <span className={`rounded px-2 py-1 text-xs font-medium ${gate.passed ? 'bg-emerald-950 text-emerald-200' : 'bg-amber-950 text-amber-200'}`}>{gate.passed ? 'Pass' : 'Below threshold'}</span>}
    </div>
    <p className="whitespace-pre-wrap text-sm">{question?.instructions || 'Exact question text was not saved for this evaluation.'}</p>
    {answer ? <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
      <span className="font-semibold">{answer.type === 'noul' ? `${percent(answer.noul)} yes` : answer.type === 'choice' ? `Result: ${label(answer.choice)} · ${percent(answer.probabilities[answer.choice])}` : `Score: ${answer.score.toFixed(2)} / 2`}</span>
      {answer.type !== 'noul' && <span className="text-xs text-ink-muted">Confidence (distribution concentration): {percent(answer.confidence)}</span>}
      {gate && <span className="text-xs text-ink-muted">Required: {gate.required}</span>}
    </div> : <p className="text-xs text-amber-200">No answer recorded · {label(entry.judgment?.status ?? 'not requested')}</p>}
    {answer && answer.type !== 'noul' && <ul className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink-muted" aria-label="Answer probabilities">
      {Object.entries(answer.probabilities).map(([option, probability]) => <li key={option}>{label(option)}: {percent(probability)}{answer.type === 'score' && ` · ${answer.legend[option]}`}</li>)}
    </ul>}
    {definitions.length > 0 && <details className="text-xs"><summary className="cursor-pointer text-purple-300">Exact answer criteria</summary><dl className="mt-2 space-y-2">
      {definitions.map(([option, meaning]) => <div key={option}><dt className="font-medium capitalize">{option === 'true' ? 'Yes' : option === 'false' ? 'No' : label(option)}</dt><dd className="mt-1 whitespace-pre-wrap text-ink-muted">{String(meaning)}</dd></div>)}
    </dl></details>}
  </article>
}

export function JevTrace({ trace }: { trace: EditorialTrace | null }): React.JSX.Element {
  const entries = useMemo(() => trace ? jevTraceEntries(trace) : [], [trace])
  const [selected, setSelected] = useState(0)
  const selectId = useId()
  const entry = entries[selected] ?? entries[0]
  if (!entry) return <p className="rounded-xl border border-white/10 p-4 text-sm text-ink-muted">No Jev question trace was recorded for this candidate. Older runs may only have a transcript.</p>
  const judgment = entry.judgment
  const names = [...new Set([...Object.keys(judgment?.questions ?? {}), ...Object.keys(judgment?.answers ?? {})])]
  const failures = names.filter(name => jevQuestionGate(name, judgment?.answers[name], entry)?.passed === false)
  const unanswered = names.filter(name => !judgment?.answers[name])
  return <section className="space-y-4" aria-label="Jev questions and results">
    <div>
      <h3 className="sr-only">Jev questions & results</h3>
      <p className="text-xs text-ink-muted">{entries.filter(e => e.judgment).length} saved requests across coherence, cuts and context reviews.</p>
    </div>
    <div className="space-y-2">
      <label htmlFor={selectId} className="text-xs text-ink-muted">Evaluation</label>
      <select id={selectId} aria-label="Jev evaluation" value={selected} onChange={e => setSelected(Number(e.target.value))} className="block w-full min-w-0 rounded-lg border border-white/15 bg-surface px-3 py-2 text-sm">
        {[...new Set(entries.map(e => e.group))].map(group => <optgroup key={group} label={group}>
          {entries.map((e, i) => e.group === group && <option key={i} value={i}>{e.title} · {label(e.decision)} · {label(e.judgment?.status ?? 'not requested')}</option>)}
        </optgroup>)}
      </select>
      <div className="flex items-center gap-3 text-xs"><button className="text-purple-300 disabled:opacity-40" disabled={selected === 0} onClick={() => setSelected(selected - 1)}>Previous evaluation</button>
        <span>{selected + 1} of {entries.length}</span><button className="text-purple-300 disabled:opacity-40" disabled={selected >= entries.length - 1} onClick={() => setSelected(selected + 1)}>Next evaluation</button></div>
    </div>
    <div className="rounded-lg bg-white/5 p-3 text-xs">
      <p className="font-medium capitalize">Recorded decision: {label(entry.decision)}{entry.reason && ` · ${label(entry.reason)}`}</p>
      {entry.range && <p className="mt-1 text-ink-muted">Source intervals: {entry.range}</p>}
      {failures.length > 0 && <p className="mt-2 text-amber-200">Below threshold: {failures.map(label).join(', ')}.</p>}
      {unanswered.length > 0 && <p className="mt-2 text-amber-200">{unanswered.length} questions have no recorded answer.</p>}
    </div>
    {judgment && <p className="break-words text-xs text-ink-muted">{judgment.model} · {label(judgment.status)} · {judgment.cache_hit ? 'Cached result' : `${judgment.latency_ms} ms`}</p>}
    <div className="space-y-3">{names.map(name => <QuestionResult key={name} name={name} entry={entry} />)}
      {names.length === 0 && <p className="text-sm text-ink-muted">{judgment ? 'No questions or answers were saved for this evaluation.' : 'Jev was not called for this evaluation. The recorded reason above explains the skipped check.'}</p>}
    </div>
    <details className="text-xs text-ink-muted"><summary className="cursor-pointer">How to read probabilities & confidence</summary>
      <p className="mt-2">Yes percentages are Jev’s probability of “yes.” For choices and scores, confidence describes distribution concentration, not guaranteed correctness. The recorded decision also accounts for evidence and edit constraints.</p>
    </details>
    <details className="rounded-lg border border-white/10 p-3 text-xs"><summary className="cursor-pointer text-purple-300">Saved input evidence · transcript & context</summary>
      <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words">{entry.evidence ? JSON.stringify(entry.evidence, null, 2) : 'Input evidence was not saved for this evaluation.'}</pre>
    </details>
    {judgment && <details className="rounded-lg border border-white/10 p-3 text-xs"><summary className="cursor-pointer text-ink-muted">Full saved request / result · model, tokens, cost & cache</summary>
      <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify({ state: entry.evidence, ...judgment }, null, 2)}</pre>
    </details>}
  </section>
}
