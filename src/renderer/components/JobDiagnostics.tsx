import { PREPARATION_PHASES, type RunDiagnostics } from '../../shared/run-diagnostics'
import { STAGE_NAMES } from '../../shared/job-progress'
import { formatTimecode } from '../lib/utils'

const count = (value: number): string => new Intl.NumberFormat().format(value)
const dollars = (value: number): string => `$${value.toFixed(value > 0 && value < .01 ? 5 : 4)}`
export function JobDiagnostics({ diagnostics, saved = false }: { diagnostics?: RunDiagnostics; saved?: boolean }): React.JSX.Element {
  const rows = diagnostics?.models ?? []
  const preparation = diagnostics?.preparation
  const knownCost = rows.reduce((sum, row) => sum + row.cost_usd, 0)
  const hasReportedCost = rows.some(row => row.requests - row.active > row.unknown_cost)
  const incomplete = rows.some(row => row.unknown_cost > 0 || row.active > 0)
  const phases = Object.entries(preparation?.timings ?? {}) as [keyof typeof PREPARATION_PHASES, number][]
  return <div className="mt-5 space-y-4 border-t border-white/[0.08] pt-5">
    {preparation && <section aria-label="Candidate preparation details" className="rounded-2xl border border-orange-300/15 bg-orange-300/[0.03] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="eyebrow text-orange-300">Inside frame &amp; review</p>
        <h2 className="mt-1 text-sm font-medium text-ink">{!saved ? `Candidate ${preparation.candidate} of ${preparation.total}` : 'Candidate preparation'}</h2></div>
        <span className="font-mono text-xs text-ink-muted">{formatTimecode(preparation.source_duration_ms)} source excerpt</span></div>
      {preparation.phase && !saved && <div className="mt-3"><div className="flex justify-between gap-3 text-xs"><span>{PREPARATION_PHASES[preparation.phase]}</span><span className="font-mono text-ink-muted">{formatTimecode(preparation.phase_elapsed_ms)}{preparation.percent != null ? ` · ${Math.floor(preparation.percent)}%` : ''}</span></div>
        <progress className="stage-progress mt-2 h-1.5 w-full" aria-label="Current preparation task" max={100} {...(preparation.percent == null ? {} : { value: preparation.percent })} /></div>}
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">{phases.map(([phase, ms]) => <div key={phase} className="rounded-lg bg-black/15 px-2.5 py-2">
        <p className="text-2xs text-ink-muted">{PREPARATION_PHASES[phase]}</p><p className="mt-1 font-mono text-xs tabular text-ink">{formatTimecode(ms)}</p>
      </div>)}</div>
      <p className="mt-3 text-2xs leading-relaxed text-ink-subtle">Times accumulate across candidates. Face sampling, camera scans and tracking run locally. Shot-layout checks may use a vision model; Jev reviews the edit’s meaning.</p>
    </section>}
    <section aria-label="Model usage and cost">
      <div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-sm font-medium text-ink">{saved ? 'Model usage' : 'Live model usage'}</h2>
        <p className="mt-1 text-2xs text-ink-subtle">Requested models · updates after each provider response</p></div>
        <div className="text-right"><p className="font-mono text-lg tabular text-ink">{hasReportedCost ? dollars(knownCost) : '—'}</p><p className="text-2xs text-ink-subtle">{incomplete ? 'Reported so far · partial' : 'Provider-reported cost'}</p></div></div>
      {rows.length ? <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-xs"><thead className="border-b border-white/[0.08] text-2xs text-ink-subtle"><tr>
        <th className="pb-2 font-normal">Model / stage</th><th className="px-3 pb-2 text-right font-normal">Calls</th><th className="px-3 pb-2 text-right font-normal">Input / output tokens</th><th className="pb-2 text-right font-normal">Cost</th>
      </tr></thead><tbody>{rows.map(row => <tr key={`${row.stage}:${row.model}`} className="border-b border-white/[0.04] last:border-0">
        <td className="py-3"><p className="break-all font-medium text-ink">{row.model}</p><p className="mt-1 text-2xs text-ink-subtle">{STAGE_NAMES[row.stage]}{row.active ? ` · ${row.active} in progress` : ''}{row.failed ? ` · ${row.failed} failed` : ''}</p></td>
        <td className="px-3 py-3 text-right font-mono tabular text-ink-muted">{row.requests}</td>
        <td className="px-3 py-3 text-right font-mono tabular text-ink-muted">{row.unknown_usage === row.requests - row.active && row.input_tokens + row.output_tokens === 0 ? '—' : `${count(row.input_tokens)} / ${count(row.output_tokens)}`}{row.unknown_usage > 0 && row.input_tokens + row.output_tokens > 0 ? ' +' : ''}</td>
        <td className="py-3 text-right font-mono tabular text-ink-muted">{row.unknown_cost === row.requests - row.active && row.cost_usd === 0 ? '—' : dollars(row.cost_usd)}{row.unknown_cost > 0 && row.cost_usd > 0 ? ' +' : ''}</td>
      </tr>)}</tbody></table></div> : <p className="mt-3 rounded-xl bg-white/[0.025] px-3 py-4 text-xs text-ink-muted">{diagnostics ? 'No model requests yet. Local video processing does not use tokens.' : 'Usage details appear on jobs started with the updated engine.'}</p>}
      <p className="mt-2 text-2xs leading-relaxed text-ink-subtle">Unreported usage is shown as —, not zero. Audio models may report cost without tokens. Partial totals exclude missing charges and unfinished calls; cached Jev results add no requests.</p>
    </section>
  </div>
}
