import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { EditAudit } from '../../shared/editorial'
import { getApi } from '../lib/ipc'
import { errorMessage, formatTimecode } from '../lib/utils'
import { Dialog } from './ui/Dialog'
import { Button } from './ui/Button'
import { JevTrace } from './JevTrace'

export function EditInspector({ outputDir, onClose }: { outputDir: string; onClose: () => void }): React.JSX.Element {
  const panel = useRef<HTMLDivElement>(null)
  const [audit, setAudit] = useState<EditAudit | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    setAudit(null)
    setError(null)
    Promise.resolve().then(() => getApi().edits.inspect(outputDir)).then(v => { if (active) setAudit(v) }).catch(e => { if (active) setError(errorMessage(e, 'No saved transcript or edit trace is available.')) })
    return () => { active = false }
  }, [outputDir])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    panel.current?.focus()
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
      if (e.key === 'Tab') {
        const items = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, summary, [tabindex="0"]') ?? [])].filter(item => item.getClientRects().length > 0)
        if (e.shiftKey && (document.activeElement === items[0] || document.activeElement === panel.current)) { e.preventDefault(); items.at(-1)?.focus() }
        else if (!e.shiftKey && document.activeElement === items.at(-1)) { e.preventDefault(); items[0]?.focus() }
      }
    }
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('keydown', key); previous?.focus() }
  }, [onClose])
  return <Dialog ref={panel} aria-label="Inspect transcript and edits" panelClassName="max-w-[1400px]" onBackdropMouseDown={onClose}>
    <header className="flex items-center justify-between border-b border-white/10 px-5 py-3"><div><p className="text-2xs uppercase text-ink-subtle">Recorded decisions · read only</p><h2 className="text-lg font-semibold">Transcript & edit trace</h2></div>
      <Button iconOnly variant="ghost" aria-label="Close edit inspector" icon={<X className="h-5 w-5" />} onClick={onClose} /></header>
    <div className="overflow-y-auto p-5">{error ? <p role="alert">{error}</p> : audit ? <RecordedEditView audit={audit} /> : <p>Loading saved transcript and decisions…</p>}</div>
  </Dialog>
}

export function RecordedEditView({ audit }: { audit: EditAudit }): React.JSX.Element {
  const [selected, setSelected] = useState(0), [query, setQuery] = useState(''), [wholeSource, setWholeSource] = useState(false), [page, setPage] = useState(0)
  const [view, setView] = useState<'jev' | 'transcript'>(audit.outcome === 'legacy_transcript_only' ? 'transcript' : 'jev')
  const candidate = audit.candidates[selected]
  const coherence = candidate?.report?.coherence
  const accepted = coherence?.status === 'rejected' ? undefined : [...(coherence?.attempts ?? [])].reverse().find(a => a.decision === 'accept' && a.stage !== 'cut')
  const range = coherence?.accepted_interval ?? candidate?.original_interval
  const lines = useMemo(() => audit.transcript.filter(t => (!query || t.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())) &&
    (wholeSource || !range || (t.end_ms > range[0] - 30000 && t.start_ms < range[1] + 30000))), [audit, query, wholeSource, range])
  return <div className="space-y-5">
    <div><h3 className="font-semibold">{audit.title}</h3><p className="mt-1 text-xs text-ink-muted">{audit.outcome === 'legacy_transcript_only' ? 'Saved transcript · no decision records' : `${audit.outcome.replaceAll('_', ' ')} · ${audit.candidates.length} candidates · ${audit.candidates.filter(c => c.status === 'rendered').length} rendered`}</p>
      {audit.preferred_range.some(t => t != null) && <p className="mt-1 text-xs text-ink-muted">Preferred range: {formatTimecode((audit.preferred_range[0] ?? 0) * 1000)}–{formatTimecode(audit.preferred_range[1] == null ? audit.duration_ms : audit.preferred_range[1] * 1000)}. Complete excerpts may extend beyond it.</p>}
      <p className="mt-2 text-xs text-ink-subtle">Exact saved evidence, requests and answers. The rules explain acceptance and rejection; this is not hidden model reasoning. Opening this view makes no AI calls.</p>
      {audit.outcome === 'legacy_transcript_only' && <p className="mt-2 text-xs text-amber-200">This older run has a transcript but no saved edit trace. It may cover only the previously selected range. Regenerate it to record full-source context and decisions.</p>}</div>
    <details className="rounded-xl border border-white/10 p-3"><summary className="cursor-pointer text-sm">Planner requests & candidate discovery ({audit.planner.requests.length})</summary>
      <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify({ ...audit.planner, second_discovery: audit.discovery }, null, 2)}</pre></details>
    <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
      <nav aria-label="Candidate edits" className="space-y-2">{audit.candidates.map((c, i) => <button key={c.candidate_index} aria-pressed={i === selected}
        onClick={() => { setSelected(i); setPage(0) }} className={`block w-full rounded-xl border p-3 text-left text-xs ${i === selected ? 'border-purple-400 bg-purple-950/30' : 'border-white/10'}`}>
        <span className="block font-medium">Candidate {c.candidate_index + 1} · {c.title || 'Untitled'}</span><span className="mt-1 block text-ink-muted">Discovery {c.discovery_pass ?? 1} · {c.status.replaceAll('_', ' ')}{c.clip_index != null ? ` · Clip ${c.clip_index + 1}` : ''}</span>
      </button>)}</nav>
      <section className="min-w-0 space-y-3">
        <div role="group" aria-label="Inspection view" className="flex flex-wrap gap-2 border-b border-white/10 pb-3">
          {(['jev', 'transcript'] as const).map(tab => <button key={tab} aria-pressed={view === tab} onClick={() => setView(tab)}
            className={`rounded-lg px-3 py-2 text-sm ${view === tab ? 'bg-purple-950/50 text-purple-200' : 'text-ink-muted hover:bg-white/5'}`}>
            {tab === 'jev' ? 'Jev questions & results' : 'Transcript & edit details'}
          </button>)}
        </div>
        <div hidden={view !== 'jev'}><JevTrace key={candidate?.candidate_index ?? 'empty'} trace={candidate?.report ?? null} /></div>
        <div hidden={view !== 'transcript'} className="space-y-3">
        <h3 className="text-sm font-semibold">Transcript context {range && `· ${formatTimecode(range[0])}–${formatTimecode(range[1])}`}</h3>
        {candidate && <p className="text-xs text-ink-muted">Original proposal: {formatTimecode(candidate.original_interval[0])}–{formatTimecode(candidate.original_interval[1])}. Green indicates retained speech in the last approved edit; amber indicates omitted speech. Unapproved candidates have no retained highlight.</p>}
        <div className="flex flex-wrap gap-4 text-xs"><input aria-label="Search transcript" placeholder="Search transcript…" value={query} onChange={e => { setQuery(e.target.value); setPage(0) }} className="rounded border border-white/10 bg-black/20 px-3 py-2" />
          <label className="flex items-center gap-2"><input type="checkbox" checked={wholeSource} onChange={e => { setWholeSource(e.target.checked); setPage(0) }} />Full saved transcript</label></div>
        <div className="max-h-96 space-y-1 overflow-y-auto rounded-xl border border-white/10 p-3" aria-label="Transcript passages">{lines.slice(page * 100, (page + 1) * 100).map((t, i) => {
          const kept = accepted?.keeps.some(([a, b]) => a < t.end_ms && b > t.start_ms)
          const inside = range && range[0] < t.end_ms && range[1] > t.start_ms
          return <p key={`${t.start_ms}:${i}`} className={`rounded p-2 text-sm ${kept ? 'bg-emerald-950/40' : inside && accepted ? 'bg-amber-950/40' : 'text-ink-muted'}`}><span className="mr-3 font-mono text-2xs">{formatTimecode(t.start_ms)}–{formatTimecode(t.end_ms)}</span>{t.speaker && <span className="mr-2 text-xs text-purple-300">{t.speaker}</span>}{t.text}</p>
        })}{lines.length === 0 && <p className="text-sm text-ink-muted">No matching transcript passages.</p>}</div>
        <div className="flex items-center gap-3 text-xs"><button disabled={page === 0} onClick={() => setPage(page - 1)}>Previous passages</button><span>{Math.min(page * 100 + 1, lines.length)}–{Math.min((page + 1) * 100, lines.length)} of {lines.length}</span><button disabled={(page + 1) * 100 >= lines.length} onClick={() => setPage(page + 1)}>Next passages</button></div>
        {candidate?.report?.moment && <details className="rounded-xl border border-white/10 p-3"><summary className="cursor-pointer text-sm">Proposed topic, setup and payoff</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(candidate.report.moment, null, 2)}</pre></details>}
        {coherence && <section className="space-y-3 rounded-xl border border-white/10 p-3"><h3 className="text-sm font-semibold">Coherence decisions · {coherence.status}</h3>
          <p className="text-xs text-ink-muted">Self-contained must reach {(coherence.self_contained_threshold ?? coherence.threshold) * 100}%. Faithful to source must reach {(coherence.faithful_to_source_threshold ?? coherence.threshold) * 100}%. Title supported must reach {(coherence.title_supported_threshold ?? coherence.threshold) * 100}%. Other content checks must reach {coherence.threshold * 100}%. {coherence.sponsor_threshold != null && <>Confidence that the clip is not sponsored must reach {coherence.sponsor_threshold * 100}%. </>}Sufficient evidence must reach {(coherence.evidence_threshold ?? coherence.threshold) * 100}%. Individual removals require {coherence.cut_threshold * 100}%. Unknown removals are restored. Unverified clips are omitted.</p>
          {coherence.reason === 'sponsored_or_uncertain_promotion' && <p className="text-xs text-amber-200">Omitted because the segment was promotional or could not be confidently cleared of sponsorship. Sponsor disclosures are not trimmed to turn ads into clips.</p>}
          {coherence.reason === 'needs_visual_evidence' && <p className="text-xs text-amber-200">This candidate needs visual evidence. More transcript alone could not resolve it. If visual review is disabled, enable additional visual context in Settings. Recorded visual attempts show any remaining evidence or budget limits.</p>}
          {(coherence.visual_reviews ?? []).map((v, i) => <details key={`visual-${i}`}><summary className="cursor-pointer text-xs">Visual evidence review {i + 1}</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-2xs">{JSON.stringify(v, null, 2)}</pre></details>)}
          {coherence.attempts.map((a, i) => <details key={i}><summary className="cursor-pointer text-xs">{i + 1}. {a.stage.replaceAll('_', ' ')} · {a.decision.replaceAll('_', ' ')} · {a.reason.replaceAll('_', ' ')}</summary>
            <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-2xs">{JSON.stringify(a, null, 2)}</pre></details>)}
          {coherence.repairs.map((r, i) => <details key={i}><summary className="cursor-pointer text-xs">Boundary repair {r.repair_round ?? i + 1} · request {i + 1} · {r.status.replaceAll('_', ' ')} · {r.model}</summary>
            {r.status === 'truncated' && <p className="mt-2 text-xs text-amber-200">The model reached its output limit before completing the repair. This response was not used to change the clip.</p>}
            <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-2xs">{JSON.stringify(r, null, 2)}</pre></details>)}
        </section>}
        {candidate?.report && <details className="rounded-xl border border-white/10 p-3"><summary className="cursor-pointer text-sm">Additional recorded context, protection and quality checks</summary>
          <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify({ ...candidate.report, coherence: undefined }, null, 2)}</pre></details>}
        </div>
      </section>
    </div>
  </div>
}


export function InspectEditsButton({ outputDir }: { outputDir: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return <><Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Inspect transcript & edits</Button>{open && <EditInspector outputDir={outputDir} onClose={() => setOpen(false)} />}</>
}
