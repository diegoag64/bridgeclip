import { JsonViewer } from './ui/JsonViewer'
import { defaultWeights, scoreNames, type EditorialTrace, type Judgment, type ScoreName } from '../../shared/editorial'
import { formatTimecode } from '../lib/utils'

const label = (value: string): string => value.replaceAll('_', ' ')

export function EditorialWeights({ value, onChange }: { value: Record<ScoreName, number>; onChange: (value: Record<ScoreName, number>) => void }): React.JSX.Element {
  return <details className="rounded-xl border border-white/10 p-3 text-xs">
    <summary className="cursor-pointer text-ink-muted">Editorial ranking weights</summary>
    <p className="my-3 text-ink-subtle">Reweight recorded judgments locally. No new AI calls. Missing context or an unresolved payoff requires review regardless of the hook score. These are editorial preferences, not predictions of views.</p>
    <div className="grid gap-3 sm:grid-cols-5">{scoreNames.map((key) => <label key={key} className="capitalize">{key} · {value[key]}
      <input aria-label={`${key} weight`} type="range" min={0} max={5} step={1} value={value[key]} className="mt-2 block w-full" onChange={(e) => onChange({ ...value, [key]: Number(e.target.value) })} />
    </label>)}</div>
    <button type="button" className="mt-3 text-purple-300" onClick={() => onChange({ ...defaultWeights })}>Reset weights</button>
  </details>
}

function JudgmentDetails({ value }: { value: Judgment }): React.JSX.Element {
  return <div className="space-y-2 text-xs">
    <p className="text-ink-subtle">{value.model} · {value.rule_version} · {label(value.status)} · {value.cache_hit ? 'Cached result' : `${value.latency_ms} ms`}</p>
    <p className="text-ink-subtle">{value.input_tokens ?? 'Unknown'} input tokens · {value.output_tokens ?? 'Unknown'} output tokens · {value.estimated_cost_usd == null ? 'Cost unavailable' : `Estimated $${value.estimated_cost_usd.toFixed(6)}`} · billed cost {value.cost_usd == null ? 'not reported' : `$${value.cost_usd.toFixed(6)}`}</p>
    <table className="w-full text-left"><thead><tr className="text-ink-subtle"><th className="py-1 font-normal">Question</th><th className="font-normal">Judgment</th><th className="font-normal">Distribution concentration</th></tr></thead>
      <tbody>{Object.entries(value.answers).map(([key, a]) => <tr key={key} className="border-t border-white/5">
        <td className="py-2 pr-3">{label(key)}</td><td>{a.type === 'noul' ? `${(a.noul * 100).toFixed(1)}% yes` : a.type === 'score' ? `${a.score.toFixed(2)} / ${Object.keys(a.legend).length - 1}` : label(a.choice)}</td>
        <td>{a.type === 'noul' ? '—' : `${(a.confidence * 100).toFixed(1)}%`}</td>
      </tr>)}</tbody></table>
    <p className="text-ink-subtle">Noul is probability of yes. Concentration describes the answer distribution, not correctness.</p>
    <details><summary className="cursor-pointer text-ink-muted">Questions, distributions and cache provenance</summary><JsonViewer className="mt-3" value={value} /></details>
  </div>
}

export function RecordedEditorialReview({ trace, seek }: { trace: EditorialTrace; seek: (sourceMs: number) => void }): React.JSX.Element {
  return <section className="space-y-4 rounded-2xl border border-white/10 p-4" aria-label="Recorded editorial review">
    <h3 className="text-sm font-semibold">Reaction context & editorial review</h3>
    <p className="text-xs text-ink-subtle">Saved evidence from this run. Opening this view makes no model calls. Uncertain context is kept. Runs with coherence gating omit candidates that cannot pass review.</p>
    {trace.flags.length > 0 && <ul className="list-inside list-disc text-xs text-amber-200">{[...new Set(trace.flags)].map((flag) => <li key={flag}>{label(flag)}</li>)}</ul>}
    <div className="flex flex-wrap gap-2">{trace.protected_source.map(([a, b], i) => <button key={i} className="rounded bg-emerald-950 px-2 py-1 text-xs text-emerald-200" onClick={() => seek(a)}>
      Protected {formatTimecode(a)}–{formatTimecode(b)}
    </button>)}</div>
    <p className="text-xs text-ink-muted">{trace.prevented_cuts.length} proposed cut{trace.prevented_cuts.length === 1 ? '' : 's'} prevented by protection</p>
    {trace.candidates.map((candidate, i) => <details key={i} className="rounded-lg border border-white/10 p-3">
      <summary className="cursor-pointer text-xs">{formatTimecode(candidate.interval[0])}–{formatTimecode(candidate.interval[1])} · {label(candidate.decision)} · {label(candidate.reason)}</summary>
      <div className="mt-3 space-y-3"><JudgmentDetails value={candidate.judgment} />
        <details><summary className="cursor-pointer text-xs text-ink-muted">Observed facts, dialogue and visual inferences</summary><JsonViewer className="mt-3" value={{ evidence: candidate.evidence, overlappingLayouts: candidate.layout_segments, visual: candidate.visual, evaluations: candidate.judgment_history.map((judgment, i) => ({ judgment, evidence: candidate.evidence_history[i] })) }} /></details>
      </div>
    </details>)}
    {trace.qa && <details className="rounded-lg border border-white/10 p-3"><summary className="cursor-pointer text-xs">Final retained clip · context, title and editorial scores</summary>
      <div className="mt-3"><JudgmentDetails value={trace.qa.judgment} /></div>
      <JsonViewer className="mt-3" value={trace.qa.evidence} />
    </details>}
    {trace.fillers.length > 0 && <details><summary className="cursor-pointer text-xs">Acknowledgments & hesitation</summary>
      <JsonViewer className="mt-3" value={trace.fillers} /></details>}
    {trace.duplicates.map((d, i) => <details key={i}><summary className="cursor-pointer text-xs">Takeaway comparison with clip {d.other_clip + 1} · review only</summary><JudgmentDetails value={d.judgment} /><JsonViewer className="mt-3" value={d.evidence} /></details>)}
  </section>
}
