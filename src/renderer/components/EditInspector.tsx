import { useEffect, useMemo, useRef, useState } from 'react'
import { FileText, X } from 'lucide-react'
import type { EditAudit, SourceContextAudit } from '../../shared/editorial'
import { getApi } from '../lib/ipc'
import { errorMessage, formatTimecode } from '../lib/utils'
import { Dialog } from './ui/Dialog'
import { Button } from './ui/Button'
import { JsonViewer } from './ui/JsonViewer'
import { Segmented } from './ui/Segmented'
import { Callout } from './ui/Callout'
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
        const items = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), input, textarea, select, summary, [tabindex="0"]') ?? [])].filter(item => item.getClientRects().length > 0)
        if (e.shiftKey && (document.activeElement === items[0] || document.activeElement === panel.current)) { e.preventDefault(); items.at(-1)?.focus() }
        else if (!e.shiftKey && document.activeElement === items.at(-1)) { e.preventDefault(); items[0]?.focus() }
      }
    }
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('keydown', key); previous?.focus() }
  }, [onClose])
  return <Dialog ref={panel} aria-label="Inspect transcript and edits" panelClassName="h-[min(640px,80dvh)] max-w-[900px]" onBackdropMouseDown={onClose}>
    <header className="flex shrink-0 items-center gap-3 border-b border-white/[0.07] px-5 py-4">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5"><FileText className="h-4 w-4 text-ink-muted" /></div>
      <div className="min-w-0 flex-1"><h2 className="text-base font-semibold">Details</h2><p className="mt-0.5 truncate text-xs text-ink-muted" title={audit?.title}>{audit?.title || 'Saved transcript and decisions'}</p></div>
      <Button iconOnly variant="ghost" aria-label="Close edit inspector" icon={<X className="h-4 w-4" />} onClick={onClose} />
    </header>
    {error ? <div className="p-5"><Callout tone="danger">{error}</Callout></div> : audit ? <RecordedEditView key={outputDir} audit={audit} /> : <p role="status" className="p-8 text-center text-sm text-ink-muted">Loading saved transcript and decisions…</p>}
  </Dialog>
}

export function RecordedEditView({ audit }: { audit: EditAudit }): React.JSX.Element {
  const [selected, setSelected] = useState(0), [query, setQuery] = useState(''), [wholeSource, setWholeSource] = useState(false), [page, setPage] = useState(0)
  const [view, setView] = useState<'jev' | 'transcript' | 'run'>(audit.candidates.length === 0 ? 'transcript' : 'jev')
  const candidate = audit.candidates[selected]
  const coherence = candidate?.report?.coherence
  const accepted = coherence?.status === 'rejected' ? undefined : [...(coherence?.attempts ?? [])].reverse().find(a => a.decision === 'accept' && a.stage !== 'cut')
  const range = coherence?.accepted_interval ?? candidate?.original_interval
  const lines = useMemo(() => audit.transcript.filter(t => (!query || t.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())) &&
    (wholeSource || !range || (t.end_ms > range[0] - 30000 && t.start_ms < range[1] + 30000))), [audit, query, wholeSource, range])
  const scroll = useRef<HTMLDivElement>(null)
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="shrink-0 space-y-3 border-b border-white/[0.07] px-5 py-3">
      <Segmented label="Inspection view" value={view} onChange={value => { setView(value); scroll.current?.scrollTo({ top: 0 }) }}
        options={[{ value: 'jev', label: 'Jev review' }, { value: 'transcript', label: 'Transcript' }, { value: 'run', label: 'Run details' }]} />
      {view !== 'run' && audit.candidates.length > 0 && <select aria-label="Clip candidate" value={selected}
        onChange={e => { setSelected(Number(e.target.value)); setPage(0); scroll.current?.scrollTo({ top: 0 }) }}
        className="block w-full min-w-0 rounded-xl border border-white/10 bg-surface px-3 py-2 text-sm">
        {audit.candidates.map((c, i) => <option key={c.candidate_index} value={i}>Candidate {c.candidate_index + 1} · {c.title || 'Untitled'} · {c.status.replaceAll('_', ' ')}{c.clip_index != null ? ` · Clip ${c.clip_index + 1}` : ''}</option>)}
      </select>}
    </div>
    <div ref={scroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5" aria-label="Detail content">
      <div hidden={view !== 'run'} className="space-y-4">
        <div className="grid grid-cols-3 gap-3 rounded-xl border border-white/[0.07] bg-white/[0.025] p-4 text-sm">
          <div><p className="text-2xs text-ink-subtle">Outcome</p><p className="mt-1 capitalize">{audit.outcome === 'legacy_transcript_only' ? 'Transcript only' : audit.outcome.replaceAll('_', ' ')}</p></div>
          <div><p className="text-2xs text-ink-subtle">Candidates</p><p className="mt-1">{audit.candidates.length}</p></div>
          <div><p className="text-2xs text-ink-subtle">Rendered</p><p className="mt-1">{audit.candidates.filter(c => c.status === 'rendered').length}</p></div>
        </div>
        {audit.preferred_range.some(t => t != null) && <p className="text-xs text-ink-muted">Preferred range: {formatTimecode((audit.preferred_range[0] ?? 0) * 1000)}–{formatTimecode(audit.preferred_range[1] == null ? audit.duration_ms : audit.preferred_range[1] * 1000)}. Complete excerpts may extend beyond it.</p>}
        {audit.source_context && <SourceContextView context={audit.source_context} />}
        <details className="rounded-xl border border-white/10 p-3"><summary className="cursor-pointer text-sm">Planner requests & candidate discovery ({audit.planner.requests.length})</summary>
          <JsonViewer className="mt-3" label="Planner requests" value={{ ...audit.planner, second_discovery: audit.discovery }} /></details>
        <p className="text-xs leading-relaxed text-ink-subtle">Exact saved evidence, requests and answers. The rules explain acceptance and rejection; this is not hidden model reasoning. Opening this view makes no AI calls.</p>
      </div>
      <div hidden={view !== 'jev'}><JevTrace key={candidate?.candidate_index ?? 'empty'} trace={candidate?.report ?? null} /></div>
      <div hidden={view !== 'transcript'} className="space-y-4">
        {audit.outcome === 'legacy_transcript_only' && <Callout>This older run has a saved transcript but no edit decisions. It may cover only the previously selected range.</Callout>}
        <h3 className="text-sm font-semibold">Transcript context {range && `· ${formatTimecode(range[0])}–${formatTimecode(range[1])}`}</h3>
        {candidate && <p className="text-xs text-ink-muted">Original proposal: {formatTimecode(candidate.original_interval[0])}–{formatTimecode(candidate.original_interval[1])}. Green indicates retained speech in the last approved edit; amber indicates omitted speech. Unapproved candidates have no retained highlight.</p>}
        <div className="flex flex-wrap items-center gap-3 text-xs"><input aria-label="Search transcript" placeholder="Search transcript…" value={query} onChange={e => { setQuery(e.target.value); setPage(0) }} className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/20 px-3 py-2" />
          <label className="flex items-center gap-2"><input type="checkbox" className="accent-accent" checked={wholeSource} onChange={e => { setWholeSource(e.target.checked); setPage(0) }} />Full saved transcript</label></div>
        <div className="max-h-80 space-y-1 overflow-y-auto overscroll-contain rounded-xl border border-white/10 p-3" aria-label="Transcript passages">{lines.slice(page * 100, (page + 1) * 100).map((t, i) => {
          const kept = accepted?.keeps.some(([a, b]) => a < t.end_ms && b > t.start_ms)
          const inside = range && range[0] < t.end_ms && range[1] > t.start_ms
          return <p key={`${t.start_ms}:${i}`} className={`rounded p-2 text-sm ${kept ? 'bg-emerald-950/40' : inside && accepted ? 'bg-amber-950/40' : 'text-ink-muted'}`}><span className="mr-3 font-mono text-2xs">{formatTimecode(t.start_ms)}–{formatTimecode(t.end_ms)}</span>{t.speaker && <span className="mr-2 text-xs text-purple-300">{t.speaker}</span>}{t.text}</p>
        })}{lines.length === 0 && <p className="text-sm text-ink-muted">No matching transcript passages.</p>}</div>
        <div className="flex items-center gap-3 text-xs"><Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous passages</Button><span>{Math.min(page * 100 + 1, lines.length)}–{Math.min((page + 1) * 100, lines.length)} of {lines.length}</span><Button size="sm" variant="ghost" disabled={(page + 1) * 100 >= lines.length} onClick={() => setPage(page + 1)}>Next passages</Button></div>
        {candidate?.report?.moment && <details className="rounded-xl border border-white/10 p-3"><summary className="cursor-pointer text-sm">Proposed topic, setup and payoff</summary><JsonViewer className="mt-3" label="Proposed moment" value={candidate.report.moment} /></details>}
        {coherence && <section className="space-y-3 rounded-xl border border-white/10 p-3"><h3 className="text-sm font-semibold">Coherence decisions · {coherence.status}</h3>
          <p className="text-xs text-ink-muted">Self-contained must reach {(coherence.self_contained_threshold ?? coherence.threshold) * 100}%. Faithful to source must reach {(coherence.faithful_to_source_threshold ?? coherence.threshold) * 100}%. Title supported must reach {(coherence.title_supported_threshold ?? coherence.threshold) * 100}%. Other content checks must reach {coherence.threshold * 100}%. {coherence.sponsor_threshold != null && <>Confidence that the clip is not sponsored must reach {coherence.sponsor_threshold * 100}%. </>}Sufficient evidence must reach {(coherence.evidence_threshold ?? coherence.threshold) * 100}%. Individual removals require {coherence.cut_threshold * 100}%. Unknown removals are restored. Unverified clips are omitted.</p>
          {coherence.reason === 'sponsored_or_uncertain_promotion' && <p className="text-xs text-amber-200">Omitted because the segment was promotional or could not be confidently cleared of sponsorship. Sponsor disclosures are not trimmed to turn ads into clips.</p>}
          {coherence.reason === 'needs_visual_evidence' && <p className="text-xs text-amber-200">This candidate needs visual evidence. More transcript alone could not resolve it. If visual review is disabled, enable additional visual context in Settings. Recorded visual attempts show any remaining evidence or budget limits.</p>}
          {(coherence.visual_reviews ?? []).map((v, i) => <details key={`visual-${i}`}><summary className="cursor-pointer text-xs">Visual evidence review {i + 1}</summary><JsonViewer className="mt-3" label={`Visual review ${i + 1}`} value={v} /></details>)}
          {coherence.attempts.map((a, i) => <details key={i}><summary className="cursor-pointer text-xs">{i + 1}. {a.stage.replaceAll('_', ' ')} · {a.decision.replaceAll('_', ' ')} · {a.reason.replaceAll('_', ' ')}</summary>
            <JsonViewer className="mt-3" label={`Coherence attempt ${i + 1}`} value={a} /></details>)}
          {coherence.repairs.map((r, i) => <details key={i}><summary className="cursor-pointer text-xs">Boundary repair {r.repair_round ?? i + 1} · request {i + 1} · {r.status.replaceAll('_', ' ')} · {r.model}</summary>
            {r.status === 'truncated' && <p className="mt-2 text-xs text-amber-200">The model reached its output limit before completing the repair. This response was not used to change the clip.</p>}
            <JsonViewer className="mt-3" label={`Boundary repair ${i + 1}`} value={r} /></details>)}
        </section>}
        {candidate?.report && <details className="rounded-xl border border-white/10 p-3"><summary className="cursor-pointer text-sm">Additional recorded context, protection and quality checks</summary>
          <JsonViewer className="mt-3" label="Additional clip checks" value={{ ...candidate.report, coherence: undefined }} /></details>}
      </div>
    </div>
  </div>
}


export function InspectEditsButton({ outputDir }: { outputDir: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return <><Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Inspect transcript & edits</Button>{open && <EditInspector outputDir={outputDir} onClose={() => setOpen(false)} />}</>
}

function SourceContextView({ context }: { context: SourceContextAudit }): React.JSX.Element {
  const brief = context.brief
  return <details className="rounded-xl border border-white/10 p-3">
    <summary className="cursor-pointer text-sm">Source context · {context.research_status === 'completed' ? 'web research included' : 'metadata only'}</summary>
    <div className="mt-3 space-y-3 text-sm">
      <p className="text-xs text-ink-subtle">Prepared before transcription. This background guides discovery; the transcript and footage must support every clip.</p>
      <p><span className="text-ink-muted">Source:</span> {context.source.title} {(context.source.channel || context.source.uploader) && <> · {context.source.channel || context.source.uploader}</>}</p>
      {context.source.upload_date && <p className="text-xs text-ink-muted">Source upload date: {context.source.upload_date}</p>}
      {context.research_status === 'unavailable' && <p className="text-amber-200">Web research could not be verified. This run continued with metadata only.</p>}
      {!brief ? <p className="text-ink-muted">The context service was unavailable. The planner received the available source metadata.</p> : <>
        <p>{brief.summary}</p>
        <p><span className="font-medium">Channel overview:</span> {brief.channel_summary}</p>
        <p><span className="font-medium">Likely video format:</span> {brief.format}</p>
        {([['Topics', brief.topics], ['Perspectives to distinguish', brief.perspectives], ['What to look for', brief.clip_guidance], ['Uncertainties', brief.uncertainties]] as const).map(([label, items]) => items.length > 0 && <div key={label}>
          <p className="font-medium">{label}</p><ul className="mt-1 list-disc space-y-1 pl-5 text-ink-muted">{items.map((item, i) => <li key={i}>{item}</li>)}</ul>
        </div>)}
        {brief.background.length > 0 && <div><p className="font-medium">Researched background</p><ul className="mt-1 list-disc space-y-1 pl-5 text-ink-muted">{brief.background.map((item, i) => <li key={i}>{item.claim}<span className="block break-all text-xs">{item.url}</span></li>)}</ul></div>}
        {brief.vocabulary.length > 0 && <p className="text-xs text-ink-muted">Transcription hints from metadata: {brief.vocabulary.join(', ')}</p>}
      </>}
      {context.citations.length > 0 && <div><p className="font-medium">Research sources</p><ul className="mt-1 space-y-2">{context.citations.map(source => <li key={source.url} className="text-xs"><button className="text-left text-accent hover:underline" onClick={() => void getApi().shell.openPath(source.url)}>{source.title}</button><span className="block break-all text-ink-muted">{source.url}</span></li>)}</ul></div>}
      <p className="text-xs text-ink-subtle">{context.requests.map(r => r.model).filter((m, i, all) => all.indexOf(m) === i).join(', ')} · Recorded {new Date(context.created_at).toLocaleString()}</p>
    </div>
  </details>
}
